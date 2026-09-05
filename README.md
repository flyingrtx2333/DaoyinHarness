# DaoyinHarness

DaoyinHarness 现定位为**道引统一 Agent 平台的共享执行内核**：本地 CLI / 工作台和云端业务入口共用 `AgentEngine`；主平台 backend 负责身份、空间、应用安装、授权和费用归属，短剧、文旅、Builder 保留业务服务与任务状态。

官网已上线共享 AgentEngine 的单实例只读服务，接入主平台访客授权、MySQL 操作去重与调用额度、公开知识检索、单步模型及 Cookie/CSRF 会话代理。真实模型、检索、回放与取消接口已验证；多 Worker 调度与跨业务写操作仍待完成。当前架构见 [统一 Agent 平台说明](docs/UNIFIED-AGENT.md)，生产版本和证据见 [上线记录](deployment/RELEASE-20260905.md)。

> **项目状态：通用本地 Agent 纵向闭环已打通，模型网关客户端、受控 Browser、远程 Streamable HTTP MCP、Goals / Workflow / Child Agent orchestration，以及 session fork/resume/search + crash interruption recovery 已落地，主平台 OAuth / Gateway 服务端仍待联调。** CLI、本地 API、React Web UI、安全工作区、append-only trajectory、每步 Prompt/Context 装配、Capability Registry、Skills、公共 Web、Browser、MCP、provenance-bound Memory、Context Compaction、持久 Goal/Workflow/Child Run、受控 Process Service + 一次性 Permission Gate，以及标准化 Daoyin AI Gateway `ModelClient` 已经串联。Linux Bubblewrap OS Sandbox 已实现并带启动探测；Windows/macOS Sandbox、插件/能力管理、SQLite materialization/语义检索与正式 npm 发布仍待完成。

本地运行形态继续保留：用户通过道引账号登录后，同一个 Agent 可以在持续会话中聊天、检索公开网页、操作受控本地浏览器、调用显式配置的 MCP 扩展、处理本地文件、维护任务目标和运行 Workflow。云端通过受限的业务 Profile 装配能力，不加载本机工具或自动同步本地历史。

项目采用净室实现。仓库旁的 `claude-code-main/` 只用于研究持久 Agent 的行为与交互模式，不是 DaoyinHarness 的代码基础，也不会进入 Git、npm 包或发布产物。

## 目标体验

以下命令是产品目标，不代表当前已经可用：

```powershell
npm install -g @daoyin/harness
daoyin-harness
```

也计划支持一次性启动：

```powershell
npx @daoyin/harness
```

默认行为：

1. 启动仅监听 `127.0.0.1` 的本地服务。
2. 优先使用端口 `4677`，被占用时依次尝试到 `4699`。
3. 自动打开本地 Web UI。
4. 通过道引主平台 OAuth 2.1 Authorization Code + PKCE 登录。
5. 在持续会话中按需使用本地文件、网页检索、受控进程与后续扩展能力；写代码和预览网页只是可选任务类型之一。
6. 重启进程或刷新页面后，从 transcript 与派生状态恢复，不丢失已经完成的工具证据。

## 本地 v1 范围

v1 必须完成一个不依赖云端任务队列的本地通用 Agent 闭环：

- 道引主平台账号登录与统一 AI Gateway。
- 持久会话、多轮上下文、取消、恢复、分叉所需的 append-only trajectory。
- 本地工作区的安全文件读取、搜索、创建和修改；工作区只是可选上下文，不等于任务类型。
- 公共网页搜索/抓取与受控 Browser；Browser 使用独立 capability seam，不和原始 HTTP fetch 混成一个工具。
- 受控进程、构建/测试等本地执行能力；高风险操作必须进入权限或沙箱边界，而不是默认开放任意 Shell。
- Skills、MCP 工具包与后续插件通过统一能力注册表组合，不把具体工具写死在 Agent loop 中。
- 结构化工具进度、错误证据和 `eventSeq` 回放；失败不能抹掉已经完成的事实记录。
- 当前回合、会话、本机稳定偏好与后续知识记忆分层，原始 transcript 始终是事实源。

v1 明确不包含：

- COS 项目同步和跨设备恢复。
- 公开预览域名与正式发布。
- 微信、飞书、QQ 等 IM 渠道。
- 任意系统 Shell 或无限制命令执行。

这些能力进入后续阶段，不能作为 v1 完成的前置条件。

## 架构边界

```text
本地 DaoyinHarness                              道引云端控制面
┌─────────────────────────────┐                ┌──────────────────────┐
│ CLI / Local HTTP / Web UI    │──账号授权─────→│ OAuth、账户与会员      │
│ Session + Trajectory         │──模型请求─────→│ 用户鉴权的 AI Gateway  │
│ Agent Loop + Context         │                │ 用量、模型策略与审计    │
│ Capability Registry          │                │                      │
│ ├─ Workspace / Files         │                │ 后续：同步与远程能力    │
│ ├─ Web Search / Fetch        │                └──────────────────────┘
│ ├─ Memory / Compaction       │
│ ├─ Process / Permission      │
│ │   └─ OS Sandbox [Linux]    │
│ ├─ Skills / MCP / Plugins    │
│ └─ Browser / Workflow / Agent│
└─────────────────────────────┘
```

本地端是 Agent 与真实环境交互的执行主体，不限定任务必须是“构建项目”。云端只承担账户授权、模型能力、用量与策略控制；文件、网页访问、进程、浏览器、Skills 和工作流均通过本地 capability 边界接入。模型供应商密钥永远不下发到本地前端。

## 数据原则

- 每个会话的 JSONL trajectory 是不可变事实记录，只能追加；对话、工具结果和失败证据都从这里恢复。
- 本地工作区中的文件以真实文件系统为权威来源；工作区可以是代码仓库、资料目录或普通文件夹，不要求存在“项目”对象。
- SQLite 只保存结构化索引、派生状态与检索视图；它损坏后应能从 transcript 和 capability 自有事实重建。
- Task-specific artifact/checkpoint 只有在对应 capability 需要时才存在，并且不能在失败后覆盖最后一个已验证结果。
- Refresh Token 只能进入操作系统凭据库，禁止进入 localStorage、日志、trajectory、工具结果或明文 SQLite。

计划中的默认数据目录：

```text
~/.daoyin-harness/
└─ <accountId>/
   ├─ index.sqlite
   ├─ logs/
   ├─ sessions/
   │  ├─ catalog.json
   │  └─ transcripts/<sessionId>.jsonl
   ├─ compactions/<sessionId>.jsonl
   ├─ memory/memories.jsonl
   ├─ orchestration/state.jsonl
   ├─ process/permissions.jsonl
   ├─ skills/
   ├─ extensions/
   └─ artifacts/
```

用户显式选择的工作区保持在其原始磁盘位置，不默认复制进 `~/.daoyin-harness`。运行时目录只保存会话、索引、记忆、扩展配置与 capability 产生的工件。

## 技术基线

- Node.js 22 LTS、ESM、TypeScript strict。
- npm workspaces 与 `package-lock.json`。
- Fastify 本地服务。
- React + Vite Web UI。
- SQLite 状态索引与 JSONL 事件日志。
- 本地 REST API 与 WebSocket 协议统一使用 `/api/v1`。

工作区包规划（除 `evaluator` 外均已建立；Agent、Server、Workspace 与 UI 已完成第一条纵向集成）：

```text
packages/
├─ cli/
├─ server/
├─ agent-core/
├─ cloud/
├─ browser/
├─ mcp/
├─ orchestration/
├─ process/
├─ workspace/
├─ protocol/
├─ tools/
├─ evaluator/
└─ ui/
```

## 文档

- [架构与生命周期](docs/ARCHITECTURE.md)
- [本地协议](docs/PROTOCOL.md)
- [主平台登录与授权](docs/AUTH.md)
- [安全模型](docs/SECURITY.md)
- [测试与可靠性](docs/TESTING.md)
- [路线图](docs/ROADMAP.md)
- [ADR-0001：净室本地运行时](docs/adr/0001-clean-room-local-runtime.md)
- [ADR-0002：本地运行时与云控制面](docs/adr/0002-local-runtime-cloud-control-plane.md)

## 开发状态

P1 工程骨架与 Agent MVP 核心基础已建立，当前提供：

```powershell
npm install
npm run typecheck
npm run lint
npm test
npm run build
npm run package:audit
npm run package:verify
```

构建完成后可在本仓库运行；默认把启动命令所在目录作为 Agent 工作区，也可显式指定：

```powershell
npm start -- --no-open --workspace D:\path\to\project
```

当前 Web UI 已能创建/切换本地会话、全文搜索会话与持久工具证据、从最近安全终止边界创建不可变 session fork、显式恢复进程重启后遗留的 active turn、展示 `interrupted` 状态、展示持久化对话与工具状态、浏览真实工作区文件、显示运行时实际挂载的 capability，并停止正在运行的 turn。运行中的事件已由每 800ms 轮询升级为 session-scoped WebSocket 实时推送；断线后客户端携带最近 `eventSeq` 重连，服务端先补 persisted gap 再进入 live mode，REST replay 仍保留为事实恢复后备。Agent Engine 会从 append-only transcript 恢复最近多轮对话；fork 通过祖先引用继承源会话对话与已持久化工具证据，而不会复制或改写源 trajectory。

System Prompt 已改为注册式装配：固定 Identity / Scope / Tool Behavior / Safety / Orchestration Behavior / Completion 作为 Stable Sections 缓存；Runtime、Workspace、能力快照、Skill Catalog、最近 Tool Evidence、Turn Instruction、可见 Goal/Workflow/Child Run 状态与可选 Memory 作为 Dynamic Sections，在**每一个 Agent Step**调用模型前重新组装。`tool.started` 同时持久化受限 JSON 输入，使后续回合可以基于真实工具证据继续，而不是只依赖助手总结。

当前内置 capability packs 包括：安全 Workspace 文件操作、公共 `web_search` / `web_fetch`、受控 Browser、工作区 `.daoyin/skills/<name>/SKILL.md` 的按需发现与加载、provenance-bound Memory，以及独立 Process Service。Browser 自动发现系统已安装的 Chrome / Edge / Chromium；仅探测成功时才挂载 `browser_open / browser_snapshot / browser_click / browser_type / browser_back / browser_close`，每个 Harness session 使用独立临时 BrowserContext。浏览器流量强制经过 loopback 公网过滤代理：域名由代理解析并固定连接到已验证公网 IP，localhost/私网、凭据 URL 与非标准端口被拒绝，并显式取消 Chromium 的 loopback proxy bypass。`browser_type` 禁止 password/password-autocomplete 字段，输入正文通过 ToolRegistry `auditInput` 从持久化 `tool.started` 中脱敏。Process 不提供任意 Shell：`process_inspect` 只允许策略内的 Node/Git 只读检查；`run_package_script` 只允许 runtime allowlist + `package.json` 已声明的脚本，并对 exact command fingerprint 使用一次性 Permission Gate。批准/拒绝通过本地 CSRF API 和 UI 明确展示，批准本身不会后台自动执行，下一轮才消费授权。Linux 上会自动探测 Bubblewrap，探测成功后受控进程可获得文件系统/进程命名空间与默认断网隔离；Windows/macOS 暂时仍会如实标记 `osIsolation: none`。Memory 提供 `memory_search / memory_remember / memory_update / memory_forget`，按 session / resource / account 三个 scope 隔离；更新和忘记都通过 append-only supersession/tombstone 完成，不重写历史。Skill Catalog 自动向模型提供 `name + description`，完整正文只有调用 `load_skill` 时才进入上下文。Web 能力拒绝 localhost/私网、URL 凭据和非标准端口，并对 redirect 目标重新校验。

远程 MCP 采用显式 CLI 配置：`--mcp <id>=<URL>` 可重复指定 Streamable HTTP server，`--mcp-bearer-env <id>=<ENV_NAME>` 只引用进程环境变量名而不把 Bearer Token 写入配置或 transcript。远程地址要求 HTTPS，显式 loopback MCP 可使用 HTTP；URL 中的凭据和 query 被拒绝，transport 禁止自动 redirect。连接成功后 `tools/list` 被规范化成带 server namespace + hash 的 Harness `extension` tools，只有 MCP 明确声明 `readOnlyHint=true` 才按只读处理；其余保守视为 mutating。MCP 参数在持久化 `tool.started` 中只保留 key 结构、不保存值，图片/音频二进制结果也不会直接塞入 Agent evidence。单个 MCP server 连接失败只会变成该 server 的 failed 状态，不阻止其他能力和其他 MCP 工作。stdio MCP 暂未开放，因为它会启动本地进程，必须先纳入现有 Process Permission / Sandbox 边界，不能形成旁路。

Orchestration 现在提供 `goal_create / goal_list / goal_update / workflow_create / workflow_list / workflow_run / delegate_agent`。Goal、Workflow definition、Workflow Run 与 Child Run 都写入 `orchestration/state.jsonl` 的 append-only revision/snapshot，不保存隐藏思维链；Goal 更新可带 `expectedRevision` 防止覆盖更新。Workflow 每一步都创建独立 `childSessionId/childTurnId` 的 Child Agent trajectory，并与父 `sessionId/turnId` 显式关联；任一步失败或取消都会让 `workflow_run` 失败/取消并阻止父 Agent 把部分成功总结成完成。Child Agent 继承普通 Workspace/Web/Browser/MCP 等能力与父取消信号，但不会挂载递归 orchestration、`run_package_script` 或长期 Memory 写/改/删工具，避免隐藏审批和永久副作用。Web UI 的“任务状态”面板可以直接查看 Goal、Workflow、最近 Workflow Run 和 Child Run。

长会话现在有独立 Context Compaction：达到阈值后生成带 `sourceStartSeq..sourceEndSeq` 的派生摘要，只从模型的原始多轮输入中移走已覆盖旧 turn；原 JSONL trajectory 不删除、不改写。Compaction 摘要和最近未覆盖 Tool Evidence 分开进入 Dynamic Prompt，避免重复。

标准化 Daoyin AI Gateway 客户端已接入本地 `ModelClient` 边界：它接受 HTTPS（回环开发例外），限制凭据用途、响应大小和超时，验证模型回复并映射稳定失败码。正式本地路径使用 OAuth + OS Credential Store；开发仍可显式配置 `DAOYIN_HARNESS_GATEWAY_URL`、`DAOYIN_HARNESS_GATEWAY_CREDENTIAL` 和可选的 `DAOYIN_HARNESS_MODEL`，仅保存进程内凭据。未配置模型时任务明确失败。`npm run smoke:runtime` 验证本地纵向闭环，`node scripts/smoke-cloud.mjs` 验证新的云端启动与拒绝路径。主平台 OAuth/Gateway 服务端已经有源码；真实账号验收、Windows/macOS Sandbox、stdio MCP、插件设置、本地 SQLite 索引和语义记忆增强继续独立跟踪。

## 路线图

P0/P1 与 P3/P4 的一部分已经落地；当前目标是先完成 [ROADMAP](docs/ROADMAP.md) 中 P2–P5 的标准通用 Agent 能力集，而不是把网页预览当作 v1 完成标准。
