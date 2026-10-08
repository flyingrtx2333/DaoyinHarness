# ADR-0028: Cloud workspace execution context

- Date: 2026-10-08
- Status: Implemented; actual candidate validation reported separately.

## Evidence

An ordinary authenticated CSV task on runtime `77ec72402fc1a6560fb230b18909a7ed8b3f8fda` had successful Python/gVisor infrastructure preflight, but initial capability routing omitted `resource.runtime`. Read-only capability search could not recover process execution. The model also invented a workspace ID, then used `/` after discovering its real attachment. Generic tool failures did not explain the relative-path contract. The run was cancelled with persisted event 74 and no unfinished tools.

## Decision

Explicit non-negated execution intent with program, language or workspace context pins the existing eligible process capability pack. It does not grant permissions or unconditionally turn file reads into process execution. Existing authorization, high-risk intent checks and capability size budgets still apply.

At turn admission, query the account-authorized resource service for this session's attachments. Only validated server-owned workspace IDs, bounded to 32, enter the dynamic runtime instruction. Titles, file contents and arbitrary resource text remain untrusted tool data. A single attachment identifies the current workspace; ambiguous targets still require discovery. Failure to retrieve attachment metadata prevents a model call. This context does not authorize another account or resource.

File schemas describe workspace-relative paths and require omission of the root listing/search path. Process cwd separately supports `.`. Known input and resource errors return independently specified safe messages; arbitrary service errors, secrets and stack traces remain hidden. Infrastructure process failures retain the run-local circuit breaker from ADR-0027.

Subsequent component deployments may reuse networks inside the already configured dedicated pool only when their internal isolation, workspace label, hashed name and /24 subnet match. Overlapping routes must belong to the same verified bridge and fit that subnet. Foreign overlap still blocks deployment; no existing network is removed or renumbered.

## Acceptance

Use the ordinary account BFF and actual model/tools/persistence path. The Agent must itself execute its program successfully inside gVisor before independent output, input integrity, snapshot and artifact checks. Source/type/lint checks are not behavior evidence. No mock or legacy deterministic suite is an acceptance gate.
