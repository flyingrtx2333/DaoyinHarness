# Task execution architecture: implementation and real validation

Date: 2026-10-11. This report separates implementation, delivery and observed behavior. It does not establish general SWE-bench accuracy.

## Scope and revisions

The changes are task-neutral: task-scoped append-only plans and incremental evidence projection; failed-mutation invalidation; trusted environment discovery and isolated preparation; known-outcome retry; persistent process receipts; shared execution budgets; and matching bounded tool-batch contracts across the gateway and kernel. No repository-specific repair rule, benchmark answer, reference source or model replacement was introduced.

Architectural decisions: ADR-0046 (task-scoped execution projections), ADR-0047 (deployed resource-contract audit) and ADR-0048 (bounded model tool batches). Harness implementation commits include `1cbe06e`, `583dc10`, `7271351`, `41f5e98` and `1901330`. Validation-driver fixes include `c29d987`, `5e17f67` and `3bcc366`.

The actual cloud kernel used for final inference is `1901330e377bf15e92c3d99b6cc0152ecba4fb65`. Resource executor/control run the `1cbe06e6b54f48bf5d34fd1d15c506db1f701664` release. Main-platform changes are `2d9f4100da0cc2d7148bab2fd0556b55ecd1586b` (compatible tool schema) and `c8bf3f9597b476e71f4d74251fcd65f3a02d6df0` (matching tool batches). The deployed backend image is `sha256:4d2d31f4b9e64cc944b0f783664588448191fa221a2bcc48c763eee041448617`.

These commits were pushed before deployment. Exact Git objects were transported to the server; the server built the kernel release. Only the required runtime/resource/backend components switched. UI and unrelated services retained their running revisions; old releases/images remain available. Server platform work and unrelated local IM/workflow changes were preserved. Driver/documentation updates after `1901330` do not change the running kernel.

## Validation contract

The owner authorized at most 100 shared actual gateway requests and CNY 5 for this round. The prior 160-request ledger was retained unchanged. Uncertain requests retain their reservation and are not replayed or refunded.

The actual signed-in account was used through the cloud API, real gateway, real resources and persistent event storage. Frozen provider/model: `deepseek` / `deepseek-flash`; agent scene 55077, timeout 120 seconds, output limit 8000, temperature 0.2, thinking disabled; routing scene 55376, timeout 30 seconds, output limit 1200. Model-configuration SHA-256: `d9f28a830b74c595d4b236a32f6d39e85e0e9da6ad8500d22a99d6cfd8be3329`. Pricing SHA-256: `ffd8df9095d25fa43c347aa2eb0dabb286f58c3b9162585dedb7ce16eebc5dd2`. Deployed resource-contract SHA-256: `2b6d3938ea99f99c83cbb7805808070f5504da91c06d299f7ed3e3d395e14d50`.

Every request reserves bounded cost before transport. Pricing is CNY 1/million input tokens, 4/million output tokens and 0.02/million cache-hit tokens, with a conservative peak multiplier of 2 for reservation. Reports distinguish settled cost from conservative outstanding reserves.

Mac static/package checks passed for protocol build, agent-core/server-cloud types, focused changed-file lint, driver syntax and platform Python syntax. Independent Linux release packaging also passed. These are not behavioral tests or Windows acceptance. No Vitest, fake-model, simulated-browser or transcript-replay test was executed.

## Real scenario observations

All raw reports are retained under `.cache/execution-architecture-live/`; failures were not replaced with later successes.

1. An 8-request environment task persisted plan version 1, an actual failed dependency-preparation operation, and requirements pointing to an existing wheel. A subsequent 5-request continuation restored the plan but encountered three model-response failures because the platform tool schema lacked the new optional preparation fields. The schema was repaired compatibly; all three uncertain costs remained reserved.
2. A 5-request affected retry explicitly referenced that failed operation. It created candidate `wsp_2c4836dd4f67e4f29d38617d`, used Python 3.11.16 and imported the real dependency with factor 1.1. Process `prc_c4443cf049ec593713f86026` exited 0 with identical before/after source fingerprints. The original workspace and its edits were preserved. The driver initially rejected this because it expected a new plan-write event; the restored plan-read was real evidence, and the driver was corrected.
3. A 6-request continuation encountered two more lost model responses: the kernel permitted 16 calls per batch while the gateway/adapter permitted 4. The responsible contracts were aligned to 16 for Harness; other applications retain their prior limit. Two uncertain reservations were retained. A subsequent stale continuation was refused before any model call; the driver now follows the trusted continuation chain.
4. A 4-request affected continuation on kernel `1901330` read the saved plan and actual files, and executed the named `price-export` check. It exited 1 with `('service-fee total', Decimal('7'))`. The run reported partial and preserved the failed check; it did not claim a completed repair.
5. During SWE inference, one installation returned a tracked process ID after the bounded foreground wait. Six reads observed the same process; it was not restarted. Tool-budget exhaustion cancelled it with exit 143. The terminal receipt was persisted before cleanup. After the actual container was gone, the authenticated resource API still returned that receipt, cursor, status and digest. This additional read used zero model calls. See `process-receipt-after-cleanup.json`.
6. After all three official evaluations and cleanup completed, a 6-request continuation reused the prepared workspace. It observed the same failing check, patched `export.py`, preserved the original assertion and Python declaration, and reran the same check successfully. Both source fingerprints matched the final version `sha256:990e8abd0dfc3165db0974723cb06f9888936fc650ec15da4eeeee3712c4c450`. Dependency cache `3fc9954a478aa92d9b4c7902bce91fb97f54de6867f34d823fc9cce3b56b0a9e` was unchanged after documentation/pytest-selection edits. The driver incorrectly required text `7.7` instead of accepting equal decimal output `7.70`; this narrow driver defect was fixed without rewriting the original failed report or rerunning completed writes. The saved plan was not marked complete; the runtime correctly downgraded completion to **partial**. Actual run execution took 40.630 seconds; full driver observation took 79.993 seconds. Evidence: `2026-10-11T04-58-33.359Z_fc4d0004/report.json`.
7. A separate 4-request real run in the same session, without `continueFromRunId`, read `currentVersion: 0, plan: null`, then created its own version-1 plan using real event references and wrote `runtime-audit.txt` with the declared Python version and workspace ID. Thus task isolation and artifact delivery were observed. Its write step remained `in_progress` when the small allowance expired; outcome was **partial**, so the full completed-plan scenario did not pass. Actual run took 18.923 seconds; full observation took 34.872 seconds. Evidence: `independent-task-final-report.json`. This affected follow-up did not rerun the completed code modification.

The zero-call network audit observed real downloads (6,324,062 received bytes). The final EPIPE entries followed cancellation; they do not establish a network-policy failure. See `network-audit-first-swe.json`.

Normal successful long-process completion and an explicit user-cancel scenario are not established by the cancelled-process receipt alone.

## Fixed SWE-bench inference

Inference report: `.cache/swebench-cloud-live/2026-10-11T04-32-04.807Z_3a7498f9/report.json`. It ran from 04:32:04.808 to 04:49:35.343 UTC (17 minutes 30.535 seconds across three cases). Dataset revision: `c104f840cc67f8b6eec6f759ebc8b2693d585d4a`. Source baselines and original problems were fixed; reference/test patches were not exposed to the Agent. Git metadata was shallow depth 1 with no tags, without fabricated SCM versions.

Each case allowed 24 shared requests, 24 tools, a 600-second cloud deadline and 420-second external observation deadline. Actual shared requests include routing.

| Instance | Exact baseline | Shared requests / tools | Observed delivery |
| --- | --- | --- | --- |
| pytest-dev__pytest-5787 | `955e54221008aba577ecbaefa15679f6777d3bf8` | 23 / 24 | 4905-byte patch; partial. Syntax check passed, pytest was missing, installation consumed the remaining tool budget; no final test rerun. |
| pytest-dev__pytest-5631 | `cb828ebe70b4fa35cd5f9a7ee024272237eab351` | 16 / 24 | 527-byte patch; partial. Reading/search consumed most tools; no process/test ran. |
| sympy__sympy-12481 | `c807dfe7569692cad24f02a08477b70c1679a4dd` | 22 / 23 | 1765-byte patch; completed. Real dependency installation and a temporary validation-command compatibility shim preceded two existing test functions and the issue reproduction, exit 0. |

Total SWE inference: 61 shared requests (58 agent, 3 routing). None of these three runs selected `runtime_list`, `environment_prepare` or `task_plan`; first two inspected the environment. Therefore this sample does not prove model-driven environment preparation in SWE. No 12-request comparison was performed in this round; increased allowance is not an efficiency claim.

## Remaining limitations

Model action selection remains a bottleneck: environment tools can be exposed without being selected, repeated reads/waits can consume the tool budget before testing, and a successful preparation/probe command does not establish acceptance. Verification scope labels are model-provided; preserved process output and source fingerprints remain the underlying evidence. Installation/version probes must not be presented as successful repair tests.

Source fingerprint limits may yield `version_unknown` for large projects; ordinary generated artifacts can invalidate a prior check. These states are reported rather than silently treated as passing. The fixed benchmark allowance remains separate from the generic default tool allowance.

## Final official grading and budget

Official SWE-bench 3.0.15 evaluated all three submitted patches using the independent trusted Docker daemon on the Mac-hosted arm64 Linux VM. Cloud inference used gVisor separately. Grading ran from 04:50:01.029 to 04:57:56.010 UTC (7 minutes 54.981 seconds), including environment builds and cleanup. All three patches applied. There were no empty patches, incomplete cases or grading errors.

| Instance | Official result | Classification |
| --- | --- | --- |
| pytest-dev__pytest-5787 | Unresolved | Patch failed acceptance: both FAIL_TO_PASS tests passed, but two PASS_TO_PASS tests failed (`test_xdist_longrepr_to_str_issue_241`, `test_deserialization_failure`). |
| pytest-dev__pytest-5631 | Resolved | Official tests passed; cloud run's own validation remained partial. |
| sympy__sympy-12481 | Resolved | Official tests passed. |

**Result: 2/3 resolved**, not 3/3. This is a single fixed 24-request-allowance sample, not a best-of selection or an efficiency comparison. Official report: `.cache/swebench-grade/2026-10-11T04-50-01.028Z_875b334c/report.json`; aggregate SHA-256 `cb4e53252a1658e54b183c32cee4cd026d74aac4c05e51d4fcd4d0cde82ea60b`. Prediction SHA-256 `71242baf1eb89edfdea120b15f45cbfbadcc51adeae21ca9cc50900c9d7f4690`.

Final active-ledger accounting: **99 shared requests / 100 authorized**, **CNY 1.711823 settled**, **CNY 3.424573 conservatively committed** including **5 uncertain reservations**, against the CNY 5 cap. The last request was not spent on a fragmented retry. The prior ledger SHA-256 remains `c1145acc40961656ce8e676db7724ddb7742112c45dd82e760cf0fbbcaba568e`. No model was switched for scoring.

Acceptance boundaries: real environment selection/preparation/retry and cache reuse, failed-check → edit → successful same-check rerun, continuation without repeating completed writes, independent task isolation, budget partial handling, and reading a cancelled process receipt after cleanup have evidence. All four originally requested scenarios are **not** claimed as fully passing: plan completion under the small allowances, normal successful long-process completion and explicit user cancellation remain unverified/incomplete. The 12/24 comparison was not performed within this round's remaining allowance. Implementation and focused deployment are delivered; broad Agent reliability and SWE 3/3 remain unmet.
