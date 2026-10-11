# Environment inspection and observed verification loop: code-first record

Date: 2026-10-11. Base revision: `205b19ad546c9e56f8130d82d9a9b33f5ff0860e`.

The owner selected “先完成代码，不新增模型调用”. This revision uses zero additional model requests. No real Agent acceptance, deployment or SWE-bench score is claimed.

## Implemented

- Bounded environment inspection includes common verification declarations, development/test dependency declarations and contribution guidance as untrusted data. Version and verification declarations precede large lockfiles in the shared preview budget. No configuration or project hooks are executed. Read-only, offline Git probes report actual shallow/source-version/worktree metadata with output truncation; missing Git metadata stays unknown. Hooks and fsmonitor are disabled for these probes. There is no synthesized package version or repository-specific environment repair.
- Cloud process start/run accept optional `verification`, a bounded stable scope name chosen by the model. It is removed before resource execution. Actual receipt observations, not labels or command names, supply process state and exit code. A later process read or durable completion event closes the same tracked operation without restarting it. Installation is never automatically classified as verification.
- The kernel derives check state from canonical events on each ordinary model request, independent of dialogue compaction. Checks record the observed workspace revision at tool start, not receipt time. Known later file changes invalidate older checks. Different scopes stay independent; a new attempt replaces only the same scope. Running, unsuccessful and outdated checks direct the model back to observation, diagnosis, responsible-layer repair and focused rerun.
- A successful snapshot-derived environment transition transfers pending scopes to the candidate as outdated. Preparation success does not validate code. Explicit continuation linkage is persisted; only the current turn and its validated continuation chain inherit check obligations. Unrelated questions and child sessions do not inherit those obligations.
- Existing one-time completion reconciliation and shared quotas are reused. An unresolved declared check prevents a claimed completed outcome from being persisted as completed; it becomes partial unless the model reports a separately observed blocker. There is no extra planning model, automatic installation, automatic repair, completion-triggered inference or quota renewal.

## Static evidence

Environment: local macOS checkout; TypeScript compiler through existing npm dependencies. Protocol build, Agent core type check, cloud server type check and `git diff --check` passed. Focused lint passed for protocol, kernel, verification view, tool envelopes, environment declarations and resource adapter.

An initial lint check including the executor reported the existing `no-unsafe-finally` violation in `foreground` cleanup. The exact statement also exists in the base Git revision and was not changed. The executor passes the cloud TypeScript check; whole-file lint is not claimed clean. No legacy Vitest, fake-model, canned-response or transcript-replay tests ran.

## Material limits and pending real proof

Verification names describe model-selected intent. Exit 0 proves only the selected command completed successfully; it cannot establish sufficient coverage or overall correctness. Checks not explicitly labelled remain unknown. Workspace-wide invalidation is deliberately conservative, and arbitrary writes inside processes or outside observed resource tools are not content-digest acceptance evidence. Raw output remains in persistent receipts and can be read using the process ID.

The view retains 64 scopes and exposes the latest 12 with total counts. Dropping an unresolved scope retains uncertainty and cannot turn the outcome into verified success. Historical receipts without the new fields are not retroactively labelled. No prior events, model configuration, budgets or bills were rewritten.

When separately authorized, real validation should cover a project-declared runtime/test dependency mismatch, failed check → actual repair → same-scope success, later edit invalidation, candidate workspace transfer, asynchronous completion and explicit continuation versus an unrelated question. Use actual authenticated model/tool/storage paths with a new bounded allowance. Do not reuse old sample scores as acceptance for this revision.
