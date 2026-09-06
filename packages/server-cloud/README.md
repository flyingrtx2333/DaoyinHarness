# 道引共享 Agent 云端基础

状态：共享内核与主平台官网桥已完成 Windows 自动化验证，并部署为官网单实例只读服务。真实模型、公开检索与取消接口已验收。配置、接口和当前结果见 [统一平台说明](../../docs/UNIFIED-AGENT.md) 与 [上线记录](../../deployment/RELEASE-20260905.md)。

2026-09-06 内核可靠性改造已通过 Windows 全仓类型检查、lint、293 项测试与构建，详见 [当前验证记录](../../docs/VALIDATION-20260906.md)。运行时已发布 `843bdb5`，生产备份、租约、真实公开问答与取消验收见 [上线记录](../../deployment/RELEASE-20260906-ACCOUNT-ACCESS.md)。改动与参数见 [内核可靠性改造](../../docs/ENGINE-RELIABILITY.md)。

## 范围

`createCloudServer` 创建 Fastify 服务实例，直接使用 `@daoyin/harness-agent-core` 的 `AgentEngine`，不另写一套模型循环。不自动监听端口，不加载本地文件、进程、浏览器或任意 MCP 工具，不改变现有 CLI、本地 Web UI 和 OAuth 启动方式。

必须由服务器代码提供以下适配器，缺失时不能创建服务：

- `authenticate`：验证 Bearer，解析当前用户、个人或企业空间、应用安装实例、付款账户和授权期限。
- `isAuthorizationActive`：检查授权撤销、成员关系及应用权益。每个请求、模型调用和工具操作都要复查。
- `resolveProfile`：由可信安装配置解析版本化规则与显式只读业务工具；浏览器不能指定工具清单、身份或系统提示词。
- `createModel`：创建与本次身份和 Run 绑定的模型网关客户端。记录付款账户不是实际扣费，本包不实现余额冻结与结算。
- `repository`：持久化会话、Run、事件和压缩摘要。

`createPlatformAdapters` 通过固定平台地址提供认证、复查、Profile 和单步模型适配；`createPlatformCloudServer` 将其接入服务工厂。`createCompanyPublicProfile` 调用真实主平台公开知识检索接口。主平台已经实现访客签发、操作账本与浏览器代理，官网已切换至新链路。Story 查询和付费业务工具仍待实现，测试替身不能作为部署配置。详见 [ADR-0008](../../docs/adr/0008-platform-public-bridge.md)。

## 身份和授权

会话固定绑定 `actorUserId + space.kind + space.id + ownerUserId/tenantId + appInstallationId`。相同账号切换企业或应用，不自动获得原会话访问权。付款账户和授权 ID 记录在 Run 上，不用于合并会话。请求正文禁止自带身份字段。

工具先经过发现过滤，执行时再校验授权、输入 Schema 和目标资源。每个 `CloudToolBinding` 都必须提供 `validateInput`、非空 `requiredPermissions` 和 `authorizeResource`。服务工厂只接受 `extension` 分类的只读工具；这不替代适配器对实际 HTTP 目标、返回内容和资源所有权的校验。

`contracts` 包中的记忆作用域和分享授权目前只是契约，不是已运行的跨业务记忆服务。不会读取、同步或合并本地历史。

## 接口

所有 `/api/v1/cloud/*` 请求需要有效 Bearer；浏览器请求的 Origin 必须在服务器配置的 `allowedOrigins` 内。本包不启用跨域 CORS，初期通过同源服务端网关接入。不要把平台或供应商凭据放在浏览器存储中。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/health` | 基础状态；`productionReady` 始终为 false，不代表平台联调完成 |
| POST / GET | `/api/v1/cloud/sessions` | 创建或列出当前作用域的会话 |
| GET | `/api/v1/cloud/sessions/:sessionId` | 读取会话 |
| POST / GET | `/api/v1/cloud/sessions/:sessionId/runs` | 提交或列出任务 |
| GET | `/api/v1/cloud/sessions/:sessionId/events?after=0` | 按事件序号回放，每页最多 200 条 |
| GET | `/api/v1/cloud/runs/:runId` | 查询原任务状态 |
| POST | `/api/v1/cloud/runs/:runId/cancel` | 请求取消，正文为 `{}` |

创建会话正文为 `{ "title": "会话标题" }`。提交任务正文为 `{ "requestId": "客户端生成的唯一请求ID", "message": "用户目标" }`。同一会话中同一 requestId 和正文返回原 Run；不同正文返回 409。重试已经结束或中断的请求，不会重新调用模型。即使配置更新或执行容量已满，已有请求仍可查询并返回原结果。

任务接收先写数据库，再启动执行。接口返回 202 不表示任务已完成。事件回放使用响应的 `nextEventSeq` 继续读取；断线后不要换一个 requestId 重新执行。取消只停止后续执行及等待，不保证供应商已经开始的推理立即终止或不产生费用。

会话保存 Profile ID 与版本；配置版本改变后原记录仍可读取，但新执行必须新建会话。本版会话、任务列表各返回最近 100 条，不是完整分页管理后台。

## PostgreSQL 云端持久化

标准云端入口改用 PostgreSQL：部署环境提供 `DAOYIN_CLOUD_POSTGRES_URL`，先执行发布包中的 `postgres-migrate.mjs`，再启动 `main.mjs`。服务启动只校验表是否存在，绝不自动建表或改写生产结构。连接串只应由密钥管理器或受保护的服务环境注入。

从已停止的旧单实例迁移时，先停止新请求、等待运行中任务结束并保留 SQLite 备份，再将绝对源路径赋给 `DAOYIN_CLOUD_LEGACY_SQLITE` 并执行 `sqlite-to-postgres.mjs`。源库完整性检查必须通过；目标业务表必须为空，已有数据或冲突将使整个导入回滚。逐表核对数量，绝不静默跳过记录；导入不复制运行租约。新 PostgreSQL 实例自身的崩溃恢复仍会把遗留 running Run 追加为 interrupted，不重放模型或外部操作。

PostgreSQL 的会话、Run、事件、压缩摘要和版本化记忆均使用事务持久化。事件与 Run 状态同次提交，运行租约会在每个写入事务中复核。生产数据库应仅允许 Harness 服务所在网络访问，并使用私网连接或 TLS。

## SQLite 试运行适配

`SqliteCloudRepository` 通过 `@daoyin/harness-server-cloud/sqlite` 单独导出，使用 Node 内置 `node:sqlite`。它是独立临时数据库测试和单实例试运行适配，不是主平台数据库迁移，不是生产多 Worker MySQL 方案。

会话、请求和事件采用事务写入。相同会话最多一个 running Run；终态之后拒绝追加迟到结果。摘要只追加，原事件保留。目录与数据库文件的访问权限、磁盘配额、备份和保留策略由部署方提供。

打开数据库本身不会接管 running 任务。标准启动入口先取得 SQLite 单实例租约，再把旧任务追加为 interrupted；不自动重放模型或外部操作。租约有效时拒绝第二个执行实例，旧实例丢失租约后不能追加结果。首次从无租约旧版本升级必须先停止旧服务并确认退出；不能让不认识租约表的旧二进制继续运行。该单实例恢复机制已部署，仍不提供多 Worker 调度或跨机器故障接管。`recoverInterruptedRuns()` 保留为受控管理操作，租约模式下调用者也必须具有执行所有权。

## Windows 验证

共享 checkout 的依赖和验收只能在 Windows PowerShell 运行，不能在 WSL 安装或执行测试。使用仓库 `.node-version` 固定的 Node 版本。新增 workspace 的链接和 lockfile 必须由 Windows npm 确认；在确认 lockfile 与工作区清单同步前，不把 `npm ci` 的成功作为既成事实。

```powershell
Set-Location D:\AllProjects\DaoyinHarness
npm install
npm run typecheck
npm run lint
$env:NODE_OPTIONS = '--experimental-sqlite'
npm test
Remove-Item Env:NODE_OPTIONS
npm run build
```

需要保留既有 NODE_OPTIONS 时，在本机将该选项追加到原值并在测试后恢复。Node 22.12 的 SQLite 模块需要实验标志；仓库固定版本较新，但这里保留兼容运行方式。

新增测试位于 `contracts/src/execution-identity.test.ts`、`tools/src/registry.test.ts`、`server-cloud/src/sqlite-repository.test.ts` 和 `server-cloud/src/app.test.ts`。覆盖身份边界、隐藏工具直接调用、撤销授权、幂等冲突、事件游标、数据库重开、中断标记和取消后的迟到回复。HTTP 测试使用真实 Fastify、共享 AgentEngine 和隔离 SQLite；认证、模型和业务 I/O 使用测试替身，不证明真实平台登录、付费链路或线上效果。

## 下一阶段

官网已完成单实例上线，后续补齐个人与企业应用授权、Story 查询与长任务。生产多 Worker 存储、受控业务写入、账务预留及跨业务记忆独立验收，不通过放开只读限制代替实现。
