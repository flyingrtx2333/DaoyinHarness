# Harness 测试评估工作台

2026-09-06：源码、权限接口、独立评估执行器和回归用例已接线。本轮未执行 Windows 编译/测试、浏览器验证、真实模型评测或部署；不能把本文件视为生产验收。

## 入口与用户操作

云端工作台「插件」下分为「插件目录」和「测试评估」。也可使用 `/harness/#plugins-evaluation` 定位页面，但 URL 不授予权限。普通账号和企业管理员看不到测试标签；直接访问会显示拒绝，所有后端读写接口同样拒绝。

超级管理员粘贴最多50行脱敏用户输入，点击「整理用例」；逐题选择场景、编辑成功条件、确认适用性，再选择回放或真实模型、每题1–5次重复、单题调用上限后开始。规则匹配只是生成草稿，不会默默修改真实用户输入、确认标准或调用模型。依赖前文的“第二个”“继续”等多轮问题目前不能独立自动重建环境。

结果页按题目汇总重复试验，展开显示任务执行状态、验收判定、实际回复、逐条核验、工具状态、记忆引用、耗时和用量；原始实验配置和评分结果保留，可分页查看历史及导出JSON。网页关闭不取消实验；显式停止才阻止后续执行。失去账号/管理员身份时页面清空敏感结果，服务不再批准后续模型调用。

## 权限不是一个前端开关

主平台 `backend/routes/harness_evaluation.py` 查询 users、tenant_members、tenants、tenant_member_roles、roles 的有效记录，要求 `roles.tenant_id=0 AND roles.role_key='admin'`。这是当前平台创建超级管理员所用的全局角色；不使用用户名、用户ID=1、客户端is_super_admin或较宽的tenant.manage判断。该查询未创建新角色，不会把普通企业管理员提升为超级管理员。

身份来自已有 HttpOnly `daoyin_account_session` Cookie。GET也要核对绑定账号会话的指纹，POST进一步检查Origin/CSRF。创建、历史、单题、报告和取消全部重新核对；主平台返回结果前再次验证会话与全局管理员角色。后台向独立执行器发送的是服务端解析的操作者ID和会话ID，不采信浏览器自报身份。执行器还向主平台内部接口逐次确认有效管理员，不将服务Token当作用户身份。

服务凭据、模型Key和模型endpoint从受保护的服务配置提供，浏览器不能指定它们，也不能传命令、SQL、脚本、生产数据库地址或任意工具。传输错误只返回安全代码，不输出上游原始错误。模型回复用现有Markdown组件显示，禁用HTML与自动加载远程图片。

## 两种执行方式的证据边界

| 模式 | 实际运行 | 能说明什么 |
| --- | --- | --- |
| 程序回放 | 真createCloudServer、AgentEngine、工具注册/权限、事件/记忆仓储；模型返回是脚本，业务查询是合成夹具 | 协议、工具循环、分页证据、记忆引用等是否工作；不说明真实模型智能 |
| 真实模型＋隔离数据 | 相同内核和云端受理逻辑，真实专用模型现场决策；业务I/O仍为隔离夹具 | 该内核配置下的工具决策、材料覆盖、记忆召回/使用、回答是否满足条件 |

当前独立评估入口不是线上整套系统的完整端到端测试：没有覆盖生产Cookie→主平台模型桥→Saishi真实业务数据库→浏览器WebSocket链路。真实模型模式的专用模型客户端是非流式HTTP JSON，与生产NDJSON/供应商流式桥不同；不能用它的分数宣称截图中的生产第二次模型调用错误已修复。后续需要独立 staging 全链适配器，而不是让超级管理员在页面粘贴任意生产endpoint。

首段时间是运行器观察到已保存正文的时点，含约30ms观测间隔；不是供应商TTFT或浏览器渲染延迟。单次120秒截止、模型单请求60秒；外部请求结果未知不自动重发。

## 首版场景和判分

1. 赛事素材状态：一场可查赛事、40条合成素材（30完成、7处理中、3失败）；使用正式createSaishiProfile的参数/返回校验，业务查询本身为夹具。硬性检查素材ID覆盖40/40及越界尝试，再由独立语义调用核对状态表达。没有调用正式Saishi数据库，不伪造数据库行状态证明。
2. 最新记忆：真实SqliteMemoryRepository创建/确认旧偏好与修正后的新偏好，设置另一用户干扰项；真正读取云端memory.prepare/references。检查新版本已进入上下文、旧值/他人引用不存在，随后核对回答。它不包含模型自动记忆提取或跨应用授权验收。
3. 自由探索：无生产业务能力。没有标准时直接待复核；填写条件后可以进行语义判分，但缺少独立业务核对器时仍不将结果标为已验证业务成功。

验收条件在执行前冻结，只交给评分器；不会把期望答案放进Agent系统提示。硬性检查失败立即不通过，不使用语义分抵消。语义判分按要求逐项返回true/false/null；缺项、非法JSON为判分失败；声称通过却无法引用原回答中的原文证据则待复核。模型评委尚未通过人工标注集校准，因此判分为模型辅助证据，不是绝对真值。

回放结果显示「协议检查通过率」，真实模型成功率字段为null。真实模式的已验证成功数除以全部计划试验数，未知/未执行不隐藏；重复全通过比例仅计算同题所有计划重复均通过的题。记忆召回只在已测记忆场景报告样本数与0/1覆盖，未测显示未测；不是整个知识库Recall@K。

## 执行、持久化和预算

`evaluation/service.ts → runTrial() → createCloudServer() → AgentEngine → fixture/provider → 独立判分 → EvaluationStore.append()`。

独立SQLite文件保存：

| 表 | 内容 |
| --- | --- |
| evaluation_runs | 操作者、原账号会话关联、requestId、配置摘要、冻结配置、实验状态、已完成逐次结果 |
| evaluation_calls | 调用前预留的顺序号、Agent/判分类型和时间；失败或未知仍占用上限 |
| evaluation_lease | 单实例执行租约，防止两进程同时执行收费实验 |

每一次试验使用新建的内存CloudRepository，用户、会话、记忆和工具数据不进入线上cloud_*或真实赛事库。实验主体以独立JSON记录保留结果，不暴露生产原始数据。当前保存的是有界结果和工具摘要，不是完整逐Token取证包；事故回放和完整轨迹导出另行扩展。

`actorId + requestId`唯一且绑定配置；重复请求返回原实验，正文不同报冲突。浏览器sessionStorage只留请求ID/配置摘要和所选实验ID，不留输入/回答或访问凭据。网络响应不确定时点击恢复原实验；不会自动换ID再付费。重新加载后可通过历史查找原记录；原请求还没有受理时必须重建同样配置才能用原ID再提交。

执行调用预算包含每试验maxModelCalls加最多一次判分，真实模式还必须confirmPaid。**调用次数预算不是金额硬上限**。输入和响应有字节边界，单次最多2048输出Token，缺失供应商usage时显示未记录，不按0计；财务金额暂不计算。保留的调用账本是预留/尝试次数，不能把中断前最后一条记录解释为供应商一定收到并扣费。

重启时将遗留活动实验标记interrupted，不自动恢复付费执行。原已完成样本保留，报告标记证据不完整。管理员身份撤销后不再发新模型请求，但已经发送的供应商请求不承诺退款。服务按单实例运行，不是多Worker评估集群。

## 启动与部署配置（本轮未执行）

共享源码编译后可执行 `packages/server-cloud/dist/evaluation/main.js`，但开发编译目录缺少发布清单时revision为null。正式`build-cloud-release.mjs`从Git提交构建额外`evaluation.mjs`并记录哈希；正常`main.mjs`不启动评估服务。将评估入口使用独立OS用户、独立环境文件和独立数据目录运行，不能复用生产Harness数据库环境或生产API/COS/业务凭据。

主平台配置：`HARNESS_EVALUATION_SERVICE_URL`、`HARNESS_EVALUATION_SERVICE_TOKEN`、`HARNESS_EVALUATION_ORIGIN`。

执行器配置：`DAOYIN_EVAL_DB`（绝对路径，仅评估库）、`DAOYIN_EVAL_SERVICE_TOKEN`（与主平台一致）、`DAOYIN_EVAL_PLATFORM_URL`（主平台HTTPS origin）、`DAOYIN_EVAL_PORT`（默认4711）。开启live还需`DAOYIN_EVAL_MODEL_ENDPOINT`（HTTPS完整chat/completions地址）、`DAOYIN_EVAL_MODEL_KEY`、`DAOYIN_EVAL_MODEL`，可独立设置`DAOYIN_EVAL_JUDGE_MODEL`。

先部署执行器和主平台代理，再更新Harness工作台。执行器默认只监听127.0.0.1；主平台在Docker内时不能使用容器自己的127.0.0.1访问宿主机。可经已有HTTPS网关的固定`/api/internal/harness-evaluation-runner`前缀代理至宿主机4711；见部署示例。不要把Docker socket、生产工作目录或生产数据库凭据交给评估器。

配置缺失时入口校验或catalog会拒绝，不伪装“真实模型可用”。当前已有Builder评测后台不受修改，Harness独立增加标签和执行适配，没有调用Builder的Agent替代Harness。

## 验证

新增 `evaluation/evaluation.test.ts`、`evaluation/provider.test.ts`、`ui/src/cloud/evaluation-client.test.ts` 与主平台 `tests/test_harness_evaluation.py`。覆盖实际共享内核回放、真实记忆引用、未配置模型拒绝、伪造身份/越权、幂等、取消/重启、评委缺证据、旧账号回包隔离。模型HTTP和身份/业务I/O的模拟边界在文件内注明。

Windows环境：

```powershell
npm run typecheck
npm run lint
npm test
npm run build
node scripts/verify-evaluation-workbench.mjs
```

主平台使用自己的项目Docker测试环境运行`tests/test_harness_evaluation.py`，不能系统安装依赖。浏览器脚本使用真实编译UI加模拟主平台API，检查非管理员隐藏/直达拒绝、用例确认、结果展开、320/390/1280宽度、撤权清空；不会进行真实管理员登录或模型消费。

本轮PowerShell返回Permission denied，Docker daemon不可达，所以测试和浏览器脚本均未运行。需要实际配置并验收真实超级管理员、普通用户、企业管理员三类账号，以及BFF到评估器的网络可达性；仅有源代码不代表已经上线。
