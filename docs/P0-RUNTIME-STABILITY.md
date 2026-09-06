# P0：运行稳态、版本与诊断

2026-09-06。本轮为源码和回归用例交付；没有提交、部署、调用真实模型或迁移数据。Windows PowerShell 执行被拒绝，Docker daemon 不可达，因此本文不引用旧版本测试数作为本轮结果。

## 发布基线与边界

最新 [联合发布记录](../deployment/RELEASE-20260906-WS-POSTGRES.md) 已补齐生产结果，不再是“发布进行中”。按该记录：Harness 运行时及工作台 `efe56eb9926d200fa952145b483b61e629c51b25`，主平台后端及官网前端 `11f750738b5415b8d0f10c2307b337fe65e09fd1`，PostgreSQL 已切换并通过数量及内容核对，公开问答与 WebSocket 回放已验收。私人赛事账号验收及独立备份恢复演练未记录完成。

本次只读取发布记录，未独立登录服务器复验。机器可读基线在 [release-state.json](../deployment/release-state.json)，明确区分 reported evidence、待运行的 P0 候选及未验证事项。运行时版本接口读取部署包旁的 `release.json`，绝不运行 git 或把本地 HEAD 作为线上版本。该 JSON 是受审阅的发布记录，不是自动探测全平台版本的仪表盘；发布后需更新四个产物版本及证据。

## 已改：流式文本持久化

`AgentEngine → TextDeltaBuffer.push() → emit() → events.append()`。

- 每个模型 contentBlock 独立缓冲。首段立即持久化；其后按 100ms 或 2KiB UTF-8 上限合并，不按每个供应商碎片写一次数据库。等待写入形成反压，不无限排队。
- UTF-8 字节分段不拆完整 Unicode 字符；供应商将代理对拆到两个回调时先保留半字符。文本完成后逐字一致，不做重写摘要。
- 模型完整结果校验通过后 `finish()` 排空；之后才允许派发工具或写成功终态。
- 取消、超时、记忆失效或异常会丢弃尚未保存的正文，保留已持久化的部分。`discard()` 等待已开始写入结束，避免终态后出现迟到正文。部分正文不能当成完整成功结果。
- 定时器保存失败进入执行失败，不产生未处理 Promise 或泄露原始数据库错误。WebSocket 仍在事务提交后推送，100ms 是合并窗口，不是端到端延迟承诺。

## 已改：会话容量与完整回放

公共规则在 `server-cloud/src/history-policy.ts`，SQLite 与 PostgreSQL 同步使用。

| 约束 | 当前源码默认值 |
| --- | --- |
| 新 Run 接入时最大回合数 | 100 |
| 新 Run 接入时历史字节上限 | 16MiB |
| 新 Run 接入时事件数量保护 | 16,000 |
| 引擎完整历史读取保护 | 24,000 条 / 32MiB |
| HTTP 单页 | 最多 200 条，同时最多约 512KiB（含预留封装） |
| 浏览器 HTTP 回放页数保护 | 256 |

接入上限与单轮执行中的增长不是同一约束，读取上限留有余量；达到上限不删除历史。历史容量过大或事件序号缺口会明确报错，不把不完整历史交给模型。请求幂等查找在容量检查前，重试已受理请求不会因为新上限而重跑。

原 `bindRun().events.read()` 固定前 1,200 条的行为已改为完整分页读取，保留最新工具结果和终态。按字节截断的 HTTP 页即使不足 200 条也返回 `hasMore=true`。React 工作台与官网嵌入读取页数同步调整，保留连续序号去重。该方案不等于无限长上下文：模型上下文仍由独立字符/消息预算装配。

## 已改：系统提示词单次装配

`agent-core/model-wire.ts::wireMessages()` 供本地 `DaoyinGatewayModelClient` 及云端平台适配器使用。结构化 `systemPrompt.stableText/dynamicText` 保留；只移除完全等价的 system 镜像，用户、工具、助手消息不变。回车换行和首尾空白作规范化，不使用子串规则删除独立指令。

主平台 `harness_prompt_contract.compose_system_prompt()` 兼容旧客户端的重复 system 镜像；`_provider_messages()` 统一调用它。上下文预算不再双算同一稳定/动态正文。传输去重不变更工具结果、权限或费用账本。模型实际节省的 Token/费用仍需同任务测量，本轮没有收益数字。

## 已改：健康、版本与诊断接口

| Harness 接口 | 返回与访问范围 |
| --- | --- |
| `GET /health/live` | 进程能响应；不调用数据库、平台或模型 |
| `GET /health/ready` | 就绪 200 / 未就绪 503；仅返回状态 |
| `GET /api/v1/cloud/runtime` | 原认证下读取构建 revision/builtAt、协议版本、预期 schema 契约和单实例边界 |
| `GET /api/v1/cloud/runs/:runId/diagnostics` | 原账号/空间/应用作用域下读取该 Run 的脱敏时序 |

旧 `/health` 兼容保留。就绪检查使用单飞和短缓存，4 秒等待边界；异常依赖不响应取消时不并发复制隐藏探针。PostgreSQL 检查必需表、事件/Run 列、非只读状态、主要表权限和当前租约，然后调用主平台已认证的内部 `/health` 读探针。主平台探针只检查桥接表能否读取，不创建访客/授权/任务、不检索、不调用供应商。

就绪不意味着供应商配额、企业订阅、全部业务表或备份已验证；SQL 读探针及权限检查也不等于磁盘写入成功的实测。发布版本未知返回 null，不猜版本。完整数据库迁移版本账本/自动跨产物版本汇总尚未完成，`expectedSchema=cloud-v1` 明确只是运行时预期契约。

主平台同源桥增加 `/runtime` 和 `/runs/:runId/diagnostics`，分别位于官网 `/api/company-assistant/agent` 与赛事 `/api/agent-apps/saishi/workbench`，沿用 Cookie、账号边界和服务间鉴权。

诊断默认不返回问题、回答、工具参数、记忆正文、密钥或原始异常。持久事件提供首段落库耗时、总记录耗时、工具开始/结束和未完成调用数。当前进程补充模型调用、工具执行、事件保存的次数、失败次数、总时长、最大时长；只保留最多 256 个 Run，30 分钟后读取为 unavailable。耗时包含嵌套调用，不能相加当总耗时；重启后内存指标不伪造为零。浏览器渲染延迟、供应商首 Token、实际结算、分布式 tracing 仍是未测项，暂不添加冗余管理 UI。

## 验证状态

新增五个测试文件：`text-delta-buffer.test.ts`、`p0-core.test.ts`、`p0-cloud.test.ts`、`runtime-health.test.ts`、主平台 `test_harness_p0.py`；扩展已有 PostgreSQL 专项用例。测试分别使用真实内核/SQLite/Fastify、模拟模型与平台；PostgreSQL 专项需要隔离测试数据库，不能误指生产连接。

本轮 PowerShell 绝对路径执行返回 Permission denied；Docker 无法连接 daemon。尚未执行上述测试、typecheck、lint、build 或真实浏览器验收。静态格式审阅结果另记于交付回复，不是运行测试通过。

Windows Harness 根目录：

```powershell
npm run typecheck
npm run lint
npm test
npm run build
node scripts/verify-cloud-websocket.mjs
```

使用现有 Windows/Docker 隔离 PostgreSQL 测试流程配置 `DAOYIN_TEST_POSTGRES_URL` 后执行 `packages/server-cloud/src/postgres-repository.test.ts`。主平台使用项目 `docker-compose-agent-test.yml` 运行 `tests/test_harness_p0.py` 并回归官网/赛事授权、模型流式测试；官网前端运行原 `companyAgent` 测试并构建。

## P0 仍未关闭的验收项

1. 新候选的 Windows/Docker/PG/浏览器验证和同任务成本、延迟对比。
2. 经授权执行的生产构建发布，先发布主平台兼容探针和提示词规则，再发布运行时，确认读就绪与真实任务结果。不能拿健康探针代替真实业务验收。
3. 备份恢复演练：在隔离数据库恢复受保护备份，核对 schema、行数、关键内容及脱敏数据保留策略；禁止测试进程对真实供应商继续执行待处理任务。
4. 同步校验四份产物版本、生产数据库 schema 与回滚候选兼容性；接收新写入后不得直接切回旧 SQLite。

## 继续验收：统一 Windows 入口

执行入口为 `node scripts/verify-p0.mjs`，必须在 Windows PowerShell、仓库固定 Node 版本和本机 Docker Desktop（Linux containers）下运行。需要 Harness 与相邻 `DaoyinTechnology/frontend` 已安装 Windows 锁定依赖；脚本不修改依赖安装、不操作 Git、不部署、不接受生产数据库 URL。

该脚本按顺序执行 Harness typecheck/lint/test/build、隔离 PostgreSQL 专项、测试数据备份恢复、主平台项目 Docker 回归、官网测试与构建、WebSocket 及账号浏览器回归。它给本次临时容器和网络使用唯一名称，复用主平台原测试 Compose 但覆盖固定容器名以避免碰撞；不会停止现有开发或生产服务。

报告输出到忽略的 `.cache/p0-validation/<runId>/report.json`。每阶段只有实际退出成功后才记 passed；未走到的阶段不伪造为成功。验证前后对两仓库相关源码计算指纹，期间发生并发修改则候选无效，防止把一份代码的测试结果用于另一份代码。`passed-local-validation-only` 不表示允许跳过发布产物核对。

`verify-p0-restore.mjs` 只能连接主脚本创建、带本轮标签且端口匹配的临时 PostgreSQL。它创建完成/待恢复 Run 及已确认记忆，使用 pg_dump 备份到容器内部，再用 pg_restore 恢复到另一空测试库，逐表比较数量和内容哈希，之后检查中断标记与幂等结果。报告明确标注 fixture-only；这不是服务器生产备份的恢复验收，不接收或下载用户生产数据。

本次续办再次尝试 Windows PowerShell，返回 Permission denied；Docker daemon 仍不可达。因此新增验证脚本及这些回归用例尚未在本轮运行，不能填入通过数量，也没有进行生产切换。

续办源码审阅另外修复两项诊断语义：`ToolFailure` 正常返回也计入工具失败数，而不是只有抛异常才计失败；诊断读取按捕获的 Run 事件游标取证，避免并发完成时混合“旧 running 状态＋新完成事件”。已在现有测试中增加用例。它们同样等待 Windows 运行验证。

参考决策：[ADR-0016](adr/0016-p0-runtime-stability.md)。
