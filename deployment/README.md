# 单实例官网发布

## 当前服务器发布（2026-09-07）

当前线上使用 PostgreSQL 和专用 `daoyin-harness-cloud.service`，不是下文早期试运行的 SQLite。`/etc/daoyin-harness/cloud.env` 保持原样，服务运行于 `/opt/daoyin-harness/current/main.mjs`，Node 为 `/opt/daoyin-harness/node/bin/node`。工作台地址为 `https://www.daoyintech.com/harness/`。

独立 Linux 服务器副本可显式使用 `--server-linux` 构建已提交的 HEAD；Windows/WSL 共用目录仍遵守根目录限制。不运行模拟测试或全量回归。下述脚本不自动迁移数据库；会话管理发布已先显式完成 PostgreSQL 迁移，证据见 [会话管理](../docs/SESSION-MANAGEMENT.md)。当前开发位置是 `root@42.194.159.81:/root/DaoyinHarness`，分支 `main`：

```text
/opt/daoyin-harness/node/bin/node scripts/inspect-live-deployment.mjs
/opt/daoyin-harness/node/bin/node scripts/build-cloud-release.mjs --server-linux
/opt/daoyin-harness/node/bin/node scripts/build-workbench-release.mjs --server-linux
/opt/daoyin-harness/node/bin/node scripts/deploy-existing-server.mjs --apply <完整提交SHA>
```

发布脚本核验产物哈希，安装生产依赖且禁止安装脚本，在切换前拒绝仍有活动 Run 的情况。保留旧版本目录与旧哈希资源，先停止旧实例，再切换运行时链接并启动，readiness 正常后切换工作台链接。核对公网 release.json、HTML 与静态资源哈希、匿名 API 401。失败时恢复旧链接并重新启动旧版本，不回滚或删除用户数据。部署日志位于 `/opt/daoyin-harness/deployments/`，不包含密钥。

上述为真实部署与健康检查，不是模型效果测试。需要功能验收时，仅用小样本真实模型和实际业务链路；不得由健康检查推断私人记忆授权已接通。不要改主平台权限、Nginx 或其他业务服务来掩盖上游配置缺失。

## 测试评估是独立部署单元

`deploy-existing-server.mjs` 只切换聊天运行时与静态工作台；即使产物包含 `evaluation.mjs`，也不会安装或启动评估服务，更不会安装其 Nginx 转发。聊天健康与静态资源检查通过不能作为评估页面可用的证据。

评估部署需分别核验 `daoyin-harness-evaluation.service`、`/opt/daoyin-harness-evaluation/current`、独立环境与存储、回环端口 4711，以及主平台配置对应的 `/api/internal/harness-evaluation-runner/` 路由。不要把 Docker 容器自己的 `127.0.0.1` 当成宿主机，也不要复用云端数据库或绕过超级管理员鉴权。

2026-09-07 只读排查：聊天运行时和工作台均为 `8920d517623356d475406695fa1979d88d8b0796`，主平台后端镜像为 `23439b75eb5db6f50d16c0d8105da7eea48c2d11`；评估 systemd 单元不存在、版本链接缺失、4711 拒绝连接，配置中的 runner 的 catalog 与 health 路径均返回 404。独立环境文件存在且服务凭据与主平台一致，但模型 endpoint/key/name 均未配置。凭据仅在进程内比对，不输出其值；未执行模型、部署或迁移。

前端初始化应区分加载、成功和失败；失败后停止加载提示，展示配置／路由故障并允许只重试读取配置，不创建或重提交实验。历史读取应等待配置成功，避免覆盖初始化失败原因。主平台应区分固定评估端点缺失和一般上游不可用，不把这些故障统一解释成实验失败。

正式验收仍需授权账号下的真实小样本；旧回放模式及伪造业务结果不是替代方案。`deploy-evaluation-release.py` 的写入子命令包含配置、Nginx 和服务切换，仅在明确授权并审查其历史发布假设后执行；本次未执行。

## 真实评估补部署流程（v2）

2026-09-07 已补齐并上线，真实管理员目录读取和两条实际模型任务已验证；版本、实验编号和验收边界见 [发布记录](RELEASE-20260907-EVALUATION-LIVE.md)。上节的缺失状态为修复前诊断。

当前评估执行入口已改为 `PlatformEvaluationRuntime`：经主平台内部 `/api/internal/harness-evaluation/runtime` 使用当前管理员账号的实际云端会话、业务工具和网关模型。独立评估环境不再需要模型 endpoint/key/name，禁止复制供应商密钥。旧回放与隔离业务夹具只保留历史源码，不从服务执行入口调用；每批最多五次真实试验，业务正确性待复核、召回真值缺失时标记未测。

协调发布主平台后端 `harness_evaluation_live.py` 和 Harness 的单轮调用上限后，先用上述普通脚本发布已提交的运行时与工作台，再执行：

```text
python3 scripts/activate-evaluation-only.py --apply <同一完整提交SHA>
```

此步骤只安装／切换独立评估服务和官网已有 extension 目录中的专用 Nginx 路由，备份原配置、校验产物哈希与两端服务凭据一致，拒绝打断活动实验；失败恢复原服务配置和链接，不迁移或删除业务数据库。4711 健康应返回 `execution: platform-runtime-only`，公网 runner 匿名请求应为 401，而不是 404。之后还须通过实际管理员鉴权读取 catalog，并用授权小样本验证真实模型、事件和网关调用计数；健康检查不代表模型或业务成功率通过。

## 设置页版本信息

工作台的“账号菜单 → 设置 → 关于道引 Harness”显示当前前端包的版本号、提交短码和更新时间。版本号来自仓库根 `package.json`；正式云端构建读取目标 HEAD 中的版本和源码，不混入工作区修改。完整提交号可在版本提示中查看。

`build-workbench-release.mjs` 在构建开始时生成一次 `builtAt`，将同一份 `version`、`revision`、`builtAt`、`channel` 注入前端并写入 `release.json`。界面以 UTC+8 显示构建时间，明确它不是页面刷新时间、进程启动时间或部署切换时间；重新构建会更新，刷新页面不会改写，回滚则显示被恢复的包自身信息。

`--preview` 产物明确标记“预览构建”。Vite 开发环境不伪造更新时间；Vite 打包也注入版本信息，工作区未提交或无法确认 Git 状态时标记为预览。缺失元数据时显示“未提供”或“开发环境未构建”，不取浏览器当前时间充当发布信息。本改动只涉及前端与打包元数据，不更改后端 API、授权或数据库。

## 早期试运行记录（历史参考，不作为当前配置）

下文的 SQLite、Windows 全套测试要求已经过时。测试规则以 `AGENTS.md` 和 `docs/TESTING.md` 为准，数据库以当前生产 PostgreSQL 为准。

本目录部署共享 AgentEngine 的官网只读 Profile。服务监听主机回环 4700，
由现有官网 HTTPS 代理。主平台保管访客 Cookie、授权、配额和费用记录。
SQLite 与服务分离保存在 `/var/lib/daoyin-harness`；只允许一个 Worker。
`productionReady: false` 表示尚未提供通用多租户生产集群能力，不表示健康检查失败。

## 构建与发布

在 Windows 根工作区完成 typecheck、lint、test、build 并提交后运行
`node scripts/build-cloud-release.mjs`。脚本直接读取 HEAD 对象，输出到
`.cache/cloud-release/<commit>`，不会将共享工作区其他修改打入包。
在该产物目录用 `npm install --package-lock-only --ignore-scripts` 固定 Fastify 运行依赖；
上传 main.mjs、package.json、package-lock.json、release.json 到服务器版本目录。
服务器使用经官方 SHA256 校验的 Node 22.23.2，执行 `npm ci --omit=dev --ignore-scripts`。

安装本目录 systemd 单元。使用专用无登录用户 daoyin-agent；版本目录只读，
`/etc/daoyin-harness/cloud.env` 仅 root 可读，必须设置：

```text
DAOYIN_CLOUD_PLATFORM_URL=https://www.daoyintech.com
DAOYIN_CLOUD_DATABASE=/var/lib/daoyin-harness/public.sqlite
DAOYIN_CLOUD_PORT=4700
DAOYIN_CLOUD_SERVICE_TOKEN=<服务器生成的服务凭据>
```

平台 `.env` 配置对应服务凭据、显式有效的官方付款租户/用户、策略版本、
`AGENT_PUBLIC_ORIGIN=https://www.daoyintech.com`、
`AGENT_PUBLIC_CLOUD_URL=https://www.daoyintech.com`。先启用 AGENT_PUBLIC_ENABLED，
验证真实 BFF 问答后再启用 AGENT_PUBLIC_WEBSITE_ENABLED。
将 nginx-cloud.conf 放入官网现有 server include 目录；检查 nginx 配置后 reload。
不复制或修改证书。无凭据的云 API 必须返回 401。

平台迁移与发布由 DaoyinTechnology 的 deploy.yml 手动指定 backend 执行，
官网由 deploy-frontend.yml 手动指定 frontend 执行。共享仓库发布提交使用
`[skip ci]` 避免其他业务触发自动发布；手动工作流仍运行。

## 验收与回滚

核对 backend 镜像 SHA、三个 agent_public 表、systemd 状态、运行产物 SHA，
通过官网 bootstrap → session → run → events 验证真实模型与公开检索。
检查同 requestId 复用 Run、跨访客拒绝、取消终态、刷新后事件回放及用量归属。
仅健康检查或 CI 成功不能证明真实问答通过。

变更前保存 backend 镜像标签、环境文件、Nginx include 和官网静态资源。
回滚先关闭 AGENT_PUBLIC_WEBSITE_ENABLED，再恢复官网资源/后端镜像和服务 current 链接。
保留新增表、SQLite 和已有事件；不通过删除数据回滚。
异常退出遗留的 running 任务须先确认旧进程已经停止，再使用
SqliteCloudRepository.recoverInterruptedRuns 标记中断；禁止重放模型或工具操作。
