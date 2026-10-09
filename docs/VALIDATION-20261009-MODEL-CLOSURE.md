# Actual model closure repair — 2026-10-09

## Implementation and publication

The observed SWE failures included a final `tools=[]` model request and gateway `MODEL_TOOL_INVALID` evidence. The original offending provider tool name/ID was not retained; the exact malformed field remains unknown. This repair makes the tool-free request contract explicit and preserves rejection diagnostics. It does not weaken the tool allowlist or accept invalid tool-call IDs.

- Main-platform pushed commit: `136935a4f811d6f6b04cb8006b1613960535314b`. Only `backend/services/saishi_agent_bridge.py` changes: send `tool_choice=none` when no tools are offered; log rejection reason, run and operation identifiers without provider payloads or credentials; classify a non-string ID as invalid. The [Ark Chat API contract](https://docs.volcengine.com/docs/ark/chat-api?lang=zh&redirect=1) defines `none` as forbidding tool calls and also documents it as the default without tools. Explicit selection targets the observed closure failure; it does not prove why the earlier implicit request produced an invalid result.
- Harness commits `3483765` and `3490ece`: classify `MODEL_TOOL_INVALID` in HTTP/NDJSON responses and preserve it through the metered model wrapper to the terminal task message. No automatic retry or tool execution is added.
- Final cloud kernel: `3490ece6f7d0dca7c11689326b8df505c5d0354e`. Artifacts were built on the independent Linux server from its exact pushed Git objects after local bundle transfer. UI and resource releases were not switched.
- Main API image: `sha256:0ffe47a7affa80034e41c47ebdbf90e173e2d158b0f201bb70572a8a4a2545ec`, derived from the previously running login-quota image with only the bridge file replaced. Active source hash matches the pushed file. Existing Compose, identity, model bindings, pricing, database schema and login-quota correction remain intact. The API publication interval was 01:37:15.527–01:37:32.144 UTC; 49 other containers and 9 protected units matched that publication baseline.

Mac Node 22.23.2 targeted TypeScript/lint/diff checks and Python AST parsing passed. These are static checks, not Windows acceptance or model evidence. No mock, legacy Vitest or transcript-replay suite was run.

## Actual scenarios and retained failures

All inference used the actual authenticated account execution identity, deployed cloud Agent, real capability calls and append-only storage. No fabricated tool responses, human patch edits or reference solutions were supplied. Request-model accounting identifies Ark `doubao-seed-2-1-pro-260628`; the serving model behind the API is not independently attested.

| Scenario | Kernel | Shared requests | Actual result |
| --- | --- | --- | --- |
| CSV program and output | `3483765` | 8: 6 engine + 2 routing | `run_fafde98d-9260-4b64-b485-07711899bfc8` completed; 5 actual tools. Standard-library Python execution, exact decimal/filter/quoting results, original input hash, immutable program/output artifacts and snapshot checks passed. Recorded run duration 49,649 ms; inclusive driver 67,009 ms. |
| Sequential document review | `3483765` | 8: 6 engine + 2 routing | `run_75354c7a-1f2a-4500-ae58-6bd48e30b1b5` completed after reading only the first five documents. Last request still offered 24 tools. The driver retained `TOOL_FREE_CLOSURE_NOT_EXERCISED`; this is not closure acceptance or full document-task completion. Run window 01:40:41.597–01:41:55.260 UTC. |
| Explicit continued reading | `3483765` | 8: 6 engine + 2 routing | `run_4fcea8ba-3beb-4732-9dc1-c9d3c662d9b6` failed at a 90,001-ms model wait. Last request still offered 27 tools. Run window 01:43:14.544–01:45:16.460 UTC. It did not exercise closure; no uncertain request was replayed. |
| Two-call resource query and closure | **`3490ece`** | **2 engine, 0 routing** | **`run_4d5f90d8-829a-4f47-baba-9a95514fe347` completed.** One actual `resource_list` query, followed by a request containing the real assistant/tool history with `tools=[]`, produced a validated assistant answer. No tool started after closure. Inclusive acceptance 24,943 ms; final model response 11,584 ms. |

The first three runs used the ordinary account login/BFF. The final scenario reused the *same validated daoyintech account execution identity* as the third run, entirely inside the platform, and invoked the cloud API's existing `maxModelCalls=2` option. The ordinary BFF does not expose this option. This was a native cloud acceptance call, not a browser-cookie test, new permission grant, model replay or simulated runtime. Server-owned credentials were never printed or retained. The answer correctly stated that the resource preview was truncated and did not claim to enumerate all resources.

Original ordinary test reports remain under `.cache/model-closure-live/2026-10-09T01-39-13.875Z_a4d4f8ea/` and `.cache/model-closure-live/2026-10-09T01-42-54.642Z_3d22734b/`. The final native receipt is `.cache/model-tool-closure-release-136935a/native-short-report.json`, SHA-256 `e95c2b192f0d6e80b481c1346342f86185ebd19f8bbbdf8f3e859d63ced1db51`.

Total across all four scenarios: **26 shared reservations, 20 engine requests + 6 routing requests**. The original two-run allowance was 24, the closure-only follow-up 12, and the final native follow-up 2; retained admission ceilings total 38. These are separate trials, not one homogeneous passing batch. The failed/early trials are not overwritten by the final pass.

## Protection and cost evidence

The first `3490ece` runtime publication was stopped by the original protection guard and rolled back to a ready `3483765`; before/after rollback snapshots were equal. The exact transient mismatch was not captured. A diagnostic copy added mismatch capture without relaxing any condition. The second publication passed the same protection checks. A concurrent `backend-aitsh` container/image replacement at 01:47:45.351 UTC is visible relative to the earlier API-release baseline; this task issued no AITSH operation, and the available first-attempt evidence does not establish the unique guard cause.

After actual validation, all **50 running containers match the final runtime publication baseline**, the gateway file still matches its committed hash, 8 protected units other than the intentionally restarted cloud runtime match the earlier baseline, and main API/cloud readiness return 200. No Docker/nginx restart, global networking change, database migration or UI release occurred.

Read-only billing audit covers exactly these four run IDs: 29 usage records and 26 platform operation rows, of which 25 are completed and one remains unknown. Main-model ledger records contain 19 successful `CALCULATED` entries, 186,204 input tokens and 5,599 output tokens, totaling **CNY 1.28519400**. One failed `FAILED_FREE` entry has missing usage and platform-booked zero; supplier charge is not established. Nine DashScope auxiliary entries remain unpriced (`qwen-plus`, `text-embedding-v3`, `qwen3-rerank`). Thus approximately ¥1.29 is the known calculated main-model amount, **not complete supplier settlement**; it excludes Codex development/subagent costs. No pricing/reconciliation functions were invoked.

Receipts under `.cache/model-tool-closure-release-136935a/`:

| Receipt | SHA-256 |
| --- | --- |
| `deployment-report.json` | `ee704c88b4b4f1301252bdb08efb1284b7cce638a16a1bbf3c21d10e8278783a` |
| `runtime-final-attempt1.json` | `042772114843a83a48e088049c29cb906edd2d852d8ae8bca7898d704c880934` |
| `runtime-final-attempt2.json` | `d5bdc718d8d04973c1205d1538e54365a9e2bdac5ac74f78fd064dc9ea8ea43a` |
| `accounting-receipt.json` | `c92ac89bc4be696a7bc8aa6127cbd1a4c63d9429c97b7226a00c48a773a0881a` |

The native closure case establishes a small real passing sample for the repaired gateway contract. The terminal error-code propagation branch and diagnostic logging were source-checked; no new invalid provider response was intentionally induced. Long-task strategy, model timeout recovery, semantic compaction and full SWE-bench accuracy remain separate gaps. No SWE inference or official regrading was performed in this repair; the prior three-issue 1/3 result remains historical evidence.
