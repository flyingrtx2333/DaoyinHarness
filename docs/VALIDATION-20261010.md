# 2026-10-10 清理后真实云端验证与官方评分

## 实现与发布边界

源码清理见 CLEANUP-20261010.md。57c8004 修正通用响应恢复的系统消息镜像及上下文预算；3139d91 清理过时合同、重复实现、历史模拟入口及评测密钥探测。随后 065d012 保留安全的 PROCESS_TIMEOUT 回执并修正容器清理误判；78e1a1d 修正发布等待与回滚的停止期限。没有增加 SWE 专用安装、提示或内核分支。

运行内核已从 5c6baa8 切到 3139d91，再切到精确提交 `78e1a1d90668fbb0f8297099d85d74f2b4c830e0`。服务器 Git 对象来自已推送的 bundle，服务器自身构建与运行入口/清单核对通过，readiness=ready、匿名受保护接口=401，普通账号真实接口确认运行版本。UI、资源服务、主平台和数据迁移均未随本次内核切换操作；每次成功发布的受保护服务、容器、配置和发布链接前后相等。

资源 executor.ts 的清理修复已提交，但独立资源执行器未更新，因此不能称该异常分支已经部署或真实验证。保留 app.ts 的无关导入顺序修改和 design/ 的用户产物。

## 四个真实通用场景

使用普通 daoyintech 已验证账号、实际平台 Gateway、Agent、文件/进程工具及持久事件。平台当时实际选择 `deepseek / deepseek-flash`；本次没有人为切回先前 Ark 模型。

| 运行版本 | 场景 | 共享模型调用 | 观察 |
| --- | --- | ---: | --- |
| 3139d91 | 读取订单、分类计算、保存并回读报告 | 6 | completed；金额 78.00、49.00、127.00，真实写入和回读 |
| 3139d91 | 四次共享调用内完成相同交付 | 4 | partial；文件未写入，如实收尾，不冒充完成 |
| 3139d91 | 必需批准文件实际缺失 | 3 | blocked；实际读取失败，不猜测批准结论或伪造文件 |
| 78e1a1d | 实际 Python 写入中间状态后超过 2000ms 时限 | 6 | PROCESS_TIMEOUT 保留；一次执行，读取 started、写入并回读失败报告，29.107s |

原始通用 driver 的前两例通过；第三例错误地要求所有 blocked 任务都进入预算耗尽阶段，原始报告保留 failed。独立语义核对仅解释这两条不适用的阶段断言，没有修改产品以迎合断言。超时 driver 原始报告也保留 failed：唯一失败断言从脱敏 tool.started.input 读取完整参数；资源审计 operation.requested 实际确认精确命令与 2000ms。两个复核都记录原始 SHA-256，没有重跑模型或改写原始结果。

超时场景的用户输入明确禁止重跑，因此它证明具体错误回执与部分状态处理，不能证明所有任务上的自主重试判断。四例未自然触发模型响应恢复异常，恢复重试分支仍无真实故障证据。

## SWE-bench Verified 三题官方评分

冻结数据 `princeton-nlp/SWE-bench_Verified` 修订 c104f840cc67f8b6eec6f759ebc8b2693d585d4a；推理运行版本 3139d91。普通云端 Python/Git 工作区从精确 base 源码准备，未向模型暴露参考补丁或测试补丁。每题共享上限12次，总上限36次，实际29次（26主模型+3路由），没有追加模型重跑。

| 题目 | 实际补丁 | 官方结果 | 原 Agent 运行 |
| --- | ---: | --- | --- |
| pytest-dev__pytest-5787 | 944 bytes | unresolved：两条链式异常测试失败，其余123条通过、2条跳过 | completed，但生成补丁不等于修复成功 |
| pytest-dev__pytest-5631 | 725 bytes | resolved：FAIL_TO_PASS 与 PASS_TO_PASS 全通过 | 安装超时后重复执行，最终取消 |
| sympy__sympy-12481 | 0 bytes | empty_patch | 账号接口请求超时后取消 |

结果 **1/3 resolved**。官方 grader 3.0.15 在独立 Linux/Docker VM 完成，耗时213.061s，gradingComplete=true、lifecycleComplete=true、error_instances=0、incomplete_ids=[]。这是三题小样本，不是完整 SWE-bench 得分；模型与历史 Ark 运行不同，不能据此归因某个内核变更提高了准确率。

取消任务终态、实际无活动进程、精确 base HEAD/tree 都经普通账号核验后，零新增模型调用导出实际工作树并创建不可变 artifact。首题与原补丁逐字节相同，第二题有真实725-byte改动，第三题确认为空。派生评分报告保留原取消/错误状态及源报告哈希；没有伪造空补丁、续写解题代码或放宽评分证据校验。官方测试通过不改变第二题原运行曾取消的事实。评分后只停止本次启动的独立 grader VM。

## 费用与检查

七个 run（四个通用任务与三题 SWE）共有48条平台模型操作及48条 usage 记录，全部 CALCULATED / CNY，合计 **0.52688140 CNY**。范围包含主模型和路由；不包含本次 Codex 开发会话或服务器/评分 VM 资源费用。成本来自 actual ai_usage_logs，不以文本长度估算。

macOS / Node.js 22.23.2：server-cloud 局部类型检查和 git diff --check 通过；tools.ts 与发布脚本 ESLint 通过。executor.ts 整文件 ESLint 保留基线已有 no-unsafe-finally（3139d91:480），未称全部 lint 通过。服务器精确内核制品构建通过。这些是静态/打包检查，不是 Windows 验收或模型行为证据；没有运行 Harness 模拟、Vitest、回放测试。

## 发布中发现的未解决问题

第一次 3139d91 发布时，旧进程停止超过脚本60秒等待，回滚等待也失败；已恢复旧服务并核实 ready 后再次成功发布。后续 78e1a1d 发布虽等待覆盖 systemd 现有150秒关闭期限，但旧3139d91进程仍未优雅退出，systemd 到期 SIGKILL 后启动新内核，造成约150秒该 Agent 服务不可用。其他服务前后核对未变。

新增180秒停止等待修复的是发布/回滚时序，不是运行时关闭根因。停止时已无数据库活动 run、资源任务、工作区容器或资源子进程，但内存等待阶段没有日志证据；只读观察到旧进程仍持有授权 Unix 监听 socket。不能因此确认是数据库、WebSocket 或某个清理阶段，优雅关闭卡住仍待单独定位。

## 证据索引

以下路径相对仓库，均保留原始文件；路径、版本与结果不可混用。

- `.cache/recovery-validation-20261010/real-report.json`、`semantic-assessment.json`
- `.cache/recovery-validation-20261010/timeout-report.json`、`timeout-assessment.json`
- `.cache/recovery-validation-20261010/accounting-final.json`
- `.cache/swebench-cloud-live/2026-10-10T07-34-10.725Z_8f1e9e39/report.json`
- `.cache/recovery-validation-20261010/post-terminal-swe-2026-10-10T07-55-49.725Z_62df0bce/report.json`
- `.cache/swebench-grade/2026-10-10T07-56-42.284Z_a856b42b/report.json`（SHA-256 d5952528f05f2e054cf8419c9fd6ba1c8c4b2b68037da1e2e7f62cbab1ef4ec0）
- `.cache/recovery-validation-20261010/2026-10-10T07-58-48.197Z-runtime-only-78e1a1d90668.json`、`shutdown-observation.txt`
- `.cache/recovery-validation-20261010/followup-static-receipt.json`

初轮删除13个可重建文件，分配量208.03MiB；追加删除两份已成功传输并纳入服务器 Git 对象的临时 bundle（20KiB），另存 transferred-bundle-cleanup.json。推理/评分证据、运行工具链、VM磁盘、媒体、用户产物与历史兼容包均保留。
