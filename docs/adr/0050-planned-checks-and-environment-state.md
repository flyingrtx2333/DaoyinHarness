# ADR-0050: Planned checks and persistent environment observations

Status: accepted, 2026-10-12

## Evidence

The last real sample spent 19 tool attempts before its first process and inspected the environment only after editing. Another candidate never reached its changed code because dependencies and interpreter compatibility blocked checks. Existing verification tracks launched commands faithfully, but cannot reserve for a check that has not yet launched; plan descriptions and completed statuses do not establish acceptance.

## Decision

Extend optional task-plan steps with a verification intent containing a resource identifier and scope. These are model-selected obligations, not executable commands or authorization. Project current obligations from immutable plan and process events, regardless of the model's step status. A selected check must have actual current-version successful process evidence. Missing, running, unsuccessful and outdated checks remain distinct. Candidate preparation redirects obligations to the derived workspace; no prior success is carried across as new evidence. Legacy plans retain their semantics.

Count declared but unstarted checks in budget advice before changes begin. Do not count a launched check twice or treat an environment preparation as a check. Estimate repair capacity from observed failed/stale checks. Advice never blocks necessary reads, launches an automatic model request, grants budget or forces edits.

Resource tools emit bounded capability-owned environment observations alongside ordinary receipts. Project the latest interpreter/declaration assessment and candidate transitions outside lossy conversational compaction. Runtime pins and preparation are evidence, not proof of test readiness. Declaration changes invalidate inspection; preparation requires confirmation on the returned candidate. The model chooses runtime, dependencies, checks and repairs. No repository-specific runtime or acceptance rule is added.

Complex executable tasks should inspect environment early, identify reproduction and affected behavior before spending optional exploration budget, and retain concrete failure/next-check evidence. Simple tasks may omit a plan. A final answer with unfulfilled declared checks is partial, even if the model marks plan steps completed. Existing cancellation, account scope, shared quota and append-only event rules remain unchanged.

## Validation

Use necessary static/build checks and small authenticated real-model scenarios, then the same three pinned SWE samples. The owner authorized at most 80 shared requests and CNY 5 for this iteration. Freeze existing model configuration, preserve all outcomes and stop when either bound is reached. No mocked, replay or legacy Vitest tests.
