# ADR-0015：云端持久事件的 WebSocket 分发

日期：2026-09-06。状态：接受；Windows 验证已通过，联合发布记录见 deployment/RELEASE-20260906-WS-POSTGRES.md。

## 决策

保留 HTTP 创建会话、提交 Run、取消、历史分页及 requestId 幂等。WebSocket 只订阅一份已通过账号/空间校验的会话，不接受执行任务、工具、身份切换或取消命令。

- 浏览器经同源主平台 BFF 连接 `/sessions/{sessionId}/events/ws`。Origin 必须精确匹配；身份来自 HttpOnly Cookie；首帧传递已有 CSRF 与 accountScope，不把任何凭据放进 URL。首帧不创建账号或业务授权。
- BFF 用服务端解析的原有 Bearer 连接 Harness `/api/v1/cloud/sessions/{sessionId}/events/ws`。不将上游地址、凭据或原始错误发回浏览器。官网访客和赛事账号分别走各自身份服务。
- Harness 在事件事务提交之后发出“会话有变化”的内存通知。SQLite 提供原生提交后通知；PostgreSQL 等异步仓储通过 `withCommittedSessionEvents()` 在写方法成功 resolve 后通知，保留已有事务。订阅者先注册通知，再用 eventSeq 读取数据库缺口，随后进入实时模式；通知不包含业务正文，不取代数据库。
- 单连接串行发送有界批次。回放与实时合用一个游标，去重、检查缺口；客户端只能确认已经应用的连续事件序号。Run 快照另行传输，状态不落后回滚。
- 服务端每次发送数据前和空闲心跳期间重新校验身份/权限。首帧超时、消息大小、连接数、发送等待及缓冲量都有上限。慢连接断开后通过数据库回放恢复，不允许无限堆积消息。
- 浏览器连接正常时不高频查询 runs/events。断线采用有上限的指数退避与抖动重连，期间只做低频 HTTP 回放；401/403、账号变化和主动离开立即停止。断线永远不调用 submit/startRun。
- 断开订阅与取消任务是两件事。关闭页面不取消 Run；取消仍使用原有 HTTP 接口和持久取消标记。
- 本次基于现有单执行实例租约，兼容 SQLite 与异步 PostgreSQL 仓储。内存通知不提供跨进程分发；未来多 Worker 或直接外部写入必须接事务 outbox/可靠通知，不能直接启动多个写实例。工作区同期 PostgreSQL 迁移不属于本次变更，不重写其 schema、启动或数据库迁移。

## 不修改

不改变业务插件权限、记忆语义、模型适配流、费用策略或业务数据库；不引入独立 Agent 循环。没有新的数据库表或用户数据迁移。

## 验证

覆盖事务提交后通知/失败不通知、断线回放、回放期间新事件、跨账号/空间拒绝、撤销和过期、首帧与 Origin 校验、慢连接/心跳/关闭清理、HTTP 降级、去重和不重跑任务。Windows 是此共享 checkout 的运行验证环境；执行结果另记 `docs/CLOUD-EVENT-STREAM.md`。

参考：
- https://github.com/fastify/fastify-websocket
- https://www.starlette.io/websockets/
- https://websockets.readthedocs.io/en/stable/reference/asyncio/client.html
- https://nginx.org/en/docs/http/websocket.html
