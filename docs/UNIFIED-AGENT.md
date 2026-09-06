# 道引统一 Agent 平台

更新时间：2026-09-05。官网已切换至共享内核的单实例只读服务，真实模型、公开检索、事件回放与取消接口已验证。生产版本与验收证据见 [上线记录](../deployment/RELEASE-20260905.md)。

2026-09-06 产品规则更新：所有业务插件自动继承当前账号在所选空间内已有的完整权限，包含读写、生成和管理，不增加逐插件或同账号跨应用授权。服务端身份解析、资源校验与费用归属继续生效；未来接入按 [ADR-0012](adr/0012-first-party-account-access.md) 执行。赛事读取免二次授权已部署，见 [账号访问上线记录](../deployment/RELEASE-20260906-ACCOUNT-ACCESS.md)；下文官网生产证据不代表其他业务已经接通。

## 职责与边界

| 层 | 负责 | 当前实现 |
| --- | --- | --- |
| Harness `agent-core` | 推理、工具循环、上下文、事件、取消 | 本地与云端共用同一 `AgentEngine` |
| Harness `contracts` / `tools` | 身份、存储接口、授权发现与执行校验 | 个人/组织/公开空间契约；云端每步复查授权 |
| Harness `server` / CLI / UI | 本地运行、工作区、操作系统凭据和本地工具 | 保留现有本地端；不自动同步历史 |
| Harness `server-cloud` | 云端会话、Run、事件回放、Profile 装配 | 单实例 SQLite、平台 HTTP 适配、独立启动入口 |
| DaoyinTechnology `backend` | 用户、空间、安装、权益、授权、费用治理 | 本轮实现官网访客授权、付款成员校验、MySQL 操作账本与次数门禁 |
| Story / Youji / Builder | 业务资源、生成任务、构建与托管 | 保留各自服务；统一 Agent 接入仍按阶段推进 |

没有增加 Python 通用 Agent 内核。官网新模型接口每次只调用一次 provider，模型和工具之间的循环由 Harness 完成。已有官网旧 chat 仍可用；新 API 与旧 API 分开，禁止相同请求双跑或失败时自动转到旧收费链路。

## 官网执行链

```text
浏览器 → backend bootstrap（HttpOnly 访客 Cookie + CSRF）
       → backend 会话 / Run / 回放 / 取消代理
       → Harness server-cloud → 共享 AgentEngine
                               ├→ backend 授权内省与复查
                               ├→ backend company-assistant/chat 单步模型
                               └→ backend 公开知识安全检索 → 白名单来源片段
```

访客、资料归属和付款成员分别记录。访客授权仅包含 `agent.use`、`company.knowledge.read` 与 `search_company_knowledge`；不能借用付款成员的管理权限。每次请求、模型和工具前后检查授权期限、撤销、配置版本及付款成员状态。

MySQL 事务在外部调用之前登记授权/Run/操作编号、输入摘要和次数额度。相同操作和输入返回原完成结果；改变输入返回 409。未完成、超时或异常操作进入未知状态，重发不会再次调用。模型 SDK 自动重试关闭。检索继续使用既有召回、重排和安全过滤，费用日志绑定本次访客、授权、应用、付款账户、Run 和操作编号。

次数上限：每授权最多 20 次会话创建、120 次操作，每 Run 最多 12 次主模型和 24 次检索，全站每日上限可配置（默认 1000）。检索内部的 embedding、重排和安全模型仍由原检索预算约束；一次检索不是一次 provider 调用，也不代表固定费用。全站每天最多签发 200 个授权，每连接来源每小时 20 个。当前来源使用 transport peer，不信任浏览器提供的转发头；反向代理后需在可信边缘配置合适的限流。

## 配置与启动

backend 使用以下显式环境配置；关闭时新接口返回 503，旧官网 chat 不受影响：

| 变量 | 含义 |
| --- | --- |
| `AGENT_PUBLIC_ENABLED=1` | 启用新桥 |
| `AGENT_PUBLIC_WEBSITE_ENABLED=1` | 官网配置返回 harness；前端使用新桥，不在失败后自动转旧链路 |
| `AGENT_PUBLIC_SERVICE_TOKEN` | 专用服务凭据，至少 32 字符，不能复用供应商密钥 |
| `AGENT_PUBLIC_SPONSOR_TENANT_ID` / `AGENT_PUBLIC_SPONSOR_USER_ID` | 明确承担费用且有效的租户成员，不提供默认值 |
| `AGENT_PUBLIC_POLICY_VERSION` | 授权策略版本；修改会使旧授权失效 |
| `AGENT_PUBLIC_ORIGIN` | 唯一浏览器来源，含协议和端口 |
| `AGENT_PUBLIC_CLOUD_URL` | Harness 服务地址 |
| `AGENT_PUBLIC_DAILY_OPERATIONS` | 全站每日操作次数，1–10000，默认 1000 |

数据库迁移位于主平台 `backend/db/migrations/20260905_agent_public_bridge.sql`，已通过指定 backend 的发布流程应用到生产；应用启动不自动执行迁移。

Harness 配置：`DAOYIN_CLOUD_PLATFORM_URL` 指向 backend；`DAOYIN_CLOUD_SERVICE_TOKEN` 与平台专用凭据一致；`DAOYIN_CLOUD_DATABASE` 为受保护目录中的绝对 SQLite 路径，父目录必须存在；`DAOYIN_CLOUD_PORT` 默认 4700。服务只绑定 `127.0.0.1`，端口冲突直接失败，适合受保护的同机反向代理。两端 URL 接受 HTTPS，开发环境仅允许 loopback HTTP；Docker 跨容器部署需明确的 HTTPS 服务入口，不能直接改成任意明文主机。

```powershell
npm run build
npm run start:cloud
```

不要将运行数据库放进源码/证据目录或提交 Git。`/health` 只说明进程可响应，`productionReady: false`；不会用它声称平台认证、模型或检索已就绪。

## Harness 品牌资源

Harness 自有界面统一使用 Aurora Fold 重绘标志，唯一发布资源为 `packages/ui/public/assets/harness-logo.png`。云端工作台的侧栏、欢迎区、助手标识和浏览器图标共用同一文件；后续本地工作台也必须遵循此规则。完整的资源、使用与变更要求见 [Harness 品牌资源](HARNESS-BRANDING.md)。

## 浏览器接入协议

所有路径前缀为 `/api/company-assistant/agent`，仅使用同源 Cookie，不向浏览器返回访客 bearer。

| 方法与路径 | 正文或返回 |
| --- | --- |
| POST `/bootstrap` | `{}`，返回 `csrfToken`、`expiresAt`，设置 HttpOnly/Secure/SameSite Cookie（loopback HTTP 开发不设 Secure） |
| POST `/sessions` | `{title}`，返回会话 |
| GET `/sessions` | 当前访客的会话 |
| POST `/sessions/:id/runs` | `{requestId,message}`，返回 `run`、`reused` |
| GET `/sessions/:id/runs` | 会话任务列表，用于找回原请求 |
| GET `/runs/:id` | 原任务状态和最终正文 |
| GET `/sessions/:id/events?after=0` | `events`、`nextEventSeq`、`hasMore` |
| POST `/runs/:id/cancel` | `{}`，停止后续工作，保留已完成事件 |
| POST `/logout` | `{}`，撤销授权并清除 Cookie |

bootstrap 要求严格 Origin；其他写请求还需 `x-agent-csrf`。会话正文不能携带身份、工具、模型或系统提示。刷新/断线时保留 `requestId`，查询或重新提交同一请求，不能改编号触发第二次执行。取消不保证已经发出的 provider 调用不再计费。

访客授权有效期 30 分钟；当前没有跨授权续期或跨设备找回访客历史的产品。重复 bootstrap 在有效 Cookie 下返回同一授权；过期/撤销返回 401 并清除无效 Cookie，不在同一请求静默签发新身份。之后可重新 bootstrap；旧记录不迁移或删除。

服务端专用接口前缀为 `/api/internal/agent-public/v1`，均为 POST，要求 `x-agent-service-token`。`introspect` 接受 `{bearer}`；`authorize` 接受完整 `{identity}`；`model` / `search` 接受 `{authorizationId,runId,operationId,input}`。请求与响应受大小限制，错误不转发上游正文，禁止重定向与自动重试。服务凭据不能替代有效访客授权。

## 验证记录

本轮使用 Windows PowerShell、仓库固定 Node 22.23.2。

| 检查 | 本轮结果 | 证据范围 |
| --- | --- | --- |
| `npm run typecheck` | 通过 | 全 workspace 类型检查 |
| `npm run lint` | 通过 | 全仓库；修正既有工作台脚本一处未使用全局声明 |
| `npm test` | 41 个测试文件、206 项通过 | 真实共享引擎/SQLite，模拟平台/模型；包括本地端回归 |
| `npm run build` | 通过 | 全 workspace、UI 与 CLI 构建 |
| `node scripts/smoke-cloud.mjs` | 通过 | Windows 真实进程/loopback HTTP；启动、health、缺少授权、平台不可达时拒绝执行 |
| backend Compose 配置/构建 | 通过 | 项目开发 Dockerfile、隔离测试网络 |
| backend 相关测试 | 81 项通过 | 真实 MySQL/FastAPI，模拟成员资料、模型与检索；授权隔离、并发去重、未知状态、撤销、次数上限、CSRF、费用归属 |
| backend 启动检查 | 通过 | 完整应用启动、HTTP health、OpenAPI 新路由、默认关闭边界；使用隔离测试库 |
| 文档与 diff | 36 个本地文档链接有效；`git diff --check` 通过 | 文档指向和改动格式；不包含生产验收 |

没有实际供应商模型调用或生产数据库访问。独立适配器测试不等于两个真实服务与官网浏览器的端到端验收。

```powershell
# Harness，Windows 根 checkout
npm run typecheck
npm run lint
npm test
npm run build
node scripts/smoke-cloud.mjs

# 主平台 backend，Windows Docker Compose；无真实配置/外网 provider
docker compose -f docker-compose-agent-test.yml config --quiet
docker compose -f docker-compose-agent-test.yml build agent-tests
docker compose -f docker-compose-agent-test.yml run --rm agent-tests
docker compose -f docker-compose-agent-test.yml run --rm agent-tests python tests/smoke_agent_public.py
docker compose -f docker-compose-agent-test.yml down
```

## 待完成的独立阶段

计费单位已确定为积分，1 元＝100 积分；规则与余额由主平台拥有，Harness 不单独定价。统一单位不合并 Story 预付账户和 Builder 授信，也不等于付费插件已接通。见 [ADR-0009](adr/0009-unified-credit-unit.md)。

官网已经接入，支持公开来源展示、多轮对话按时间顺序恢复，真实配置与模型链路已验收。个人/企业空间与应用权益适配、Story/Youji 长任务、金额冻结与结算、同账号跨应用记忆接入、Builder 构建/客户运行身份、Harness MySQL 多 Worker 调度尚未交付。现有记忆类型不是跨业务记忆服务，费用归属日志不是统一钱包扣费。后续按 [路线图](ROADMAP.md) 实现业务工具并自动继承账号完整权限；现有只读接口不会因文档规则自动具备写入能力。

决策依据：[ADR-0006](adr/0006-shared-engine-cloud-foundation.md)、[ADR-0007](adr/0007-company-public-platform-adapter.md)、[ADR-0008](adr/0008-platform-public-bridge.md)。
