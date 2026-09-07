# 2026-09-07 自主记忆验证记录

> 历史记录：以下执行发生在所有者禁止模拟测试之前，保留用于追溯，不代表后续要求或真实模型验收。新的长期规则是“禁止模拟测试，需测试时仅用小样本真实模型”，见 [TESTING.md](TESTING.md)。本次规范更新及 Git 提交不重跑这些测试。

## 范围与环境

本记录对应服务器 `/root/DaoyinHarness` 的独立上传副本，Node.js `v24.14.0`，Vitest `4.1.11`。没有在 Windows/WSL 共享工作区运行本轮验证，不能将这些结果标记为 Windows 验收。没有真实模型调用、主平台真实账号授权联调、生产数据库迁移、部署、服务重启或 Git 提交。

原有 `packages/ui/src/cloud/ToolActivity.tsx` 用户修改未编辑。原业务 `acceptRun -> startRun` 单实例启动流程、本地 JSONL 记忆和平台认证凭据未改变。

初始上传未含测试依赖，首次测试报 `MODULE_NOT_FOUND`。随后执行 `npm ci --ignore-scripts --no-audit --no-fund`，安装 370 个依赖，未运行包安装脚本。

## 最终执行结果

| 检查 | 结果 |
| --- | --- |
| `npm run build` | 通过；全部 workspace、前端和 CLI 构建完成 |
| `npm run typecheck` | 通过；全部 workspace 类型检查完成 |
| `npm run lint` | 通过 |
| 配置隔离测试库后执行 `npm test` | 72 个文件、399 项测试全部通过，无跳过 |
| 单独 PostgreSQL 集成套件 | 8 项通过，其中 1 项为新增自主记忆事务测试 |

最终全量测试的终端摘要为：

```text
Test Files  72 passed (72)
     Tests  399 passed (399)
```

在没有测试库环境变量时，PostgreSQL 套件会跳过；本次最终结果已包含真实隔离 PostgreSQL 执行，不使用此前跳过结果代替。Node 内建 SQLite 提示 experimental warning，不影响退出码与断言。

## 真实数据库验证隔离

复用服务器已有 `postgres:16-alpine` 镜像启动临时容器 `daoyin-memory-test-20260907`，限制内存 256 MiB、CPU 1，只发布动态 localhost 端口，无用户数据卷或生产凭据。测试数据库名为 `harness_memory_test`，套件每次创建并删除独立 `harness_test_*` schema。测试中旧 SQLite 导入的 1 行仅来自自动生成的临时 fixture，不是用户历史数据。

实际测试期间仅向测试进程传入 `DAOYIN_TEST_POSTGRES_URL`，没有设置或覆盖生产 `DAOYIN_CLOUD_POSTGRES_URL`。完整套件内部的 SQLite 导入测试会临时将自己的进程变量指向这个测试库并恢复；其他服务进程的环境不受影响。不要把此测试流程指向生产 URL。

验证完成后执行 `docker stop daoyin-memory-test-20260907`；容器使用 `--rm`，不保留测试运行实例。测试用 trust 认证仅用于这个空的、临时的 loopback 测试实例，不是部署配置。

## 本轮新增 22 项测试

`packages/server-cloud/src/memory-autonomy.test.ts`：19 项，使用真实 Fastify 注入、共享 AgentEngine、工具注册表和临时 SQLite，身份、模型与业务响应为 test double。覆盖无逐条确认的写入、来源标记、默认偏好在无关新会话召回、同轮更正/忘记后继续业务、同一回合新增更正忘记、显式搜索的撤销依赖、外部更改拦截、业务工具来源、无效引用/旧版本/越权字段、凭据正文及 key/关键词拦截、已忘记 key 不自动复活、投递幂等、无工具委托或只读身份、匿名隔离、重启持久化及参数边界。

`packages/server-cloud/src/memory-platform.test.ts`：2 项。验证已有平台适配器可接收被委托的记忆工具，记忆执行留在 Harness，不发送到业务 `call`；缺少对应权限时不接受工具委托。HTTP 传输是模拟响应，不是真实平台联调。

`packages/server-cloud/src/postgres-repository.test.ts`：新增 1 项真实 PostgreSQL 测试。验证立即生效、相同请求复用、不同内容冲突、旧快照失效、自主更正后的新上下文、同轮遗忘、旧请求不复活及他人来源被拒绝。原有 7 项 PostgreSQL 测试也通过。

## 调试中发现并修复的问题

首次自主写入已成功落库，但刷新回执被原有“完整工具请求/结果组”校验拒绝。修复为受预算控制的独立运行时回执，不放宽原有工具消息配对规则。新增测试同时修正了事件读取遗漏游标和测试 requestId 过度推断为 UUID 字面类型的问题。

PostgreSQL 准备上下文时的依赖校验复用事务内客户端，避免持有事务连接又借用连接池检查。凭据检测扩大到正文、key 和关键词。所有更改之后重新通过类型、构建与全量测试。

## 未验收或明确未实现

这些测试证明流程和约束，不证明真实模型能正确判断所有长期价值、临时例外或同义表达。还需真实账号与模型评估写入精度、误记率、语义召回、成本和响应延迟。

主平台真实账号的 memory 权限、工具委托以及模型网关是否接受这些能力尚未线上验证；缺少委托时内核不会擅自升级权限。跨应用自动互通、用户管理页面、已忘记条目的聊天恢复授权、语义级去重/遗忘、依赖感知摘要，以及轮后自动整理并不属于本轮完成项。

参见 [当前记忆系统](MEMORY-SYSTEM.md) 与 [ADR-0018](adr/0018-autonomous-cloud-memory.md)。
