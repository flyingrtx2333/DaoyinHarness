# 云端模型期限、取消与预算收尾修复验收

日期：2026-10-09。真实环境为生产独立 Linux 云端实例，账号采用已有 daoyintech 账户执行身份；调用实际原生 Cloud API、AI Gateway、Agent、工作区工具和持久化事件。未替换模型或业务返回，未重放旧模型请求，未调用付费业务生成或删除业务资源。

## 实现与部署

- Harness 运行内核：`f828bb0f319792478e3b4575944c661d92b90341`。
- 主平台取消修复：`8b34415a1c3b6361f840bd30f3148227bfb164ec`。
- 主平台最终收尾与计时事实修复：`d2745e96518dee76cfe6ebcc17cd1959b131bd74`。
- 最终网关镜像：`sha256:9230137d3642a1f815b0e92bbfdcfee46a3889f23578c168c5f31752452c527f`。仅在当前实际镜像上替换两个已推送的网关文件，保留并行发布的萤火功能。
- 默认云端模型总期限 150 秒，网关模型 I/O 总期限 140 秒，首次供应商数据期限 90 秒、供应商流闲置期限 45 秒，模型传输期限 160 秒。父子 Agent 使用同一云端模型期限。整轮仍为五分钟，共享调用上限仍为十二次。
- 断开连接取消异步供应商请求并关闭本端 HTTP 流；未知结果保持禁止重放。固定失败阶段传回 Harness，安全时间与异常类别写入账务事实，不记录隐藏推理或原始异常文本。
- 可用工具额度时明确继续推进；最后额度关闭工具。普通回答携带模型自报 taskOutcome，网关剥离尾部控制标记；旧回复缺省 unknown。回合完成不等于任务验收通过。历史工具请求与结果在收尾模型请求中作为引用资料保留，去除可执行的工具调用协议消息。

发布过程中发现另一项萤火发布覆盖了最终收尾文件，保留第一次部署凭据后，将修复重新叠加到实际萤火镜像。最终模型验证前后两份网关文件 SHA-256 一致，匹配已推送的最终源码；运行内核仍为 f828bb0。没有修改全局 Docker、网络、Nginx 或资源服务配置，没有数据库迁移，没有发布 UI。

## 最终三个真实场景

模型均为 Ark `doubao-seed-2-1-pro-260628`。最终三场景最多十四次共享模型调用，实际十三次：八次 Agent 读取/收尾请求、四次路由请求、一次被取消的模型请求。两个读取场景各六次共享调用；取消场景一次。复用此前实际创建、当前账号有权限访问的测试工作区，输入文件保持不变。

| 场景 | Run | 观察结果 | 包含准备与轮询的耗时 |
| --- | --- | --- | --- |
| 顺序读取全部三份核对单 | `run_df38b04d-7c8d-4c26-bf7f-db1ae4596639` | completed | 44.526s |
| 额度不足的十二份核对单 | `run_2fabff5b-be20-43ca-844b-938da4705323` | partial | 33.740s |
| 真实文本输出后取消 | `run_034e4abb-e61a-43ee-81f7-f210aa6a4479` | cancelled | 108.636s |

完整场景实际按顺序 file_read 三次，得到编号/值 1/7、2/14、3/21；最终记录 taskOutcome=completed。预算场景也按顺序读取三次，第四次 Agent 请求工具列表为空，正文如实报告余下九份未读；最终记录 taskOutcome=partial。两者公开 assistant.delta 均没有控制标记，实际路径和内容由 tool.completed 的持久化结果核对。

取消场景只生成普通文本，没有调用工具。供应商第一片数据在约 5.730 秒到达，第一段正文在约 101.633 秒到达，说明有流进展的请求没有被旧的整次 90 秒期限提前结束。收到公开正文后提交取消；turn.cancelled 在约 0.220 秒后记录。网关在取消后约 0.243 秒写入失败账务，其 providerFailureCode 为 MODEL_CANCELLED，保留 unknown 操作状态且没有自动重试。总供应商等待约 104.912 秒。这证明本端及时停止 I/O，不能证明供应商服务端停止推理或后续费用为零。

本次未触发首次数据 90 秒、流闲置 45 秒或总 I/O 140 秒的超时分支；这些阈值的行为只做源码检查，不宣称真实模型已覆盖全部边界。没有重跑 SWE-bench，也不宣称其通过率已提高。

## 保留的中间失败

第一次完整读取实际成功，但验证脚本误从脱敏 tool.started.input 提取路径，造成路径断言失败；真实路径位于 tool.completed.evidence.result，原报告保留。修改观察来源后没有立即重复该调用。

第一次预算场景确实推进到最后额度，但最终工具为空时仍收到供应商工具调用，返回 MODEL_TOOL_INVALID；没有执行该调用。日志确认 operation=model_4、reason=tool_not_offered、offered_count=0。补充工具历史引用转换后重新验证受影响收尾，包括完整读取。

一次原生验证调用未获得 started/accepted 凭据，包装器保留 blocked 状态，原始私有错误未记录。该时段存在并行 API 发布，未据此断言唯一原因，也没有自动重投未知任务。恢复前只读取身份、运行 revision 和当前网关文件哈希。

## 本轮费用与保护核对

范围仅为本次五个有 Run 凭据的模型任务，包括两个早期场景和最终三个场景，共二十五次共享操作：二十三项 completed、两项 unknown。账务二十九行，十五项主模型记录已计算合计 **CNY 0.81300000（约 ¥0.81）**，输入 123,515 token、输出 2,397 token。另有十二项辅助记录缺少费用，以及两项失败/取消记录 FAILED_FREE；平台记零不证明供应商费用为零。完整总成本未知，也不包含 Codex 开发成本。

每次 API 发布健康为 200，并在切换前后比较其他容器和服务状态。最终发布后原有五十四个其他容器保持相同 ID/镜像/启动时间，十一项受保护服务状态一致。验证期间另新增 `/saishi-ui-acceptance-20261009-web`，本任务没有创建或停止它；因此原始整集合相等检查为 false，差异记录保留，原有容器相等检查为 true。网关和 Agent 的必要重启分别记录；没有将短暂 API 重启说成完全无影响。

静态检查为 macOS 上局部 TypeScript/lint/diff 检查及 Python AST 检查；服务器实际 SDK OpenAI 3.16.2 的异步客户端/流属性经过只读核对，Linux 发布构建成功。这些是静态与打包证据，不是 Windows 验收或模型测试。

## 本地证据

- `.cache/model-deadline-release/real-report-attempt1.json`：首次完整读取及观察断言失败。
- `.cache/model-deadline-release/real-report-attempt2.json`：首次预算收尾真实失败。
- `.cache/model-deadline-release/real-report-attempt3.json`：未获得任务凭据的调用。
- `.cache/model-deadline-release/real-report-final.json`：最终三个通过场景，源码哈希前后一致。
- `.cache/model-deadline-release/accounting-receipt.json`：只读费用与操作状态。
- `.cache/model-deadline-release/runtime-deployment-report.json`：实际 f828bb0 内核发布。
- `.cache/model-deadline-closure-release/deployment-report-first.json`：被后续并行镜像覆盖前的发布。
- `.cache/model-deadline-closure-release/deployment-report.json`：保留萤火功能后的最终发布。
- `.cache/model-deadline-closure-release/post-validation-protection.json`：最终文件、镜像与保护核对。

账务收据 SHA-256：`15280b9c0d94acafc04c2354f59482239a4c1bbf1df5b110ca15760f0ac83f53`。
