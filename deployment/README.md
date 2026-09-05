# 单实例官网发布

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
