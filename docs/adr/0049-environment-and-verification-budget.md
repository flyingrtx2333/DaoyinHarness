# ADR-0049: Environment evidence and verification budget

Status: accepted, 2026-10-11

## Evidence

The fixed real sample used an interpreter outside the project's published Python classifiers, spent six tool calls waiting for one dependency installation, and exhausted tools before checking compatibility of a changed public serialization format. Two existing consumers failed because their required fields disappeared. Separately, a preparation/probe command carrying the same model-selected verification name can replace an actual failed check in the current projection.

## Decision

Return the trusted runtime catalog with environment inspection and derive bounded runtime hints from declaration text without executing project code. Numeric pins (including major/minor prefixes) can be compared with actual interpreter output; a matching pin, minimum constraint or published classifier does not prove compatibility. Report unknown/unconfirmed evidence, available candidate IDs and declaration sources; the model chooses whether to prepare a candidate. No automatic runtime selection, invented version or repository rule is introduced.

Track attempted tool use by capability-owned role and expose a suggested reserve derived from actual changed resources, unresolved checks, pending operations and plan steps. This is scheduling advice within existing tool/model/time allowances, not a second quota, forced mutation, or extra model request. Keep dependent reads available. Encourage coherent changes, one tracked operation, focused reproduction plus affected existing behavior, and plan closeout before optional exploration.

A verification scope is a model label, not check identity. Bind new process-check evidence to a hash of the exact executable, arguments, normalized cwd, stdin and explicit environment, excluding process IDs, deadlines and workspace IDs. Never persist raw arguments in this identity. Only a rerun of that same check may replace it; another command with the same label retains a separate obligation. Preserve legacy events without rewriting them; unidentified legacy checks retain their legacy scope and are not silently cleared by new identified commands. Process observations can update only their own receipt, and old observations cannot replace a newer rerun or restore current workspace versions after a recorded mutation. Completion receipts remain readable even when no longer current evidence.

Acceptance remains a model assessment supported by real evidence, not an exit-code-only correctness claim. Installation and diagnostic commands must not carry acceptance scope names. Public APIs/data formats need both reproduction and affected existing behavior checks selected from project declarations. Failed checks must be corrected and rerun against the final source version; insufficient budget is partial.

## Validation boundary

The owner requests code and necessary static/package checks only for this iteration. No new gateway/model calls, official grading, replay or mock tests. Earlier official results remain 2/3 and do not validate these changes. Deployment is not part of this code-only iteration.
