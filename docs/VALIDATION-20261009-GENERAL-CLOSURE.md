# 通用预算收尾与工作区上下文修复 — 2026-10-09

## 实现边界

本次修复共享 Agent 的执行机制，不引入数据集 ID、题目答案、参考补丁、测试专用依赖或额外模型额度。SWE-bench 仅作为独立验收。

- `2986e53`：最后保留调用使用经过请求/结果匹配检查的只读观察，避免助手角色的可执行工具示例；原始事件不改写，错误、退出码、截断和遗漏仍保留。预算提示强调复用观察、合并安全独立读取和保留交付额度。
- `348641a` / `e1e89b1`：单个已附加工作区按现有权限读取运行时 manifest 的固定白名单字段；内部 `metadataOnly` 避免读取全部审计事件、快照和进程。模型工具 schema 未增加新参数，manifest 不被视为实际依赖或版本证明。
- `fecb1c0`：在保留的观察之后添加派生的结果报告阶段请求，并计入原字符/消息预算与上下文拒绝恢复。原始用户目标、权限和共享调用上限不变；不执行正文中的工具语法，不新增隐藏重试。
- `b2d43d5`：明确仅预算结束为 `partial`，已有独立必要条件缺失的观察才为 `blocked`。结果仍是模型自报；未知结果不推定成功。

设计依据见 [ADR-0036](adr/0036-observation-only-budget-closure.md)。所有改动已提交和推送到 main；未包含共享检出中的其他 app.ts 修改。

## 部署与静态检查

实际云端内核为 `aeef5b2a88b5ff76db8d0a223d80482faf1d89e8`，包含上述修复；该 revision 比 b2d43d5 仅增加另一任务的文档。本轮轻量元数据验收时，资源代理实际入口为 `/opt/daoyin-resources/releases/fecb1c09dbee45e3807d91f8af0cf772d4fd55cd/service.mjs`，hash `32091138cdb451d65c351108565ab2173953bd8361ac06468bb878a2d24513f0`。

服务器 GitHub 不可达，使用本机 exact pushed Git bundle 传输并 fast-forward，在独立 Linux 服务器从 Git 对象构建带 revision 的产物。只切换 Harness 内核和资源代理，未切换 UI、executor、builder、deployer、egress 或主平台 API；未重启 Docker/nginx、改变全局网络或迁移数据。

资源切换保留正常服务的进程、启动时间、命令、配置、容器和 release 保护。并发运行时发布曾触发回滚；另有一次已知 legacy daoyin-projects 自行重试及一次 daemon-reload 清空历史 ExecStart 子进程字段导致保护误判。后者与进程重启不同，守卫改为比较真实 PID/单调启动时间及静态启动命令。已有 auto-restart 服务未被干预，不宣称所有服务健康。最终切换通过保护检查和实际入口、产物 hash、readiness 核对。

macOS Node 22.23.2 的必要 agent-core / server-cloud 局部 TypeScript、ESLint 和 diff 检查通过，服务器构建成功。这些是静态/打包证据，不是 Windows 验收或 Agent 行为证明。没有运行 mock、Vitest、回放套件或模拟 API。

## 实际通用任务与保留失败

通过现有 daoyintech 的服务器验证会话复用普通账号执行身份；凭据和 execution grant 留在服务器内存中。真实 Cloud API、Gateway、Agent、gVisor 文件工具与追加事件链路，无虚构工具结果、手工结果补写或外部/付费业务操作。账务主模型为 Ark `doubao-seed-2-1-pro-260628`，不是对供应商内部服务模型的独立证明。

| 场景 | 实际内核 | 共享调用 | 实际工具与持久化结果 | 耗时 | 验收 |
| --- | --- | --- | --- | --- | --- |
| 文件交付 | c24d65b，包含观察投影 | 8 = 6 engine + 2 routing | file_list、两次输入 file_read、file_write、输出 file_read；实际 report.md 中 78.00 / 49.00 / 127.00，结果 completed | 59.469s | 通过 |
| 首次预算收尾 | c24d65b | 4 = 2 + 2 | 只执行 file_list；最后 tools=[]，仍输出未执行的工具语法；文件不存在，结果 unknown | 19.089s | 失败，保留 |
| 阶段切换后收尾 | fecb1c0 | 4 = 2 + 2 | 只执行 file_list；普通正文如实说明未读取/写入/核对，不再仿写工具，但将预算终止标为 blocked | 23.086s | 状态分类失败，保留 |
| 预算不足的文件交付 | aeef5b2 | 4 = 2 + 2 | 实际并行读取两个输入；普通正文报告预计算结果并明确未写入/核对 report.md；文件确实不存在，结果 partial | 49.728s | 通过 |
| 缺少唯一必要依据 | aeef5b2 | 4 = 2 + 2 | 实际 file_read 失败；未创建文件、替代依据或编造批准结论；普通正文说明缺少依据，结果 blocked | 26.531s | 通过 |

输入文件交付要求按 CSV 中 quantity * unit_price 分类求和、不加税，保存并回读 report.md；预算任务保持同一原始目标但只有四次共享调用。缺失依据任务仅允许读取 signed-approval.txt。最终两个任务均实际触发 tools=[]，末尾输入是结果报告阶段请求，未再执行工具、暴露控制标记或超出额度。轻量元数据响应实际带 `metadataOnly=true`，不包含快照/事件/进程清单。

通过样本跨两个内核 revision；不是同一版本的完整回归或整体准确率保证。首次准备在并发切换时返回 CLOUD_REQUEST_UNCERTAIN，0 模型请求；没有重发创建。后续只读确认原工作区存在并复用，未恢复/伪造原始创建收据。

实际 Run IDs 依表格顺序：

- run_545dccd3-176f-4eac-9f04-85cede7878ad
- run_201cb6aa-f1ee-464d-a0fb-6da92214f787
- run_07ac4693-3690-4c76-beea-4b7bfa5a632f
- run_85822366-1009-4e81-a567-1a32390ed7df
- run_41394587-bed0-4513-9dec-d0eff3ec128b

## 成本与证据

五次真实通用任务合计 24 个共享请求：14 engine + 10 routing，低于三个独立批次的合计 32 个准入额度。只读账务核对范围严格为上述五个 run：29 行账务、24 行 operation。14 条主模型已计算费用合计 **CNY 0.81768000**，input 112,980 / output 4,660 token；另外 15 条 qwen-plus、text-embedding-v3、qwen3-rerank 辅助费用为 MISSING_USAGE/UNCONFIGURED，完整供应商成本未知，不包含 Codex 开发费用。

本机脱敏凭据目录：`.cache/general-closure-20261009/`。原始失败报告不被通过报告覆盖。

| 凭据 | SHA-256 |
| --- | --- |
| real-report.json | 8e95ebf30d6aa7281f33ce2a2179586ff4252ae9d70ebd9ccffc260dba07bfa3 |
| real-report-phase.json | 76b85c45b33728568044815fe6a38ea2f2727a76659d320f7e05536efa04d6dd |
| real-report-final.json | 13a67d79ea61666ca3e358b147801aebf7043feba4b2aa924a95ce048f1f23b2 |
| accounting-receipt.json | c8ebcb30da098ea84d513605b2f09ddc288e7f918c5e2708c3bb8b842fde3772 |
| resource-deployed-fecb1c0.json | 63868da277594bd327c17123ed52fc499a4cc6c1e62f07774a617b6772fd8fde |

## SWE-bench

同一组固定三题使用未改变的题目、源代码准备、Dockerfile、每题十二次共享请求上限及原始任务提示完成复测；仅改为服务器验证账号的 native Cloud API transport，不导出密码/grant，主平台 helper 不导出实际 HTTP status，因此该字段明确为未知。源代码来自精确 base 的本机准备归档，通过真实资源 API 上传；未向 Agent 暴露参考补丁或官方测试补丁。

实际内核 aeef5b2；每题 10 engine + 2 routing，合计 36 个共享请求。官方 grader 3.0.15 使用本机独立 ARM64 Lima/Docker 对 Agent 实际导出的补丁评分：**1/3 resolved**，与上轮相同；两题 empty_patch，零 error/incomplete，不代表全量 Verified 通过率。

| 题目 | 实际结果 | 官方评分 | 含准备/导出耗时 |
| --- | --- | --- | --- |
| pytest-dev__pytest-5787 | 无修改，空补丁；收尾普通正文明确未完成，taskOutcome=partial | empty_patch | 197.993s |
| pytest-dev__pytest-5631 | 607 字节身份哨兵比较修复；正文说明实际局部验证和完整安装失败，taskOutcome=completed | resolved；官方 FAIL_TO_PASS / PASS_TO_PASS 通过 | 297.977s |
| sympy__sympy-12481 | 无修改，空补丁；最后 tools=[] 请求在网关 140.006s MODEL_TIMEOUT，普通终态说明未完成、结果不确定且未重试 | empty_patch | 423.755s |

首题 9/9 工具均成功，未执行写入/进程；先逐级列三个目录，再读 Git 历史/配置，第六次才按症状搜索，后续逐次读文件。没有工具、权限、截断或环境阻断证据；主要剩余问题是模型的串行定位策略。其“工具调用预算已耗尽”措辞不精确：耗尽的是共享模型额度，工具实际仅 9/24。不能据此增加题目特例或预载答案。

第三题有实际依赖/运行验证失败。其最后模型请求首个流块在 4.637s 到达，最后块在 139.651s，firstTextMs=null，最终在 140s 网关总时限失败；这不是旧 Engine 90s 提前截断。流块到达不证明正文或任务成功，当前证据不能独立确定供应商内部耗时原因。无自动模型重试或工具重放。仍需通用任务规划和有界收尾延迟治理，不宣称复杂任务可靠性已达标。

本轮 SWE 只读账务：39 行，29 条主模型已计算 **CNY 2.82699600**；9 条辅助费用不全，另有一条 FAILED_FREE 的平台零计费超时，供应商是否收费未知。加上上述五次通用任务，本次八次真实运行已计算主模型费用 **CNY 3.64467600**，不含未计辅助、供应商不明超时费用或 Codex 开发费用。

评分专用 VM 已停止，官方 runner 的本轮容器清理完整。本机默认 Docker context、原有 6 个容器及配置 hash 前后完全相同；服务器 56 个原有容器与网关源码 hash 不变。除任务目标资源代理和已存在的 legacy 自行重试服务外，其他服务/启动时间不变。并行任务在结束核对前将资源代理发布到 b381774（campfire.ts 变更），PID/入口与本轮基线不同，不能声称所有服务快照完全一致；本轮 metadataOnly 源码未改变。当前资源代理 service hash 为 df4be70787df3beb6455a07a2a755f427658b74e34365af29cf44711e16f43d1，manifest 匹配。没有在评分后重新部署或追加模型测试。

SWE Run IDs：run_55ce674e-3831-4c18-9898-4b0bef83be63、run_b555cfa8-1d28-4055-a0b7-2be45b432aef、run_0c903c64-62d4-4336-8153-a016f2de1555。

SWE 推理报告：`.cache/swebench-cloud-live/2026-10-09T06-30-00.514Z_d8cef2c6/report.json`。
官方评分报告：`.cache/swebench-grade/2026-10-09T06-46-19.030Z_d2932581/report.json`。
原始推理传输修改依据和脱敏账务/保护凭据保留在上述 general-closure 目录。


| SWE 凭据 | SHA-256 |
| --- | --- |
| inference report | 5acdc2469d7a3032f0608b487975b04ca1e5a0e9b6400e0aa395375d97723390 |
| official grading report | e46895ac7fbc20038905d75ec60aff39bb52fe662047c24e292b54f9989f2655 |
| swe-accounting-receipt.json | be145f61be1d7ea561aa82acd58200348d9aab4c815a95ca5ce28f5617a9fb49 |
| swe-protection-comparison.json | b429aff211b2117d6560754e05f0a838e554580394dc8c6a8ba3b0330967f4a5 |
