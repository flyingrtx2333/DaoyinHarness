# 会话列表管理

## 实现范围

云端工作台每条会话右侧有独立的“⋯”按钮，点击不切换会话。菜单提供置顶／取消置顶、归档／取消归档、删除。侧栏分为“最近会话”和“已归档”，两个范围内均可搜索。置顶项优先排序，同组按置顶时间、创建时间和 ID 降序排列。

菜单通过 portal 定位，不被会话列表滚动区域裁切；支持方向键、Home/End、Escape、点击外部关闭及焦点恢复。窄屏和触控入口至少 44px。删除使用原生模态确认框，默认聚焦取消，执行中禁止重复确认。

状态以服务端返回为准，不使用 localStorage 隐藏记录或伪造操作成功。当前会话归档或删除成功后回到新会话；失败时保留原列表并显示错误。归档会话可以阅读，恢复后才允许继续发送。

## 数据和权限

`CloudSession` 新增可选 `pinnedAt`、`archivedAt`。PostgreSQL 与 SQLite 的 `cloud_sessions` 新增可空列 `pinned_at`、`archived_at`、`deleted_at`。操作全部使用 `executionScopeKey` 限定原有身份／空间／应用范围，不能由请求正文指定身份。

删除是软删除：普通列表、会话、事件及 Run 查询不再返回该会话；重复删除返回相同成功语义，界面不提供恢复。原始事件、Run、压缩记录仍保留用于审计；本操作不是个人数据彻底清除接口，也不会撤销已经单独保存或共享的长期记忆。现有每空间 500 条存储配额仍包含软删除记录，不能依靠隐藏记录绕过资源限制。

归档清除置顶。已归档会话必须恢复后才能置顶或接受新任务。归档和删除拒绝仍有运行中 Run 的会话；PostgreSQL 的操作与新 Run 接受共用会话行锁，SQLite 使用现有写事务串行化。前端也保护当前加载、提交、生成及结果尚未确认的请求。操作采用明确目标状态而非 toggle，因此相同操作重试不会反转结果。

## Harness 接口

`POST /api/v1/cloud/sessions/:sessionId/manage`

请求：`{ "action": "pin" | "unpin" | "archive" | "restore" | "delete", "confirm"?: boolean }`。删除必须显式 `confirm: true`。请求正文禁止额外字段，沿用云端授权与执行租约检查。

正常响应：`{ "session": CloudSession, "deleted": false }`；删除响应：`{ "session": null, "deleted": true }`。忙碌或归档状态冲突返回 409；不存在／越权返回 404；未实现管理能力的存储返回 501。会话变更只在事务提交成功后通知现有订阅者。

列表返回当前范围内未删除的活动与归档记录，最多 500 条；前端按范围过滤，不能由 BFF 丢弃新增状态字段。

## 尚未完成的接线与发布条件

本轮只修改 Harness 仓库，没有修改主平台、发布服务或执行数据库迁移。

主平台 BFF 需核验并接通两个入口的 `POST /sessions/:sessionId/manage`：官网 `/api/company-assistant/agent` 与赛事 `/api/agent-apps/saishi/workbench`。浏览器客户端已使用这一契约，但本仓库不包含该转发实现；本轮未验证它已可用。转发必须复用现有 HttpOnly Cookie、CSRF、账号 scope 与服务端委托授权，不把云端 Bearer 暴露给浏览器，也不绕过账号权限。

PostgreSQL 的新增列在 `migratePostgres` 中声明，需要授权后的显式迁移。新运行时 readiness 会校验列和 UPDATE 权限，不能直接在旧 schema 上切换服务。SQLite 延续原适配器启动时补充 schema 的行为；本轮没有打开或迁移生产 SQLite。

**旧 SQLite → PostgreSQL 导入脚本尚未兼容新增状态。** `sqlite-to-postgres.ts` 目前仍只复制旧会话字段；本轮尝试补充兼容逻辑时，工具拦截写入，文件未修改。不得用它导入已经存在置顶、归档或删除状态的数据，否则这些状态会丢失，删除记录可能重新出现。此项应在实际使用该导入路径前修复并核验；当前已经使用 PostgreSQL 的服务不需要走这条导入路径。

前端、云端与 BFF 应协调发布；旧客户端会把归档记录当成普通记录。开始产生软删除后，不能直接回滚到不检查 `deleted_at` 的旧云端代码，否则会重新展示已删除记录；应回滚至保留状态过滤的兼容版本。保留新增列和原始数据，不通过删除数据回滚。

## 本轮检查（独立 Linux 服务器源码，未提交）

- UI TypeScript 检查通过；云端 TypeScript 检查通过。
- 本轮相关 TS/TSX 定向 ESLint 通过。
- `build-workbench-release.mjs --server-linux --preview` 打包通过，包含上一轮设置版本信息与本轮会话菜单。
- 未运行模拟测试或历史 Vitest 套件；未进行真实模型调用、浏览器布局验收、生产接口联调或迁移验收。类型检查和打包不是端到端功能通过的证据。
- 未提交、未推送、未部署；生产页面不会因为源码修改自动更新。
