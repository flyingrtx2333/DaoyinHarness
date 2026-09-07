# 长期记忆：Agent 自主维护、作用域与版本

> 2026-09-07 后续测试规则已更新：禁止新增或执行模拟/回放测试，需要测试时仅做小样本真实模型验证。本文的既往测试数量只作历史记录，不再作为验收门槛；当前仍未完成真实模型验收。以 [测试规范](TESTING.md) 和根目录 AGENTS.md 为准。

更新：2026-09-07。云端自主记忆已接入源码和现有单实例 Agent 循环，验证见 [本轮验证](VALIDATION-20260907-MEMORY.md)，决策见 [ADR-0018](adr/0018-autonomous-cloud-memory.md)。这不是上线记录：本轮没有提交或部署，没有修改主平台权限签发、生产服务或用户数据库。

## 1. 消息、任务状态与长期记忆不是同一个对象

原始用户消息先随 `acceptRun()` 保存，由现有 `startRun()` 启动执行。会话事件、工具结果和任务终态继续持久化。只有有跨会话价值的偏好、事实、目标、决策或经验才进入长期记忆；本次任务参数、进度和临时计划不应被自动固化为长期事实。

本地端仍通过 `JsonlMemoryStore` 和 `memory_search / memory_remember / memory_update / memory_forget` 维护 `<dataDir>/memory/memories.jsonl`。本轮不改本地 JSONL 数据，不做跨设备同步或本地账号到企业资料的映射。

云端正式启动入口 `packages/server-cloud/src/main.ts` 使用 PostgreSQL；SQLite 实现继续承担单实例测试和兼容用途。两者实现同一记忆存储契约。云端业务工具和本地记忆工具不是同一存储，也不能因名称相同就混用。

## 2. 云端时序

```text
用户消息 → 认证和请求幂等 → acceptRun() 保存 → startRun()
  → createCloudMemoryRuntime() 绑定本轮身份、事件与记忆工具
  → 推理前自动加载少量通用偏好和相关记忆
  → 通过原有 AI 网关调用模型
  → Agent 按任务需要选择：不操作 / 搜索 / 新增 / 更正 / 忘记 / 业务工具
  → 后端校验来源、权限、版本、幂等，执行并记录结果
  → 必要时刷新记忆上下文，由 Agent 继续原任务
  → 保存最终回答和任务终态
```

没有引入消息队列、多 Worker、额外记忆模型、轮后提取器或后台任务。自动维护来自现有主 Agent 的工具选择；自动读取由运行时完成，不要求每轮先调用一次搜索工具。

## 3. Agent 写入路径

`packages/server-cloud/src/memory-tools.ts` 中的 `createCloudMemoryRuntime()` 注册四个本轮绑定的工具：

| 工具 | 行为 |
| --- | --- |
| `memory_search` | 查询当前可访问的有效记忆，返回内容、稳定 key、id、revision、范围和来源类别 |
| `memory_remember` | 自主新增有来源的普通记忆，校验通过后事务性写入 active，不经过人工确认接口 |
| `memory_update` | 使用旧 id/revision 更正原稳定 key，保留范围，事务性替代旧版本并撤销其共享 |
| `memory_forget` | 按 id/revision 清空同稳定 key 的版本链正文和关键词，停止召回并撤销共享 |

普通写入走 `SqliteMemoryRepository.remember()` / `PostgresMemoryRepository.remember()`，遗忘走 `forgetByAgent()`，不是偷偷调用 `confirm()`。首次自主写入的 revision 为 1；旧的人工候选确认流程仍保留自己的 revision 变化规则，不应在调用方硬编码“有效记录都是版本 2”。

模型提供内容、稳定 key、类型、范围及一小段来源原文。身份、请求幂等标识、会话和消息事件标识由可信运行时产生，不接受模型自填用户、企业或确认票据。

### 来源与真实性

`basis=user_statement` 必须匹配本轮真实 `turn.started` 用户消息中的原文；`basis=tool_observation` 必须匹配本轮已经完成的非记忆工具结果。存储层复查来源事件和记忆工具调用事件属于同一完整执行空间及运行中的任务，并核验事件先后顺序。外部网页/工具中的文字仍不是系统指令，也不因为被保存就获得更高权限。

记录明确标记 `source.kind=agent`，并保存 basis、关联事件标识和原文哈希；不在来源字段额外复制引用正文。工具调用审计也不复制记忆参数或来源原文。用户和工具的原始记录仍按原有事件策略保留。

来源关联只证明“引用确实存在”，不能证明模型改写完全正确、具有长期价值或真实反映用户意图。不要把 Agent 自主保存伪装为用户逐条确认；语义准确率需要另做真实模型评估。

### 幂等、冲突与遗忘

工具写入 requestId 由本轮 Run 与 toolCallId 稳定派生。相同请求相同内容返回原记录；改变相同请求的内容会冲突。API 层重复投递返回原 Run，不再次执行。新稳定 key 的重复有效内容会去重；已有同 key 的不同内容必须走版本更正，不自动覆盖。

自动写入不会激活已有的待确认候选，也不会复活已经 forgotten 的同 key。原请求重试仍返回原记录状态；如需用户明确重新保存一个已忘记的 key，目前可走现有新的管理候选和确认流程，专门的聊天恢复授权尚未实现。不同 key 的语义去重、冲突裁决以及全局“禁止再次推断该主题”不是本轮完成项。

凭据格式检查同时覆盖正文、key 和关键词，但正则检测不是完整的数据泄漏防护系统。所有自动工具仍受普通工具数量、步骤、时间和上下文预算限制。

## 4. 自动读取与补查

每个推理步骤由共享引擎调用 `memory.load()`。存储先筛选身份、空间、拥有者、应用或有效共享许可，然后排除未确认、过期、撤销和被替代的记录，再做确定性词项排序。没有 embedding 或额外模型调用。

普通自动召回最多 6 条，序列化记录总长不超过 8,000 字符；字符预算不等于 token 预算。少量 `preference` 类型、非 organization 范围的沟通偏好可默认带入，稳定 key 为 `profile.response.style / profile.response.language`，兼容 `response.style / response.language`，每次最多两条。其他记忆按查询相关性召回，不全部常驻。

“继续 / 接着 / 按之前的 / 按之前那个方案 / continue”等有限追问使用前一条用户问题辅助检索；这不是通用对话查询重写，也不改变当前用户消息。更复杂的指代由 Agent 主动 `memory_search` 补查。

显式搜索最多请求 12 条，返回记录总长限制 12,000 字符。实际返回的版本会先登记本轮依赖，再交给模型，避免只有自动召回有撤销保护、主动搜索结果没有保护。

模型上下文标记为 `UNTRUSTED_REFERENCE_MEMORIES`。内容是参考资料，不是系统指令、权限或实时业务状态；当前用户明确更正优先。引用回执仅证明内容准备进入上下文，不证明模型实际采用，也不能当成真实记忆采用率指标。

## 5. 自主更新后的安全继续

旧实现把当前回合引用的任何版本变化都当作外部撤销，会在 Agent 自己更正记忆后中断。现在使用存储层返回、只在当前 Run 闭包内持有的版本切换回执；模型不能传入、伪造这类回执。

`AgentMemoryProvider.afterTool()` 在本轮自身写入后准备新快照。引擎保留原始用户目标以及不含旧正文的工具执行回执，从模型视图移除本轮较早的推理、旧工具正文与待执行参数，按新记忆继续决策。同一模型批次中尚未发出的工具记录 `TOOL_DEFERRED_MEMORY_REFRESH` 和 `execution=not_started`，不能谎报已执行；已经完成的业务操作不能因刷新而重做。

只有数据库当前状态及版本与本轮回执严格一致的已替代/遗忘引用可以退出当前依赖集合。别的用户管理操作、另一个回合的更改、权限或共享撤销依然按原规则阻止后续输出和工具操作。原有审计和历史引用不删除。

这是保守刷新方案：旧工具正文被隔离后，必要的业务数据可能需要重新读取，但不能重新执行已有成功写操作。保留不依赖旧记忆的细粒度上下文、依赖感知摘要和低开销批量复查可后续优化。

## 6. 权限与平台适配

工具只在非 public 身份上挂载，并要求真实执行身份的 `allowedTools` 和权限允许：搜索需要 `memory.read`，写入还需 `memory.write`，organization 记录还遵守原有企业级读写权限。不会因 Agent 自主判断就提升账号权限，也不增加用户逐条审批普通记忆的步骤。

主平台必须实际签发账号已有权限和对应工具委托。本轮只改 Harness，不伪造签发结果；缺少委托时工具不出现，不能宣称线上已自动可用。Saishi profile 现在认识已委托的内核记忆描述，原模型适配器可校验其返回；实际执行由 Harness 本轮适配器完成，不代理到赛事业务 `call` 接口。业务只读限制并未被记忆写权限解除。

跨应用访问目前仍沿用仓储中的逐版本共享条件。根据 ADR-0012，同账号已有业务权限的自动跨应用访问不应额外要求逐条插件审批，但主平台联调和旧共享策略迁移不在本轮中。不同账号、不同企业，以及个人/企业空间不得混用；部门/资源级 ACL 尚未补齐。

## 7. 管理接口仍保留

`/api/v1/cloud/memories` 下的 capabilities、list、search、get、propose、confirm、reject、forget、shares、audit 和 Run 引用回执接口继续存在。它们为用户查看、纠正、撤销、手工录入提供能力，不再是 Agent 普通新增记忆的必经入口。

管理 API 的手工候选仍是 `pending → confirm → active`，不得向候选正文注入伪造的 agent 来源。前端管理页面、同源 BFF 的接入和真实账号权限联调仍需独立完成；内部服务凭据不能交给浏览器。

“忘记”不是原始聊天、SQLite WAL、PostgreSQL 历史物理页、模型供应商日志或备份的物理擦除。启用云端记忆的会话继续避开没有依赖版本的旧压缩摘要，按有效事件和总预算组装历史。

## 8. 代码导航与验证

入口：`packages/server-cloud/src/app.ts`。工具和本轮上下文：`memory-tools.ts`。独立策略和提示：`memory-agent-policy.ts`。持久化：`memory-repository.ts`、`postgres-memory-repository.ts`。SQLite 上下文：`memory-runtime.ts`。共享循环及预算：`packages/agent-core/src/agent-engine.ts`、`memory-context.ts`、`context-budget.ts`。

本轮新增 22 项相关测试：`memory-autonomy.test.ts` 的 19 项、`memory-platform.test.ts` 的 2 项，以及 `postgres-repository.test.ts` 的 1 项自主记忆事务测试。当前服务器的全仓 399 项测试包含 8 项真实隔离 PostgreSQL 测试，全部通过；类型检查、lint 和构建结果详见 [验证记录](VALIDATION-20260907-MEMORY.md)。这些是独立 Linux 服务器副本的验证，不是 Windows 共享工作区验收、真实模型效果评估或生产上线验收。
