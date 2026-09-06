# 云端 WebSocket 事件推送

2026-09-06：Windows 类型检查、lint、326 项常规测试、6 项真实隔离 PostgreSQL 测试和构建通过；Edge 的模拟 HTTP/WS 联合验证通过。生产部署证据独立记录于 [发布记录](../deployment/RELEASE-20260906-WS-POSTGRES.md)。

## 分工与函数

- HTTP `POST sessions / runs / cancel` 原样保留。请求幂等仍由 repository.acceptRun / findRequest 处理。
- `createCloudServer()` 使用 `withCommittedSessionEvents(repository)`，再调用 `registerCloudEventStream()`。SQLite 原生 `#transaction()` 在提交后通知；PostgreSQL 等异步仓储装饰器在 acceptRun、绑定的 events.append、requestCancellation、interruptRun 完成后通知。不会修改原事务或重复通知已有 native subscription 的仓储。
- `subscribeSession()` 只产生“有新数据”的进程内通知，不传业务正文。流处理器 `attach → wake → pump → readEvents → sendEvents → send` 先订阅，再补发历史。多个通知合并成 dirty 标记，不把所有 token 堆进每连接队列。
- `pump()` 读持久事件及 Run 投影。事件按连续 eventSeq 串行发送；Run 仅发送有变化的快照。读取过程中有新提交会再次补读，不在历史回放和实时模式之间留下空窗。
- 主平台 `services/agent_event_stream.py::proxy_session_events()` 是只读 BFF，不含模型、提交任务或取消调用。复用 `agent_public.browser_access()` 或 `agent_apps.browser()`。`still_authorized()` 在发帧前及空闲期间复查，服务凭据只出现在受控服务间请求头。
- Harness React 使用 `WorkbenchClient.openEventStream()` 与 `watchCloudSession()`；ready 后不再周期查询 runs/events。增量事件序号去重，Run 快照不能倒退。页面切换/账号切换会销毁订阅。
- 官网嵌入问答继续使用 `createCompanyAgent()`，其 `observe()` 改接 `observeCompanyRun()`；同样保留 HTTP 降级，不影响旧 legacy chat 路由。

## 地址与首帧

浏览器同源：

| 入口 | WebSocket 路径 |
| --- | --- |
| 官网公开问答 | `/api/company-assistant/agent/sessions/{sessionId}/events/ws` |
| 赛事账号工作台 | `/api/agent-apps/saishi/workbench/sessions/{sessionId}/events/ws` |
| 主平台到 Harness | `/api/v1/cloud/sessions/{sessionId}/events/ws` |

浏览器 URL 不携带凭据或查询串。首帧仅包含 `type=subscribe`、已应用的 `after`、当前 `csrfToken`、`accountScope`（公开访客为空）。这是复用已有身份的请求校验，不是新增手动授权。账号身份来自 HttpOnly Cookie；首帧不能设置用户、租户、工具或模型。

BFF 解析账号后，使用内部 Bearer 连接固定 Harness 地址，只转发 `{type:'subscribe',after}`。任何后续客户端业务消息、重复订阅、非文本帧或额外参数均拒绝。连接不允许重定向，也不读取进程 HTTP 代理配置。

服务端帧：

| type | 字段 |
| --- | --- |
| events | sessionId, events, nextEventSeq |
| run | sessionId, run |
| ready | sessionId, lastEventSeq |
| heartbeat | sessionId, lastEventSeq |

原 AgentEvent、Run 和工具数据协议不变。传输可以重复，客户端按序号去重；不是 exactly-once 传输。关闭码 4401/4403 对应身份/权限失效，4404 表示无权访问会话，4409 表示游标需从历史重新建立；1012/1013 可重连回放。

## 存在哪里

本次不增加 SQL 表。继续读取当前仓储的 `cloud_events`、`cloud_runs`、`cloud_sessions`；写入仍发生在原事务。SQLite `#append()` 将事件及 Run 投影一起提交后才发通知。异步仓储必须满足写入 Promise 在提交后 resolve 的契约。

通知 Map、连接缓冲、游标、心跳和前端 feed 在内存中；浏览器原 sessionStorage 请求回执继续保存，WebSocket 不保存凭据、不另开副本数据库。服务重启后靠事件表补发，不靠内存 Map 恢复。

此机制只适用于当前单执行实例。PostgreSQL 支持不等于已支持多 Worker 分发；其他进程直接写库不会触发本地通知，多 Worker 阶段需另做事务 outbox 或可靠通知。启动前的遗留任务恢复没有在线订阅，首次连接会自然回放其终态。

## 默认限制与恢复

- 每实例最多 128 条连接；Harness 每完整执行空间最多 4 条，BFF 每内部账号连接最多 4 条。BFF 数量上限按进程计，不替代网关连接限制。
- 首帧 5 秒，消息最多 1 KiB；事件发送单帧最多 192,000 字节；Harness socket 缓冲超过 512,000 字节或单次发送超过 5 秒即断开。
- 每次按 32 条事件读数据库，按字节拆帧；通知在约 40 毫秒窗口合并。实际延迟仍受网络、数据库和权限检查影响，没有经过性能压测。
- 10 秒心跳并复查权限，浏览器 35 秒无帧触发重连；重放准备阶段有 8 秒连接超时。
- 重连退避间隔带抖动，最大约 10 秒。断开期间只做读取回退：运行中约 2 秒一次，工作台空闲约 10 秒；ready 后停止周期 HTTP 查询。
- 关闭页面只断开订阅，绝不调用 cancel。用户取消仍走 HTTP，并等待原持久事件。网络断开、发送失败不调用 submit/startRun，不重发供应商请求。
- 已发送到用户端的信息无法撤回；撤销控制的是后续帧。数据库保存事实，WebSocket 是展示通道。

## 配套构建与部署

Harness 增加已有版本的 `@fastify/websocket` 依赖并同步 workspace lockfile。`scripts/build-cloud-release.mjs` 已包含该依赖的 external 和运行时 manifest；不能复用不含它的旧发布依赖目录。主平台要求 `websockets>=15.0.1,<18`。

Nginx 合并示例见 [nginx-event-stream.conf.example](../deployment/nginx-event-stream.conf.example)：在 http 级定义 Upgrade map，在原 BFF locations 开启 HTTP/1.1 Upgrade、关闭响应缓冲、配置长连接超时。如主平台到 Harness 还经过反向代理，该跳也需相同升级配置。不要重复粘贴同名 location。

静态工作台 CSP 已明确允许同源 `wss://www.daoyintech.com`。部署在别的域名须替换为实际精确来源；官网 HTML 的 CSP 也需保留其他规则并允许相同来源。生产配置修改、nginx -t/reload、依赖安装和三个产物（主平台、Harness 运行时、前端）的同步发布另行验收。

## 测试源码与验收命令

| 文件 | 覆盖／证据性质 |
| --- | --- |
| `packages/server-cloud/src/event-stream.test.ts` | 真实 Fastify/SQLite/共享内核；认证和模型是替身，回放/提交通知/撤销/慢连接/不重跑 |
| `packages/server-cloud/src/event-repository.test.ts` | 异步仓储契约、等待提交后通知；不是 PostgreSQL 服务器测试 |
| `packages/ui/src/cloud/event-feed.test.ts` | 模拟 socket / timer，去重、重连、停轮询、状态不倒退、凭据不进 URL |
| 主平台 `backend/tests/test_agent_event_stream.py` | 真实 ASGI WebSocket，模拟账号和上游；来源/CSRF/资源/超时/撤销/重定向拒绝 |
| 官网 `frontend/src/composables/companyAgentEvents.test.js` | 嵌入问答 observer，分段展示、断线回放、终态与关闭清理 |
| `scripts/verify-cloud-websocket.mjs` | Windows Edge 真实编译 UI＋模拟 HTTP/WS；无真实登录/模型/业务数据 |

Windows Harness 根目录：

```powershell
npm run typecheck
npm run lint
npm test
npm run build
node scripts/verify-cloud-websocket.mjs
```

Windows 主平台 backend 目录的隔离测试环境：

```powershell
docker compose -f docker-compose-agent-test.yml build agent-tests
docker compose -f docker-compose-agent-test.yml run --rm agent-tests python -m pytest -q -p no:cacheprovider tests/test_agent_event_stream.py tests/test_agent_public.py
docker compose -f docker-compose-agent-test.yml down
```

官网前端两组 Vitest 共 10 项通过，frontend 构建通过；主平台 Docker 隔离测试共 64 项通过。线上 Cookie 到 BFF 到 Harness WebSocket、反代和真实模型验证见独立发布记录；模拟账号测试不能替代真实私人账号验收。
