# 营火能力接入

2026-10-09：三个仓库的接入代码已提交、推送并完成已授权的协同发布；真实模型验收待账号登录和安全资源具备后进行。精确版本和证据边界见末尾发布记录。

## 可用范围

复用营火已有远程 MCP 和业务 API，不另造制作引擎。

| 范围 | 工具 |
| --- | --- |
| 店铺与资料 | `yinghuo_list_shops`、`yinghuo_get_profile` |
| 素材与参考 | `yinghuo_list_assets`、`yinghuo_list_references`、`yinghuo_list_templates` |
| 任务与草稿 | `yinghuo_list_tasks`、`yinghuo_get_task`、`yinghuo_get_production` |
| 制作与修改 | `yinghuo_create_video`、`yinghuo_modify_video`、`yinghuo_resume_video` |
| 排队与导出 | `yinghuo_get_queue`、`yinghuo_cancel_queue`、`yinghuo_export_package` |

道引账号继续使用已有账号密码登录。已有营火连接直接复用；第一次连接时，在保留道引登录的浏览器中登录／刷新营火页面，两端有效登录自动关联。无需复制 MCP 凭证或申请 Agent 专用权限。两个账号的验证、空间隔离及不采用手机号推测关联的原因见 [ADR-0032](adr/0032-yinghuo-account-bridge.md)。

主平台向 Harness 返回营火工具与账号权限，执行时仍检查实际营火连接和资源。目录显示已启用表示服务端已经接入这些工具，不表示某个账号已完成营火自身登录。未连接、版本冲突、预算不足与上游失败保留在普通助手错误文本中；不存在失败后切换公共身份的路径。

创建任务使用 `requestKey` 防重复；修改要求当前 `revision`；未知结果不自动重试。导出必须通过营火现有当前版本人工审核，下载仍要求营火账号登录，不自动发布。模型调用归属原道引工作台账本，业务制作归属原营火账号预算；业务日志保留 Harness Run 与操作标识。

## 代码与发布边界

| 仓库 | 变更 |
| --- | --- |
| DaoyinHarness | 14 工具固定契约、统一 Profile 装配、写操作策略、错误传递、服务端工具驱动的插件状态 |
| daoyintech | 营火工具目录与 MCP 桥接、账号权限派生、服务端有效账号／授权解析 |
| yinghuo/campfire-video-platform | 双登录自动关联、连接表、逐请求身份核验、MCP 内部 API 身份传递、账号操作串行化、现有网页登录后的自动连接 |

配置全部在服务端，不进入 UI 构建变量：

| 环境 | 配置 |
| --- | --- |
| 主平台 | `AGENT_YINGHUO_ENABLED=1`、`YINGHUO_AGENT_URL=https://yinghuo.daoyintech.com`、`YINGHUO_HARNESS_SERVICE_TOKEN` |
| 营火 | `YINGHUO_HARNESS_ENABLED=1`、`YINGHUO_HARNESS_PLATFORM_URL=https://www.daoyintech.com`、相同的 `YINGHUO_HARNESS_SERVICE_TOKEN`；保留现有 phone 登录 |

服务密钥使用独立随机值，与 `AGENT_APP_SERVICE_TOKEN`、营火访问口令、账号密钥和知识库密钥隔离。营火连接表 SQL 为 `yinghuo-app/migrations/20261009_harness_accounts.sql`，应用到现有 **phone-auth 数据库**，不改动旧用户、成员关系、凭证或客户素材。本次已显式应用 SQL 并写入服务端配置；连接密钥未进入浏览器构建。

本次在独立 Linux 服务器使用固定 Node 22 完成发布检查；Windows 连接不可用，未进行 Windows 验证。三个仓库的功能提交均已推送。保留原镜像、发布目录、环境和路由作为回退依据。已更新主平台共享 API 容器、营火 API 与静态 UI，以及 Harness runtime 与静态 UI；营火渲染 worker、数据库及其他业务服务未重启。主平台与 API 单实例切换可能短暂中断，不能宣称零中断。

本轮核对的营火 `index.js`、`phone-auth.js`、MCP client，以及主平台 `agent_app_access.py`、`harness_agent_bridge.py`、`agent_apps.py` 的原始 Git 版本与实际运行文件 hash 一致；其他文件及模板 overlay 不因此视为一致。主平台运行目录 `/www/wwwroot/daoyintech/backend` 不是可用 Git checkout，发布必须按实际镜像来源保留 overlay，不能把它当作完整源码权威。

## 本轮检查与待验收

macOS / Node v26.8.1：Harness server-cloud 与 UI 的局部 TypeScript 检查、改动文件 ESLint、营火 UI TypeScript 检查、营火服务 JS 语法、主平台 Python AST 语法和三个仓库 diff 检查通过。它们是静态检查，不能替代真实模型行为证据；本次固定 Node 22 的独立 Linux 检查见下方记录；没有运行模拟、预制响应或旧测试套件。

营火 UI 的局部 ESLint 仍有既有 `react-hooks/set-state-in-effect` 错误，位于原有评测权限 effect 的 `setCanEvaluate(false)`；本轮新增 effect 的依赖警告已修正，不扩展修改评测页面。

真实模型验收尚未执行；静态检查与部署健康不能代替业务行为证据。发布后使用授权测试账号和安全资源，只选三个只读实际模型场景：

1. “列出我的营火店铺，并读取其中一个店铺资料。”核对实际店铺／资料工具、返回账号资源和 Harness 持久化事件。
2. “查询该店铺的实拍素材、参考和模板，不制作视频。”核对三个真实业务工具，明确素材与参考的区分。
3. “列出该店铺现有制作任务，读取一个任务和草稿进度，不修改或继续制作。”无任务时如实记录跳过草稿查询，不伪造任务数据。

另外检查未连接提示、退出／切换道引账号后的旧执行身份拒绝、不同账号／店铺隔离及桌面和窄屏插件目录。创建、修改、继续制作和导出在未获相应测试资源、费用与交易授权时标为未验收，不能用只读样本证明这些操作成功。

每个场景记录三个精确代码修订、部署环境、实际模型、输入、工具动作、Run／操作 ID、持久化及真实业务结果、耗时、可获得的 usage／费用；缺失项写未知。默认先最多三个 Run，每 Run 沿用当前共享模型调用上限，获得当前模型计费与账号额度后再确定实际费用上限。不要在尚未有安全费用边界时调用真实模型。

## 发布检查

2026-10-09：独立 Linux / Node 22.23.2 的 Harness server-cloud 与 UI 局部类型检查通过。只包含本次营火改动的源文件参与检查，未混入同时进行的 Agent 核心工作。Windows MCP 连接连续返回内部错误，未声称完成 Windows 验证。

## 发布结果（2026-10-09）

- Harness 功能提交 `883434e5ebcb65b02ee7be0e1df05d30ba7d797f`，已包含在运行与公开 UI 的 `f828bb0f319792478e3b4575944c661d92b90341` 中。该后续提交属于同时进行的模型期限修复，未回退这项修复；本次 UI 切换未重启 runtime。
- 主平台桥接源为 `624d302a12dea5e4557976222b39506a824463c9`；营火桥接和 UI 源为 `17de6ba22cb82c3ce7589009403e35364839a604`。
- 主平台使用线上当前 `model-deadlines-8b34415a1c3b` 镜像的派生镜像，保留模型修复与模板等既有 overlay，只覆盖六个桥接文件。营火 API 保留实际旧发布目录 `app-20261005-836875b` 的业务代码与依赖，只覆盖四个桥接文件；UI 从已推送的营火 Git 对象在 Linux / Node 22.23.2 构建。
- 主平台运行配置已启用真实营火目录，实际进程返回 14 个工具定义；这属于目录检查，不是 Agent 执行证据。两端独立服务密钥匹配，静态构建未含此密钥。
- 营火服务端访问同机主平台使用 `http://127.0.0.1:6087`，主平台调用营火使用公开 HTTPS 地址。新增 phone-auth 连接表结构已核对，现有用户数量未变化，未迁移旧用户、凭证或客户资源。
- 主平台健康 200，营火公开入口 200，未登录 session 401；公开 Harness 修订、HTML 和资源 hash 通过，营火渲染后的 HTML 及新 JS/CSS hash 通过。初次发布校验误把原始 HTML 与营火已改写相对路径的响应比较，已自动恢复两个 API；修正校验后重新发布通过，保留失败与回退记录。
- 本次切换保护检查确认其他 Docker 容器及服务状态不变，营火渲染进程未重启。主平台旧镜像、Compose 组合与营火旧发布目录保留，可回退。
- Safari 实际访问了两端公开登录页面，选择了道引已有账号密码登录方式；两端均无可用登录。没有执行真实模型、双登录连接、账号隔离、付费制作或导出验收，没有执行模拟测试；登录后插件桌面／窄屏交互仍未验收。

服务器发布记录：`/root/DaoyinHarness/.cache/yinghuo-release/deployment-report.json` 与 `ui-deployment-report.json`；首轮回退记录为 `deployment-report-attempt1.json`。记录不包含服务密钥；含密钥的服务配置只保存在服务器受限文件中。
