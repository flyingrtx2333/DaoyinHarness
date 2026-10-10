# Unified platform provider and account billing — 2026-10-10

## Deployed revisions

- Harness runtime and workbench: `e4285aca5bc7ad5492de8de6789afdde2653052f`.
- Platform selected committed source overlays: `d71006f9f7cfa02e0826f632317eafa725b29356`, then `98495b2767ca59cf927288b72e3b18025fcb6490`.
- Independent Linux server, Node.js 22; narrowly necessary cloud/UI type checks and revision-stamped packaging passed. Public UI files matched release hashes. Windows and browser interaction checks were not performed. No legacy or fabricated-model tests ran.
- Platform shared `deepseek` provider is enabled with existing server-managed credentials; the separate `harness-deepseek` entry is disabled. Four scenes verified against shared provider: agent turn, capability routing, material actions and material boundaries.

## Real authenticated account evidence

Account user 1 / tenant 1, existing account login session. Run `run_e458db92-f738-4ad5-81d2-8af8e6867810` completed in 25113 ms. Input requested reading Northeast Hui shop data and generating only the new female narration “东北荟，一起尝尝东北菜。”, with no new video frames, rendering or music.

Actual completed tools: shop query, real shop inspection, narration generation. Persisted narration: `res_5c2b88a9fd9c90fa5b4e4587`, real measured audio 2.345 seconds. DeepSeek provided classification and main-model calls; MiniMax supplied actual speech, all attributed to `daoyin-harness`.

| Usage ID | Scene | Provider | Cost CNY |
| --- | --- | --- | --- |
| 15151 | capability_routing | deepseek | 0.00070440 |
| 15152 | agent_turn | deepseek | 0.00066568 |
| 15153 | agent_turn | deepseek | 0.00766100 |
| 15154 | agent_turn | deepseek | 0.00840200 |
| 15155 | campfire_narration | minimax | 0.00770000 |
| 15156 | agent_turn | deepseek | 0.00889500 |

All six successful records were CALCULATED and had exactly one wallet settlement. Total 0.03402808 CNY = 3.40280800 credits. Wallet changed from 37.22497280 to 37.19094472 CNY; exact Decimal delta matched the usage sum. Re-settling those same actual usage IDs made no additional debit.

A repeated actual narration generation request with the original request ID and identical observed text/voice/rate returned the cached COS URL, added no usage rows and made no wallet debit.

## Discovered and corrected during validation

The first real run `run_1b12aa37-19c9-4371-9272-957909e6d56e` found that the cloud bridge bypassed the alternate Agent generation entry point. Its main-model records 15148–15150 lacked provider request start time, so pricing remained MISSING_USAGE and the task did not complete. Only routing record 15147 was charged, 0.002622 CNY. The direct bridge now records start time and actual provider cache fields; the second run above passed. Those incomplete earlier records and older history were retained without retroactive wallet deductions.

DeepSeek pricing follows [official Flash pricing](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/): provider-reported cache hits, peak/off-peak Beijing time and the 2026 official holiday calendar. Missing pricing evidence is not zero cost. Calendar must be maintained before 2027.

## Limits

The material-analysis bindings and code path were verified, but this billing sample did not create a new vision-analysis request. Balance refresh on terminal events passed type checking and was shipped; actual browser refresh was not observed. Admission checks available credits before calls, while actual-cost settlement can produce a visible debt if concurrent in-flight calls exceed the remaining balance; this is not a pre-reserved hard spending cap. Missing settlement preserves usage and fails visibly. No historical charges were backfilled.
