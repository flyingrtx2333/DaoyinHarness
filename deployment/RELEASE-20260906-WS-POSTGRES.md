# 2026-09-06 WebSocket 与 PostgreSQL 联合发布

## 范围

云端工作台与官网嵌入问答通过同源 WebSocket 接收已持久化事件，正常连接时停止 HTTP 轮询；HTTP 保留幂等提交、取消与断线回退。工具转圈和正文增量共用原事件协议，发送消息保持原面板。账号菜单、头像和后台身份检查沿用现有实现。

云端标准入口改用 PostgreSQL；本地 CLI 仍为 JSONL 事实记录加 SQLite 索引。修复 PostgreSQL 跨轮事件序号、首次并发获取租约，以及导入冲突静默跳过的问题。迁移只接受无活动任务的源库及空目标表，整个导入事务核对数量，失败回滚。

## Windows 验证

- `npm run typecheck`、`npm run lint`、`npm test`、`npm run build` 通过：326 项常规测试；PostgreSQL 专项在本机 Docker 隔离数据库另行执行，6 项通过，覆盖跨轮序号、作用域、幂等、取消/崩溃恢复、租约互斥、记忆确认/遗忘与导入冲突拒绝。
- `scripts/verify-cloud-websocket.mjs`：Edge、真实编译 UI、模拟 HTTP/WS，官网与赛事入口的增量、无轮询、断线回放、去重、身份失效、不重提交通过。
- `scripts/verify-account-access.mjs`：14 组检查通过，包含 1280/1920/390/320 宽度、用户头像、草稿、账号切换、菜单、设置和退出。身份与业务接口为模拟数据。
- `scripts/verify-cloud-modern-ui.mjs`：9 组检查、26 张截图，HTTP 回退、工具进度/取消、引用展开、44 条会话滚动、200% 文字和长标题布局通过，无页面错误或失败请求。旧试验截图已归档到忽略的缓存目录，仓库保留本轮通过的证据。
- 主平台配套提交 `11f750738b5415b8d0f10c2307b337fe65e09fd1`：项目 Docker 隔离测试 64 项、官网前端测试 10 项和构建通过。

## 切换与恢复规则

目标是服务器 `42.194.159.81` 的 `127.0.0.1:5432/daoyinharness`。专用非超级用户 `daoyinharness_runtime`，连接凭据仅在主机受保护的环境文件中，仓库和浏览器均不保存。

切换前保留 PostgreSQL 快照、旧 SQLite 完整备份、原环境和发布路径；停止旧实例后执行显式迁移与导入。验证数据后切换运行时与静态资源，Nginx 配套开启 Upgrade、长连接和精确同源 CSP。

切换完成并接收新写入后，不能直接启用旧 SQLite。回退必须保持 PostgreSQL 作为新事实来源，使用兼容发布或重新迁移核验，避免丢失切换后的消息。单实例租约仍是当前执行边界；PostgreSQL 不代表已提供多 Worker 调度。

## 生产结果

- Harness 运行时与静态资源：`efe56eb9926d200fa952145b483b61e629c51b25`。Windows 从 Git 提交构建，独立运行时锁文件经 `npm ci --omit=dev --ignore-scripts` 验证；服务器逐文件校验 SHA-256 后安装 81 项运行时依赖。旧依赖目录未复用。
- 主平台后端与官网前端：`11f750738b5415b8d0f10c2307b337fe65e09fd1`。后端 [CI 34023886427](https://github.com/flyingrtx2333/daoyintech/actions/runs/34023886427) 与前端 [CI 34023886370](https://github.com/flyingrtx2333/daoyintech/actions/runs/34023886370) 均成功；服务器镜像已核对并固定到该提交。
- 备份目录：`/var/backups/daoyin-agent/ws-postgres-20260906`。包括原 PostgreSQL dump、`public-before-postgres.sqlite`、原服务环境、原镜像配置、Nginx 配置和发布路径。导入共 1,087 行：12 会话、26 Run、1,049 事件，其余六张业务表为零；逐表数量和逐行内容 SHA-256 全部一致。
- 17:20（北京时间）切换后，运行时 `/health` 为 available，主平台 `/health` 为 ok；活动 PostgreSQL 租约正常。Nginx 测试和重载通过，复用现有 Upgrade map，为官网、赛事及内部 Harness 三跳启用 WebSocket，静态 CSP 允许精确同源 wss。既有 vhost 重复 server_name 警告未改变服务结果。
- 17:23 真实生产公开访客验收：两轮模型调用成功，56 个正文增量、1 次工具开始和完成，转圈与未完成正文均实际可见；首正文约 11.98 秒。实际 WebSocket 断开重连后按游标恢复，正常连接时无 HTTP 周期轮询；第二次发送保留第一轮 DOM，恰好提交两次，页面无错误。
- 17:24 再次核对：14 会话、30 Run、1,188 事件；迁移前的全部 1,087 行仍逐行一致，租约有效。新增记录来自上线公开问答验收。
- 生产 HTTPS 四项静态文件哈希、匿名访问拒绝、外域 Origin 拒绝、登录跳转均已验证。用户头像/菜单/设置使用真实生产资源与模拟私人账号验证；没有代替用户完成私人账号登录或赛事业务验收。

当前仍是单执行实例云端基础服务，`productionReady:false` 的健康字段表示多实例能力未交付，不表示服务不可用。
