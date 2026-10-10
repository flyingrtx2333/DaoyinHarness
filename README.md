# DaoyinHarness

DaoyinHarness 是道引统一 Agent 平台的共享执行内核。当前产品入口是服务器上的 [云端工作台](https://harness.daoyintech.com/)，使用现有道引账号登录。主平台负责身份、空间、应用安装、授权、模型路由和计费；业务服务负责资源与任务状态；Harness 负责受控执行、上下文和不可变事件记录。

本地产品路径已经废弃，历史 CLI 和本地服务包保留用于兼容与溯源，不是当前产品验收入口。不要通过放宽本地 Host/Origin 校验恢复远程访问。详见 [ADR-0026：云端产品入口与验证](docs/adr/0026-cloud-only-product-and-validation.md)。

## 执行边界

- `AgentEngine` 装配模型上下文、执行已注册工具、记录进度与结果；代码、网站和预览只是可选能力，内核不绑定任务类型。
- 云端会话、运行和事件通过 `CloudRepository` 持久化。事件先存储再推送，刷新与重连从 `eventSeq` 继续读取；派生摘要不能替代原始事实。
- 工具由 capability registry 和业务 profile 装配。资源路径、身份、租户、风险策略和取消检查在执行边界生效。
- 模型请求通过主平台验证的执行授权与 AI Gateway，供应商密钥不进入 Harness 或浏览器。
- 登录后的业务插件继承当前账号已有的业务权限。无需逐插件授权或粘贴凭证，仍保留资源隔离与用量记录，详见 [完整权限规则](docs/adr/0012-first-party-account-access.md)。

任务依次记录 `turn.started`、模型请求与回复、`tool.started`、工具完成或失败、最终回答及终止状态。模型可见的工具结果受上下文预算约束，完整工具证据保留在事件记录中。取消停止未来工具工作，失败不抹去已完成操作；恢复不能重放已经成功的业务操作。

## 数据与安全

会话事实只追加，压缩摘要包含来源事件范围。能力定义的检查点与工件保留其证据和版本，失败不能覆盖最后一个有效结果。相同受保护资源上的修改串行执行。

本地历史运行时使用 JSONL 事实记录和可重建的 SQLite 索引；云端使用事务内追加的 SQL 事件。单实例 SQLite 不代表生产分布式调度能力。工作区访问须验证路径和符号链接边界，进程使用明确的目录、参数及资源限制。

项目采用净室实现。`claude-code-main/` 是只读研究材料，不是代码基础，不进入 Git、npm 包或发布产物。

## 开发与验证

技术基线为 Node.js 22 LTS、ESM、TypeScript strict、npm workspaces、Fastify、React 和 Vite。依赖锁定在 `package-lock.json`。

```sh
npm ci
npm run build
npm run start:cloud
```

云端启动所需身份、平台授权和存储配置见 [部署说明](deployment/README.md)。启动服务或构建通过本身不证明模型、账号或工具可用。`npm start` 和 `npm run dev` 仍是历史本地 CLI 命令。

按修改范围选择必要的类型、lint 或构建检查。行为验证只允许小样本真实模型，通过实际账号、AI Gateway、Agent、工具和存储链路，详见 [测试规则](docs/TESTING.md)。报告必须记录确切运行版本、环境、模型、输入、真实工具操作、持久化状态、结果、耗时和可获取的用量或费用。

`npm test` 与 `npm run smoke:runtime` 均由规则入口阻止，不执行测试，也不表示测试通过。历史模拟脚本与测试文件保留用于溯源，不能直接运行或作为当前验收依据。现有真实验证入口包括：

- `scripts/verify-cloud-long-task-live.mjs`：真实云端任务。
- `scripts/verify-model-closure-live.mjs`：正常任务与额度收尾。
- `scripts/run-swebench-cloud-live.mjs` 和 `scripts/grade-swebench-cloud-live.mjs`：普通云端工作区执行与官方 SWE-bench grader。

脚本的执行参数、预算和环境前置条件以对应脚本为准。SWE-bench 使用冻结的基础版本和实际工作树补丁，不为评测增加专用内核行为。

## 发布边界

源码、真实模型验证、提交推送和部署分别报告。生产 checkout 位于服务器 `/root/DaoyinHarness`，实际运行版本通过运行时接口确认；历史上线记录不能代表当前版本。部署必须使用已推送的确切提交，服务端构建带版本标记的产物，再验证公开健康与版本。UI 单独发布不重启 Agent。

## 文档

- [统一 Agent 平台与能力边界](docs/UNIFIED-AGENT.md)
- [云端产品入口与验收](docs/adr/0026-cloud-only-product-and-validation.md)
- [业务插件与权限规则](docs/PLUGINS.md)
- [安全模型](docs/SECURITY.md)
- [测试与可靠性](docs/TESTING.md)
- [部署与运行说明](deployment/README.md)
- [架构决策记录](docs/adr/)

文档中的历史方案与验收结果保留其日期和版本，当前规则以 `AGENTS.md`、测试规则和后续 ADR 为准。
