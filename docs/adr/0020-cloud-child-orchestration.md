# ADR-0020: bounded cloud child orchestration

Date: 2026-09-08

## Decision

Cloud children reuse AgentEngine, never a second model/tool loop. A child receives a separate cloud session and run. PostgreSQL atomically inserts the child session/run and an immutable parent/tool/node relationship in `cloud_child_runs`. Ordinary session admission continues to enforce one active run per session. Child sessions are excluded from the normal sidebar, remain auditable through parent diagnostics, and cannot be used as independent root sessions. Other repository implementations fail closed until they implement the child admission contract.

Authenticated private runs may use trusted intrinsic orchestration tools under `agent.use`. Public company QA cannot delegate. Business tools still require the original allowedTools, permissions, installation, live authorization and resource checks. Children receive only read-only business tools, no orchestration or persistent memory mutations. They do not inherit unrelated parent transcript history.

One root model client provides unique metered gateway operation IDs for the whole tree. Model/tool budgets are shared, child allocation is bounded, and one model call is reserved for parent aggregation. At most two children execute concurrently per root, eight child records may be admitted per root, and inline workflows contain at most five nodes. String steps are sequential; explicit node dependencies must reference earlier nodes, excluding cycles. Ready independent nodes may run concurrently. A failure cancels sibling work and prevents downstream admission; all started workers are settled before the parent tool returns. No automatic replay of interrupted/failed child runs is permitted.

Only visible final results and explicit source run IDs are handed to downstream nodes as bounded, untrusted reference data. No hidden reasoning is collected or handed off. The parent cannot treat a failed or cancelled child as successful. Immutable relationship records plus ordinary child events are the source of truth; in-memory counters/controllers are execution limits, not recovery state. Runtime recovery marks unfinished root and child runs interrupted without reissuing model or business actions.

## Rollout

The migration is additive and explicit, before runtime activation. No user data is deleted or rewritten. Old runtimes can ignore the new table. Build, deployment, Git and real-model acceptance are recorded separately. Only small actual-model cases on authorized resources are allowed; no fake-model or legacy regression suite is an acceptance substitute.

## Boundaries

This is single-executor bounded orchestration, not a distributed durable workflow scheduler, recursive swarm, arbitrary parallel write executor, or automatic post-crash resume. Reusable cloud workflow catalog/editor and dedicated agent topology UI are separate product work. Diagnostics expose persisted child records; normal parent tool messages expose concise progress and ordered results.
