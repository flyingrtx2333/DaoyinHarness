# ADR-0045: Observed verification and environment adaptation

Status: Accepted. Date: 2026-10-11.

## Decision

Keep action selection in the model. Expand bounded, non-executing environment inspection to include verification declarations and actual Git metadata. Never invent project versions, change minimum requirements, execute configuration during inspection, or select a repository-specific repair.

Cloud process tools accept an optional `verification` scope name for a model-selected check. This label records intent, not correctness. The adapter strips it from execution requests and emits a typed observation only from the actual process receipt. Installations and interpreter probes are not implicitly tests. Existing clients retain their behavior.

The kernel derives a bounded verification view from immutable session events, outside lossy context compaction. Scopes stay independent; a newer check for the same model-selected scope replaces its older attempt. A check records its start relative to observed file mutations. Subsequent writes invalidate older checks; running, failed, cancelled, missing-exit and outdated checks cannot establish successful verification. Successful exit establishes only that the selected command succeeded, never that its coverage is sufficient or the entire goal is correct. Completion events can close the same tracked check without launching work.

Show this view on each normal model request. Failed or outdated checks direct the model back to diagnosis, environment inspection or repair, followed by a new focused check. Do not automatically install, select commands, modify source or trigger a model request on process completion. Keep the existing single completion reconciliation and shared budget. Unresolved explicitly requested checks make a claimed completed result partial; an independently observed external prerequisite may still be reported blocked.

Unknown historical receipts remain unknown. Keep evidence references, process IDs and actual outcomes across validated explicit continuation chains; unrelated questions inherit no check obligations. A successful snapshot-derived environment transition transfers pending scopes to the candidate as outdated, never successful, so checking the new environment can resolve the same scopes without requiring a check in the abandoned environment. Do not infer validation from reads, plan completion, successful installation or unlabelled processes. No new database or mutable acceptance store is introduced.

## Validation boundary

The owner requested code first with no additional model calls. Perform necessary static checks only; real behavior, deployment and SWE grading remain unverified for this revision. No mock or replay suite is permitted.
