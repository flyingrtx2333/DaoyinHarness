# 2026-10-10 文件编辑基础能力真实验收

最终代码与云端 runtime/executor：`20121af3aa419a2710fb80ac4adf12cc75898b0d`。真实四例全部通过。SWE-bench 包含此前 `f2be8565fd449a25ab10c873f757c5cd0b95b938` 和最终 `20121af3aa419a2710fb80ac4adf12cc75898b0d` 的两轮，分别记录。最终版本官方补丁评分 **1/3**，没有把此前 2/3 标成最终成绩。

## 实现与范围

- 文件修改返回实际 changed/no-op、前后摘要、有限修改范围与物理行预览；末尾换行不再制造虚假的空行。
- file_read 返回完整字节的版本摘要，并保留选中物理行的真实换行。二进制或超过文本预算但不超过 16 MiB 的文件返回大小、摘要和明确的内容不可用原因。
- 能力适配层保存当前运行的读取/修改观察并注入版本保护；模型无需复述摘要。未读或协作变更拒绝后重新读取。没有新增账号授权流程。
- 统一文本补丁在文件能力内部解析，不依赖语言镜像中的 Git；全部版本与上下文验证后逐文件原子保存。磁盘发布失败明确可能部分写入，不自动重放。保留未修改字节、权限和所有者。
- 实际新修改更新已有的轻量验证提醒；无变化不产生新提醒。内核不加入语言检查、固定测试命令或任务正确性状态机。共用调用上限保持原设置。
- 没有针对 SWE 题号、仓库或预期补丁加入提示或代码分支。未读取或导入 `claude-code-main/`。

## 最终部署版本的小样本

普通 daoyintech 账号，经公开云端工作台、真实 AI Gateway、Agent、工具和持久化路径运行；模型账单标识为 `deepseek / deepseek-flash`。每例最多 12 次共享调用、180 秒，测试输入为专用工作区内真实文件。没有伪造模型回复或业务响应。

| 场景 | 结果 | 共享调用 | 秒（含准备和验收） | runId |
| --- | --- | ---: | ---: | --- |
| edit-and-idempotence | passed | 8 | 32.879 | `run_d7993db0-fecc-4d29-b624-e9a83644877b` |
| stale-version-recovery | passed | 9 | 38.677 | `run_cfaadfca-d7bf-44bb-aacd-abce33990c67` |
| byte-preserving-edits | passed | 8 | 42.024 | `run_a2ff8d08-7123-4e2f-a628-54e8640de670` |
| unified-multi-file-edit | passed | 6 | 24.878 | `run_5850fa12-46f5-4c65-8c29-aadcc5218366` |

实际动作与验收：quantity 2→3 并再次幂等替换，真实进程计算金额 21；进程真实协作修改后旧版本补丁被拒，重读恢复并保留 collaborator；统一补丁保持混合 LF/CRLF、删除无末尾换行最后一行、保留 0664/0775 权限；读取二进制/1,020,005 字节文件摘要后分别写入或补丁；一次统一差异修改两个文件并保留各自 owner。结果通过持久化事件、最终字节 SHA-256 和 file_stat 验证。

## 失败证据与复测

- 初始公共接口拒绝额外模型预算字段，未产生模型调用；改用该公共接口现有的 12 次预算。
- 初始统一补丁在无 Git 的 Python 镜像报错；实际 `git --version` 退出 127。修为能力层独立文本补丁后，真实复测通过。
- 大文件初始准备请求遇到 HTTP 大小限制，尚未调用模型；改为工作区真实进程生成测试输入，没有扩大产品接口限制。
- `ae5f8b2` 边界例最终字节/权限均正确，但模型未按一次多文件补丁执行，整例如实失败。记录暴露了归一化读取和末尾空行预览造成的误导；最终物理行回执修订后同场景一次多文件补丁通过。

## SWE-bench

冻结 Verified 数据集 `c104f840cc67f8b6eec6f759ebc8b2693d585d4a` 的原三例，准确 base commit、仅题目输入，无 gold/test patch 注入推理。每例 12 次共享调用、420 秒，三例实际推理共 36 次共享调用（33 Agent + 3 路由）。补丁通过普通云端能力导出成不可变制品，随后独立官方 swebench 3.0.15 评测。

**此前 f2be856 轮：**初次官方评测第二题通过，第一题失败，第三题环境构建 conda 退出 137；评测 VM 内核证据确认 OOM。只将独立 VM 从 4 GiB 改为 8 GiB，重新评测同一批既有补丁，没有再次推理。此前 f2be856 轮的最终官方结果：`graded-small-sample`，三个补丁均成功应用，覆盖与清理完整，没有 error/incomplete；**2/3 resolved**：pytest-dev__pytest-5631 和 sympy__sympy-12481 通过，pytest-dev__pytest-5787 未通过。

**此前 f2be856 第一题：**补丁已成功应用，失败为异常链 round-trip 重建为 ReprExceptionInfo，官方两个 FAIL_TO_PASS 用例失败。模型也留下未导入 ExceptionChainRepr 的已知缺陷并耗尽预算，不能将工具成功或 turn.completed 当成用户任务成功。

## 用量与成本

本轮包含调试、失败重测、最终四例及三例 SWE 推理，17 个实际 run，160 条网关操作对应 159 条成功且 CNY CALCULATED 的账单记录，以及 1 条 MODEL_RESPONSE_INCOMPLETE 失败、账务分类 FAILED_FREE 的记录。已记录成本 `1.77812456 CNY`；账单字段输入 token 2,113,604，输出 token 36,951（包含该失败记录的已记录 token，不推断供应商最终结算）。最终四例 31 次、`0.22086664 CNY`；此前 f2be856 SWE 推理 36 次、`0.61126472 CNY`；最终 20121af SWE 推理 33 次、`0.51821636 CNY`。不含此前历史测试和评测虚拟机资源成本；token 数按账单原字段，不推断文本长度或未配置价格。

## 静态检查、部署与边界

macOS 限定 TypeScript/ESLint、脚本语法和 diff whitespace 检查通过；executor 的既有 no-unsafe-finally 规则问题被限定排除，不宣称完整默认 lint 通过。独立 Linux 服务器按已推送 Git 对象构建，不能称为 Windows 验收；Windows 检查未执行。没有运行 Vitest、假模型、API 模拟或 transcript replay 测试。

服务器无法访问 GitHub，使用已推送 exact commit 的 Git bundle 快进生产 checkout。最终只切换 runtime/executor；control 保留 `500eecb`（后续 service 产物摘要相同），UI、其他资源服务、Docker/nginx 与主平台业务服务通过保护检查保持状态。候选依赖准备的一次失败由部署器独立安装解决，健康与公开版本验收通过；误受候选依赖复用影响的非活动 f2be 依赖已按相同 lockfile 恢复为独立副本，当前服务未改变。没有修改平台源码、账号数据或数据库 schema；保留其他进行中的本地修改。

统一差异仅支持声明的文本能力；重命名、二进制和权限转换使用专用能力，显式 CRLF→LF 归一化使用 guarded file_write。多文件磁盘故障没有跨文件事务保证。小样本通过不能证明广泛正确率。

## 本机原始证据（SHA-256）

- `.cache/file-edits-live/2026-10-10T12-57-11.099Z_5802964f/report.json` — `3e40f44bab4d3f4ae6d66685229f161bbf7625210260c94a63d30c8d8b91660d`
- `.cache/swebench-cloud-live/2026-10-10T12-32-47.741Z_d5bce3e2/report.json` — `187cf00697268c041fa519e038bde7f9de1c7043d771afefdceb8e03ce0c748b`
- `.cache/file-edits-live/accounting-final.json` — `cf34f41bd3779178630a805edf464fbcdd1b5bf1607596ae96659b858536c5e0`

- `.cache/swebench-grade/2026-10-10T12-53-49.127Z_93cbfabd/report.json` — `1af2651910018bf8e77ace3d522bd6df5bed5055e2037eaead88f947ba63d2cf`
- `/Users/xiangjunsheng/DaoyinHarness/.cache/swebench-grade/2026-10-10T12-53-49.127Z_93cbfabd/daoyin-cloud-f2be8565fd44.daoyin-verified-3-88bc9eda.json` — `cb4e53252a1658e54b183c32cee4cd026d74aac4c05e51d4fcd4d0cde82ea60b`

官方评测自身的题目测试由独立环境执行；未在 Harness 执行遗留回归套件。官方已清理本次容器，独立评测 VM 在完成后关闭，不更改其他 Docker 服务或 context。

## 最终部署版本的 SWE 结果

`20121af3aa419a2710fb80ac4adf12cc75898b0d`；同模型、同原三题、同 12 次共享调用/420 秒上限。实际 33 次共享调用，没有在失败后重新求解题目。

| 题目 | 官方补丁结果 | Agent 流程事实 |
| --- | --- | --- |
| pytest-dev__pytest-5787 | unresolved | 新异常链两个 FAIL_TO_PASS 均通过，但旧行为有两项 PASS_TO_PASS 回归：test_xdist_longrepr_to_str_issue_241 与 test_deserialization_failure 抛 KeyError: reprtraceback；模型用完 12 次调用，未实际验证 |
| pytest-dev__pytest-5631 | resolved | 9 次共享调用，含一次 MODEL_RESPONSE_INCOMPLETE；依赖安装/验证等待期间触及 420 秒观察截止，run 已取消。通过的是停止时的源码补丁，不能标为 Agent 成功完成任务 |
| sympy__sympy-12481 | empty_patch | 12 次调用全部用于定位与读取，模型明确报告未修改、未测试；实际导出为空补丁，没有代填修复 |

三个实际产物均提交官方 swebench 3.0.15：resolved 1、unresolved 1、empty 1，error/incomplete 0；官方覆盖完整、清理完整。小样本结果变化表明解题过程仍不稳定，不能声称整体可靠性已解决。后续问题在预算分配、依赖准备与兼容性验证；本轮没有为题目加入强制修改策略或参考补丁。

原推理报告保留 cloud-inference-incomplete。对已取消的第二题，仅通过普通账号导出停止后的真实文件，原 run 保持 cancelled；原模型事件和报告未重写。导出前后源文件指纹均为 `8e9390ba0ccdf205326e487545e5bb5b6ee2e01c7bfa403a2d19077c4686b237`，新增模型调用和源码编辑均为 0。一次只读进程的响应不确定，通过原 requestId 的持久化 operation.completed 和不可变输出恢复，没有重放原操作。derived report 记录该恢复，官方评分只说明产物，不将取消流程改为成功。

最终轮证据 SHA-256：
- `.cache/swebench-cloud-live/2026-10-10T13-07-23.002Z_ff6d105e/report.json` — `d83dd43990b9f97ef326f24fd1e0b02b134562888f3d4e0e1f1c9664a5141d9c`
- `.cache/swebench-cloud-live/2026-10-10T13-07-23.002Z_ff6d105e/terminal-export-recovery/report.json` — `9bcf42e21380b5f92e1a56405cfc49b3724a877083bac7358701c5c2148dbf9c`
- `.cache/swebench-cloud-live/2026-10-10T13-07-23.002Z_ff6d105e/terminal-export-recovery/recovery.json` — `749be0cc7719d29f5551af5a95da05217dc55a58e8ee99ef35aa863f2c928fba`
- `.cache/swebench-cloud-live/2026-10-10T13-07-23.002Z_ff6d105e/terminal-export-recovery/resumption-provenance.json` — `0f695de96a84da74a70cb28930555fad63d44b687115d0f19a7d2960fbdbb2aa`
- `.cache/swebench-grade/2026-10-10T13-27-16.450Z_2144a248/report.json` — `1460d0ddb9287d911cf74e1b2faf1350b75000566764e4a531b7d3320351b550`
