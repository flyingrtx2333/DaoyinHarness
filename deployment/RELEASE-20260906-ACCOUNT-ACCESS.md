# 2026-09-06 同账号访问上线

用户明确授权 Git 提交、推送和生产部署，并要求将 Harness 相关工作区改动全部提交。

入口：[登录并返回赛事工作台](https://www.daoyintech.com/api/agent-apps/saishi/workbench/login)，[赛事工作台](https://www.daoyintech.com/harness/?app=saishi)。使用已有道引账号，无需签发或粘贴 Agent 凭据。

## 版本与交付

- Harness 账号访问提交：`d7d5844d9fda69b1333007a992d5217489eed67e`。
- Harness 内核、本地工作台、账号隔离、云端界面与相关证据统一提交：`843bdb5699b4f8757b1168bf6ad53fc59415c08a`，已推送。收尾新增首页登录/注册入口的提交为 `36881baa1af4b7f1b50fccfb4ce827757087c36e`，已推送并作为最终工作台静态版本上线。
- 主平台、赛事后端、官网和赛事前端均发布自 `758d63c28645a8e1202fa550b366b4b3e25adbbb`。
- 生产主平台与赛事容器镜像已核对，并将各自 `.env` 的 `BACKEND_IMAGE` 固定为该提交，避免以后 Compose 启动回退旧版本。
- 云端 systemd 运行时也已切换至 `843bdb5699b4f8757b1168bf6ad53fc59415c08a`。`main.mjs` 的 Windows 与服务器 SHA256 均为 `7f4cfcb6aa059431dd14c535c7d058fe41e9f597a84a2db53d0bb81349088eb3`。Fastify 5.12.1 与旧版一致，复用旧版只读依赖目录。旧运行时 `f711e83a3ad65c34b650d0a15214b677a37f0b10` 保留用于回滚。

GitHub 发布任务均成功：[主平台](https://github.com/flyingrtx2333/daoyintech/actions/runs/34015013015)、[赛事后端](https://github.com/flyingrtx2333/daoyintech/actions/runs/34015014978)、[官网](https://github.com/flyingrtx2333/daoyintech/actions/runs/34015157774)、[赛事前端](https://github.com/flyingrtx2333/daoyintech/actions/runs/34015160762)。赛事 CI 保留并通过容器测试，没有跳过测试。

## 数据与线上验证

主平台部署流程已包含 `20260906_saishi_agent_grants.sql` 和 `20260906_harness_account_sessions.sql`。生产查询确认 `agent_app_grants`、`first_party_account_sessions`、`agent_account_grants` 存在，账号访问开关与赛事模型绑定启用。迁移新增账号会话和内部身份关联表，不修改用户原有业务权限，也不迁移历史数据。

主平台 `6087/health`、赛事 `6089/health` 均为 ok；Harness `4700/health` 为 available。匿名赛事 bootstrap 返回 401 与固定登录入口；无有效账号不能建立账号会话，外部 Origin 返回 403。

首次单实例租约升级前确认没有 queued/running 任务，停止旧服务并确认退出，通过 SQLite backup API 备份会话库，再切换版本并启动。数据库 quick_check 为 ok；切换前后会话/任务/事件分别保持 9/18/76 条，长期记忆为 0 条；新租约有效，启动日志确认没有遗留任务需中断，没有重放外部操作。备份文件为服务器备份目录内的 `public-before-runtime-843bdb5.sqlite`，仅 root 可读。

随后运行明确启用的 `scripts/smoke-public-production.mjs`：真实公开资料问答 `run_a5db54ce-275b-4748-83e9-cd2ed6cdc698` 完成，包含 `turn.started → tool.started → tool.completed → assistant.delta → turn.completed`。重复 requestId 返回同一任务，未认证请求拒绝，事件回放及第二个任务的取消通过。该检查产生新的公开访客验收会话，未读取私人赛事数据。

最终工作台版本目录 `/opt/daoyin-harness/workbench/releases/36881baa1af4b7f1b50fccfb4ce827757087c36e`。服务器与 HTTPS 下载均与 Windows 固定提交产物一致：

| 文件 | SHA256 |
| --- | --- |
| `index.html` | `c8273cb0a1a65a39781642a7c33ca57957562dd578b95087bbfba9f12c351357` |
| `workbench-TGM2BM7U.js` | `353796957a7aeb61531ceb1ba3afd29fd63b40d991226a6e744d621d6ab65f65` |
| `workbench-XEPLC4U2.css` | `cd3df3584b5df8c95eae7bd8a5fd9076629c60c296b83f7f917ecb7dfbc6b7be` |

真实 Windows Edge 在 1280px 与 390px 检查：首页有登录/注册入口，赛事页显示“登录道引账号”，没有授权凭据表单；点击进入平台登录页，返回地址为 `/harness/?app=saishi`。页面无 JavaScript 错误，无横向溢出。HTTPS HTML 的 no-store/CSP 与四项资源哈希均通过。截图和报告位于本机 `.cache/account-production-20260906/`。

Windows 全仓 typecheck、lint、293 项测试、build 通过；工作区浏览器 7 项、账号访问模拟浏览器 9 组、主平台相关测试 34 项、赛事专项 3 项、登录页 6 项通过，详见 [验证记录](../docs/VALIDATION-20260906.md)。模拟平台账号切换/退出不等同真实账号登录。未代替用户登录或读取私人赛事数据；生产账号 Cookie、该账号实际业务范围和私人赛事问答由用户登录后试用确认。

## 回滚

旧工作台版本 `70061947e58ec61afda8a9a7203d797af56ee282` 保留，静态资源长期保留；旧后端镜像为 `8ab0b0aebfbf78b3226b7bd37bf87ce9e9e71a8b`。发布前的服务配置、会话库备份和链接记录保存在服务器 `/var/backups/daoyin-agent/account-access-20260906/`，目录仅 root 可访问。回滚需协调工作台与主平台账号接口；回滚内核时必须先停止新进程，不能让新旧进程同时访问会话库。保留新增表和历史数据，不删除用户会话。
