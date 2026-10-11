# ADR-0044: Recoverable execution and shared run budgets

- Date: 2026-10-11
- Status: Accepted; implementation and live acceptance reported separately.
- Supersedes: ADR-0043's half-budget closeout reminders.

## Decision

The model selects actions. The host owns authorization, immutable evidence,
execution limits and cancellation. Ordinary root runs receive up to 24 shared
model requests, 96 tool calls and 600,000 milliseconds of active execution.
Clients may lower those limits; parent, child, routing, recovery and summary
requests share the root allowance. Exhaustion records partial progress and waits
for an explicit user continuation. It never renews a budget automatically.

An optional task_plan tool reads and updates a versioned session plan through
append-only events. A plan describes objectives, steps, blockers and references
to accessible actual evidence; its status is not proof of correctness. Children
own their plans and the parent decides whether to adopt their results. Recovery
and derived context summaries retain the current objective, pending steps and
evidence references. Current plan and actual remaining limits replace repeated
half-budget reminders. A completion claim with pending steps or necessary
processes receives at most one reconciliation within the existing allowance.

Runtime selection uses a trusted catalog with versions, capabilities and image
digests. Existing runtime identifiers remain compatible. environment_inspect
returns bounded actual interpreter and project declarations without executing
configuration. environment_prepare uses the existing isolated builder and a
snapshot-derived candidate workspace. Preparation returns a tracked operation;
success returns a new workspace, and failure preserves the original workspace.
Environment and dependency cache identities include image and declaration
digests. Preparation never supplies repository-specific fixes or benchmark data.

Agent process_run separates process lifetime from a foreground wait of at most
60 seconds. An unfinished command returns its original tracked process identity
and is not relaunched. Manual resource requests retain synchronous semantics.
Output, terminal status, timestamps, cursor, truncation and digest are persisted
with redaction before container or secret cleanup. Terminal receipts remain
readable after cleanup. Completion is published only after persistence; the
next existing model request receives evidence without a notification-triggered
request. Cancellation, deadline and finalization stop remaining finite owned
operations and retain their actual terminal outcomes.

The main platform atomically binds a trusted ExecutionBudget to a root run
before model routing. Harness persists the effective allowance. Bound budgets
replace the platform's literal per-run 12-request limit. Existing grants,
billing, balance validation, idempotency and conservative charging of uncertain
requests remain authoritative. Unbound historical requests retain legacy limits.
Run creation accepts optional limits or legacy maxModelCalls, never both.
continueFromRunId creates a new authorized run and budget for the same session
and resource scope, restoring plan and evidence without credential reissuance.
An admitted continuation also restores capability pack identifiers from the
source run's persisted routing decision. Current authorization, dependencies,
per-turn risk admission and the existing tool/schema caps still apply; available
prior packs are retained before fresh routing suggestions. The current user goal
remains authoritative, and prior router objectives or prompts are not inherited.
Schema changes are additive; historical events, runs and billing are not rewritten.

## Scope and publication

Reuse AgentEngine, tool registry, workspaces, resource repositories, isolated
builder, gVisor and existing event transport. No new planning model, scheduler,
arbitrary shell, task-specific hardcoding or reference implementation is added.
Coordinated main-platform changes are limited to the required budget and tool
contracts. Preserve unrelated working changes and deployed overlays. Publish
the compatible platform interface first, then Harness components, from exact
pushed commits. Inspect active tasks and retain rollback components before
switching the shared API; UI switching is separate.

## Acceptance

Only small actual model/account/tool/storage scenarios establish behavior.
Validate recovery, declared runtime adaptation, single-start long processes and
durable receipts, budget continuation and cancellation. Freeze the configured
model and reserve against actual pricing before calls. This work's total bound
is RMB 10 and 160 shared model attempts. Stop new calls when pricing or reserve
is insufficient. Static checks are packaging evidence, not behavioral acceptance.

An optional trusted host admission policy applies only to operator-selected
sessions. Before semantic or ordinary model transport it atomically reserves a
conservative cost from the actual input byte bound, the platform prompt bound
and maximum output tokens at frozen configured rates. The ledger contains only
identifiers, input hashes and money; uncertain calls retain their reservation.
Only observed priced usage may settle it. Policy paths and rates are never
accepted from browser inputs, and this guard does not replace platform billing.

Then officially grade the fixed three SWE samples at 12 and 24 shared calls,
holding model, source baseline, prompt, tool limit 24, run limit 600 seconds and
observer limit 420 seconds constant. Include empty patches and failed runs,
distinguish environment, delivery, patch and grader failures, and report every
round. Mechanism acceptance does not guarantee three solved instances.
