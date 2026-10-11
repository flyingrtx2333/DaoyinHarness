# ADR-0046: Task-scoped execution projections and stable environments

Date: 2026-10-11. Status: Accepted. Extends ADR-0044 and ADR-0045.

## Decision

Session is the transcript container; a task consists of the current turn and its trusted explicit continuation ancestors; a run grants one allowance. Use this single derived task boundary for plans and verification. Do not create a second mutable task database or infer continuation from message text. Historical plan events remain immutable and accessible as evidence; an independent task starts with no inherited plan. Preserve budget defaults.

Derive current execution state once and then consume append-only events after the latest sequence. Keep all unresolved verification scopes; bound model context separately and show unresolved items first. Context truncation cannot permanently mark a task incomplete. Actual process, Git and file mutation observations invalidate earlier verification; unobserved changes remain unknown. Resource versions and check receipts belong to the resource capability, not command-name guesses in the kernel.

Dependency environment identity uses image, installation-affecting declarations and runtime environment options. Diagnostic documents and test selection do not change dependency directories. Inspect only relevant interpreters/managers plus bounded source metadata, using trusted probes and preserving sandbox, network, secret and cancellation policy. Inspection does not execute project configuration or make repository-specific repairs.

Environment preparation captures a source snapshot under the existing workspace serialization boundary, rejecting running source writers. Operation identity is distinct from its argument digest. Observe an existing operation without restarting it. An explicit retry may create a fresh operation only after the prior outcome is known and tied to the same owned workspace; uncertain or running outcomes cannot be replayed. Success remains a candidate workspace, never verification success.

Keep action selection in the model, one completion reconciliation and root shared budgets. Introduce no benchmark-specific code, new planner model, scheduler or platform contract. Static checks and actual acceptance are reported separately.

## Acceptance allowance

The owner explicitly authorized a new allowance of at most 100 shared model requests and RMB 5 for real scenarios and SWE-bench, retaining the current model. Reserve against known configured rates before transport and stop on unknown pricing, insufficient reserve or the request cap. Prior 160-request ledger is immutable; this allowance uses a separate ledger. Recheck account authorization and deployed revision. Only retry affected scenarios after a diagnosed failure; retain every patch and independent official result, including failed and empty patches. Mechanism acceptance does not guarantee all samples pass.
