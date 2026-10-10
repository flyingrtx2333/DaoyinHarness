# Delivery foundation and real validation — 2026-10-10

## Scope and implementation

This change repairs general delivery, observation and lifecycle contracts. The kernel contains no SWE instance names, Python/AST rules, reference patches or task-specific acceptance checks. No model allowance was increased. The main platform's source, services, schema and account configuration were not modified.

- Successful file mutations may return capability-owned `verificationHint` targets. Hints identify what changed; they do not certify correctness. The Agent preserves a bounded opportunity to inspect actual results before its final report.
- The last tool-enabled calls also enter delivery mode when there is no changed-file hint. Read-only answers remain valid. The last call is still tool-free, and the original shared model-call budget still applies.
- Early answer drafts are persisted as commentary, outside complete tool request/result context groups. A real first attempt exposed `AGENT_CONTEXT_INVALID`; the fix preserves the existing context validator rather than weakening it.
- Observation recovery retries only the same read-only GET, with bounded attempts and deadlines. It never repeats login, submission, cancellation or business writes. Admission and cursor progress are persisted immediately; uncertain submission is reconciled by the original request ID rather than resubmitted.
- Shutdown logs now record ordered close stages and elapsed time without credentials or raw payloads. The historical 150-second hang is not claimed fixed.
- An executor-only deployment procedure checks the exact pushed source, idle resources and protected services. The previously committed sandbox-removal reconciliation is now deployed without replacing resource control, builder or deployer code.

Relevant source commits: `b73ef523`, `a213ad8`, `509018c9`, `1b53b6ff`, `11a5e7b2`, `0635856a`, `a13e4a61`.

## Environment and deployment

- Development/source checks: macOS; scoped TypeScript, ESLint, syntax and diff checks only. These are not behavioral tests or Windows acceptance.
- Cloud runtime: independent Linux server, Node.js 22. Both SWE batches ran at the revisions specified below; the final boundary repair is deployed at `a13e4a619edb7603d4bb039fca434b5a9a295523`.
- Resource control: exact `a13e4a61` artifact, SHA-256 `32854506f1e3c595a19827e69f1540aea69c290d2440a047abab66d3f1632a0f`. Control-only publication restarted only `daoyin-resources.service`; subsequent runtime publication preserved its process and protected component state. The existing executor, builder, deployer, UI and shared resource symlink were retained.
- Resource executor: `1b53b6ffbd96` release, artifact SHA-256 `088caf22fb155f193fcfbe87c978692af83e21717d60b4d069dfb85c0d56114e`. Relevant executor source is unchanged between this commit and the final runtime revision.
- UI remains at `19c7bad9e0aa410c30b43e7aea93b4c384722b8c`; the shared resource release remains `05342aacc268d81c2bad6116f3b3864e8ef09fa5`.
- A pre-switch protection check rejected the first final-runtime deployment. It was not disabled. The subsequent successful deployment recorded equal protected states before and after, and readiness returned 200.
- Existing `daoyin-projects.service` restart failures were already present at 08:39 UTC, before this work's first 08:42 deployment. Read-only investigation found `226/NAMESPACE` during startup, before JavaScript execution. This unrelated service was not changed or restarted by the investigation; overall server health is not claimed.
- Concurrent IM source/documentation work was preserved and excluded from these implementation commits.

## Real account and model scenarios

All scenarios used the existing authenticated ordinary daoyintech account, actual AI Gateway calls, actual cloud tools and persisted events. Provider/model: `deepseek` / `deepseek-flash`. No mock model, fabricated business response, replay suite or legacy Vitest run was used.

| Revision | Scenario | Observed result | Shared calls | Seconds |
| --- | --- | --- | --- | --- |
| b73ef523 | File delivery, first attempt | Correct file written; context validation then failed before inspection. Original failed evidence retained. | 4 | 16.09 |
| 1b53b6ff | File delivery | Actual input read, amounts 78.00 / 49.00 / 127.00 written and read back; `completed`. | 6 / 8 | 21.63 |
| 1b53b6ff | Low-budget delivery | Actual inputs read; no output produced; correctly reported `partial`. This is a boundary-contract pass, not completed delivery. | 4 / 4 | 17.10 |
| 1b53b6ff | Missing prerequisite | Actual file read failed and directory was empty; no fabricated output; `blocked`. | 3 / 4 | 11.85 |
| 1b53b6ff | Controlled process timeout | Exactly one authorized process, actual `PROCESS_TIMEOUT`, partial marker read, failure report saved and read back. | 6 / 8 | 27.17 |
| 0635856a | File delivery retest | Actual file written once and read back once; verification and delivery phases observed; `completed`. | 6 / 8 | 22.69 |
| 0635856a | Low-budget retest | Tool-enabled delivery observed before any file hint; no output; correctly reported `partial`. | 4 / 4 | 16.24 |

Four input-file hashes were re-read unchanged after each delivery batch, without extra model calls. Timeout evidence does not prove autonomous retry avoidance: the scenario explicitly prohibited repeating the command.

Reports: `.cache/foundation-validation-20261010/{real-report.json,retry/real-report.json,timeout-report.json,delivery/real-report.json}`. These are retained local evidence, not tracked runtime files.

## Frozen SWE-bench sample

Dataset revision: `c104f840cc67f8b6eec6f759ebc8b2693d585d4a`. Same three frozen instances, same model and limits: 12 shared calls per instance including routing, 36 total, 420 seconds per instance. The model received only the issue and exact clean base source. Reference and test patches were not exposed during inference.

Official grading uses `swebench` 3.0.15 in the independent Lima/Linux Docker grader, separate from production and the desktop's other Docker workloads. Actual exported patches are graded, including confirmed-terminal cancelled runs; their original inference status is retained. Post-terminal export changes no source and makes no model calls.

First batch, runtime `1b53b6ff`: **1 / 3 resolved**, 31 shared calls. Two empty patches; the middle instance's real patch passed official grading after its inference run reached the time limit. Official grading completed with no infrastructure errors or incomplete instances. This does not make the cancelled inference a completed task.

First inference report: `.cache/swebench-cloud-live/2026-10-10T08-49-32.014Z_0c42db14/report.json`.

First official report: `.cache/swebench-grade/2026-10-10T09-05-36.232Z_a95e7bbd/report.json`; official-result SHA-256 `bd34300873d9a5d5a51c65f2147af150ad06f7cbb44dc405f38633db79c6a5ba`.

Second batch, runtime `0635856a`: **1 / 3 resolved**, 20 shared calls (`12 + 6 + 2`). Official grading completed without infrastructure errors, but inference was **blocked and incomplete**: the first instance produced a 3580-byte patch that failed official tests; the second produced a 621-byte patch that passed, although inference was cancelled after the deadline; the third was interrupted before its first tool result could be recorded and produced an empty patch. This is not a completed three-instance inference comparison or an improved pass rate.

The first instance's final reads covered lines 1–200 while the actual edit began at line 260; there was no executed verification. A delivery opportunity does not establish that the model inspected the right evidence. In the second instance, the requested process timeout was 600 seconds, exceeding the remaining 420-second case window. The observed cancellation then produced a generic resource failure; there is no independent `timedOut` receipt for that install.

The third instance exposed a general boundary defect: `workspace_inspect` completed with an actual **240035-byte** result, but persisting `tool.completed` exceeded the **128000-byte** event limit. The cloud catch recorded `runtime_recovery`; the runtime did not restart and its lease was not observed lost. Complete raw evidence and the original failed status were retained. A subsequent general resource-result boundary repair and its real validation are recorded separately below.

Second inference report: `.cache/swebench-cloud-live/2026-10-10T09-11-54.692Z_35465215/report.json`. Zero-model terminal export: `.cache/foundation-validation-20261010/post-terminal-swe-2026-10-10T09-27-16.215Z_a4fe71a9/report.json`.

Second official report: `.cache/swebench-grade/2026-10-10T09-28-13.971Z_19888ead/report.json`; official-result SHA-256 `dae75568fb6c5a2eb52f6200471066b19954bad558cb15125b89b7223460dc05`. Grading took 292.24 seconds. The independent grader VM was stopped after grading; its cleanup report has no errors.

## Run-scoped usage

Before the additional boundary validation, the 13 actual runs in this work have **84** model-operation and usage records, all priced `CALCULATED` in CNY: **0.97282476 CNY**, 1145791 input tokens and 17001 output tokens, with no missing token counts. All use `deepseek` / `deepseek-flash`. This includes the first failed test and both SWE batches; it excludes earlier sessions, the Codex development session and resource/grader compute costs.

Pre-boundary ledger retained as `.cache/foundation-validation-20261010/accounting-before-large-observation.json`, SHA-256 `81c1a7aaa2392c75c60061422ae907b53471604390dd3ab55be9b236ed618f29`.

Final ledger includes the additional real boundary run: **14 runs, 88 model-operation/usage records, 1.02140044 CNY**, 1200879 input tokens and 17819 output tokens. All records are priced `CALCULATED` in CNY; no token counts are missing. `.cache/foundation-validation-20261010/accounting-final.json`, SHA-256 `a68f21cc24cac1515e2f66acf25dd3ce89be4d534f4f03d19aa3623b57855ac5`. No historical records were re-priced.

## Large-result boundary repair and real proof

Revision `a13e4a61` handles all run-associated resource results exceeding 64 KiB of UTF-8 JSON at the resource capability boundary. The full actual JSON is saved in the existing immutable account-owned artifact store before returning an explicit incomplete preview and a size/digest reference. The existing process-output artifact is reused. Small responses are unchanged; the PostgreSQL event limit is unchanged. Evidence retention still requires an authorized attached workspace, or a unique attached workspace when the result is a collection; unavailable or ambiguous ownership fails visibly without creating a new workspace or replaying the operation.

Agent `artifact_read` now returns exact 8 KiB byte ranges, with continuation metadata preceding content so bounded model projection preserves it. Ordinary manual full reads remain compatible. The guarded component deployment procedure now also supports a control-only switch, verifies its `pg` dependency before restarting, and protects the executor's PID, start time and command. Its idle checks retain the existing admission race; they are not a guarantee against a new task arriving between the last check and restart.

One real task reused the actual workspace that had failed, in a new ordinary-account session. Input requested only workspace inspection and a small evidence page, with no issue solving, source edits, processes, delegation or business operations. Run `run_61d123fa-8912-421b-900d-2ef3de874f01` used **4 / 6** shared calls and completed. The complete validation took **21.25 seconds** including account/API observations.

Actual tools: `workspace_inspect`, then `artifact_read`. The inspection result was now **728686 bytes** because retained real audit/export history had grown. Artifact `art_70248ddacf2e98cb20ce9a5a` retained all bytes; ordinary-account full read matched SHA-256 `a59bbafe113c64f3c8e189ca85dc27824af802c54fc29bfad5ff176850fe6e0e` and the receipt's byte count. The model actually read a bounded artifact page, every canonical event fit the event limit, and no recovery interruption or source/process action occurred.

Evidence: `.cache/foundation-validation-20261010/large-observation/report.json` and `full-evidence.json`; component publication receipts `deployment-control-a13e4a6.json` and `deployment-runtime-a13e4a6.json`. Final read-only server inspection found clean `main`, exact pushed checkout `a13e4a61`, matching executor/control hashes and no active jobs or owned workspace containers according to the idle gate. The independent grader VM is stopped.

This last test verifies the general persistence boundary. No further SWE task was submitted after this repair; the latest official score remains the documented `0635856a` batch, with its incomplete inference explicitly preserved. The final deployed revision has not been scored by a new full three-instance batch.

## Evidence limits

- Same-GET transient retry, an uncertain POST admission receipt, and Docker-daemon removal failure were not deliberately injected or naturally observed. Code review is not real fault-branch validation.
- Actual observed closes finished in 7–8 ms; the prior 150-second shutdown hang was not reproduced and its cause remains unproven.
- A small scenario sample or a three-instance SWE score does not establish broad accuracy. `turn.completed`, a saved file and a nonempty patch are not semantic acceptance proofs.
