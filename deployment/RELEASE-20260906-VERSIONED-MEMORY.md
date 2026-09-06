# 版本化云端记忆上线记录

2026-09-06，按用户授权发布云端版本化长期记忆。此记录区分已上线的 Harness 运行时、主平台仍需提供的权限和同源管理入口。

## 版本与切换

- 功能提交：`e8de12734b4c8f501071cbf8be9c3af6b409d531`（`feat: add versioned cloud memory`）。
- 发布产物修复：`f711e83a3ad65c34b650d0a15214b677a37f0b10`（`fix: include lockfile in cloud release`）。它将根 `package-lock.json` 纳入运行时产物，避免每个不可变发布目录缺少 Fastify 运行依赖。
- 实际运行版本：`f711e83a3ad65c34b650d0a15214b677a37f0b10`；服务目录为 `/opt/daoyin-harness/releases/f711e83a3ad65c34b650d0a15214b677a37f0b10`，`current` 已原子切换至该目录。
- 切换前版本：`70061947e58ec61afda8a9a7203d797af56ee282`，仍保留在 releases 目录，可作为回退目标。
- `main.mjs` SHA-256：`19c3d36ab0ab87ced6ee5b5b5256c12d5136c33828a008b88a0e474a540c9e6c`。
- `package-lock.json` SHA-256：`bddeb9ac0ecf885ac7daa7c9922ff3c16014390839517a38fdf0ed08e3242d45`。部署前用该锁文件执行了 `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`；运行时 Node 为 22.23.2。

首次向 `e8de127` 目录切换时，因旧构建没有携带锁文件和 `node_modules`，启动时无法解析 `fastify`。切换脚本立即恢复到 `7006194`，服务健康；该失败版本没有成为线上运行版本。随后补充锁文件并在新目录完成依赖安装，才切换到 `f711e83`。

## 运行验证

- `daoyin-harness-cloud` 为 `active`，进程监听回环 4700。
- 直接 `/health` 返回 `{"status":"available","mode":"cloud-foundation","productionReady":false}`。
- 未认证访问 `/api/v1/cloud/memories/capabilities` 返回 401 `AUTHENTICATION_REQUIRED`，没有开放匿名长期记忆。
- 服务器当前 `main.mjs` 哈希与 Windows 从提交对象构建的产物一致。

## 代码验证

- 干净的 `e8de127` 候选目录中，四个记忆测试文件共 28 项通过。
- `@daoyin/harness-agent-core` 和 `@daoyin/harness-server-cloud` 类型检查、记忆相关 ESLint、云端服务构建均通过；全仓库 ESLint 也通过。
- 全仓库类型检查和构建仍被既有的 `packages/server/src/app.ts` `RuntimeBootstrap.authentication` 缺失阻断；全仓库测试为 204/205，通过外另有一个 Windows 上错误期待 `/usr/bin/google-chrome` 的浏览器发现测试失败。它们不属于本次记忆或发布工具改动。

## 已上线范围与后续边界

运行时已包含确认式版本化记忆、个人/应用/组织范围、修订与撤回、共享授权门禁、引用回执、审计读取，以及在模型回复和工具执行前复查记忆有效性的保护。记忆管理路由只能由已认证身份调用，模型不能直接写入或选择跨空间记忆。

主平台尚需签发 `memory.read`、`memory.write`、`memory.share` 等权限，并提供同源 BFF 映射、跨应用目标安装核验和用户确认界面。没有这些平台配置，当前发布不表示真实用户已经能在网站界面管理或跨应用使用长期记忆；也未执行真实模型调用或真实用户授权验收。
