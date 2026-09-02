# DaoyinHarness

> **项目状态：架构设计阶段。** 当前仓库只包含文档基线，npm 包尚未发布，下面的安装与启动命令暂不可用。

DaoyinHarness 是一个计划中的本地 AI 应用构建运行时。用户安装一个 npm 包，在本机打开网页，使用道引主平台账号登录后，即可让 Agent 在真实工作目录中创建、修改、构建、验收和预览项目。

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
5. 在本地真实工作区运行 Agent、构建、验收并提供预览。
6. 重启进程或刷新页面后，从 transcript 与 checkpoint 恢复。

## v1 范围

v1 必须完成一个不依赖云端任务队列的本地闭环：

- 道引主平台账号登录。
- 每个项目独立的真实本地工作区。
- Agent 读取、创建和继续修改工作区文件。
- 结构化工具进度、取消、插话和会话恢复。
- 本地构建、验收和隔离预览。
- 失败不覆盖最后一个可用 checkpoint。
- 当前轮、项目级和同账号本机跨项目记忆。

v1 明确不包含：

- COS 项目同步和跨设备恢复。
- 公开预览域名与正式发布。
- 微信、飞书、QQ 等 IM 渠道。
- 任意系统 Shell 或无限制命令执行。

这些能力进入后续阶段，不能作为 v1 完成的前置条件。

## 架构边界

```text
本地 DaoyinHarness                         道引云端控制面
┌────────────────────────┐                ┌──────────────────────┐
│ CLI 与本地 HTTP 服务    │──账号授权─────→│ OAuth、账户与会员      │
│ Web UI                  │──模型请求─────→│ 用户鉴权的 AI Gateway  │
│ Agent Engine 与工具     │                │ 用量、策略与审计        │
│ Workspace 与 Checkpoint │                │                      │
│ 构建、验收、本地预览    │                │ 后续：同步、发布、IM    │
└────────────────────────┘                └──────────────────────┘
```

本地端是交互式构建的执行主体。云端不参与普通文件修改、进度调度和本地预览，只提供账户授权与模型能力。模型供应商密钥永远不下发到本地前端。

## 数据原则

- 活动项目文件以本地工作区为权威来源，COS 不是实时文件系统。
- 每个会话的 JSONL transcript 是不可变事实记录，只能追加。
- SQLite 保存结构化索引、状态和检索结果；它损坏后应能从 transcript 重建。
- checkpoint 是不可变快照。失败候选只能新增，不能覆盖最后一个可用版本。
- Refresh Token 只能进入操作系统凭据库，禁止进入 localStorage、日志或明文 SQLite。

计划中的默认数据目录：

```text
~/.daoyin-harness/
└─ <accountId>/
   ├─ index.sqlite
   ├─ logs/
   ├─ memory/
   └─ workspaces/
      └─ <projectId>/
         ├─ files/
         ├─ transcripts/
         ├─ checkpoints/
         └─ artifacts/
```

## 技术基线

- Node.js 22 LTS、ESM、TypeScript strict。
- npm workspaces 与 `package-lock.json`。
- Fastify 本地服务。
- React + Vite Web UI。
- SQLite 状态索引与 JSONL 事件日志。
- 本地 REST API 与 WebSocket 协议统一使用 `/api/v1`。

计划中的工作区包：

```text
packages/
├─ cli/
├─ server/
├─ agent-core/
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

当前还没有 `package.json`、可执行 CLI 或开发脚本。后续 P1 建立工程骨架后，统一提供：

```powershell
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

在这些脚本真正落地之前，文档、提交说明和发布页面不得宣称 DaoyinHarness 已经安装成功、已经运行或已经通过验收。

## 参考资料政策

`claude-code-main/` 是本机已有的反编译/恢复工程，当前目录中没有随附许可证文件。DaoyinHarness 只允许记录独立观察到的行为、协议需求和测试用例，不允许复制其源码、类型、文案、品牌资源或生成产物。详见 [ADR-0001](docs/adr/0001-clean-room-local-runtime.md)。

## 路线图

P0 只建立文档和仓库治理；P1 才开始实现 npm CLI 与本地服务。完整阶段和退出条件见 [ROADMAP](docs/ROADMAP.md)。

