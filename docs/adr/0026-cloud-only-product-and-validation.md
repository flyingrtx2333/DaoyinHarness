# ADR-0026: Cloud-only product entry and validation

- Date: 2026-10-08
- Status: Owner direction recorded; cloud validation and deployment remain separate.

## Decision

The owner clarified that development is performed through a remote Codex connection and the local Harness product path has been abandoned. The active product is the server-hosted cloud workbench at `https://harness.daoyintech.com/`, using the existing daoyintech account/password sign-in at its cloud login page. Reuse the account session, ordinary BFF and execution authorization; do not add local OAuth, account substitutes or pasted model-provider credentials to this workflow.

When a development service is hosted on the remote Codex machine, discover its current Tailscale address and actual listening port before sharing a URL. A loopback URL on that remote machine is not the user's browser origin. The production cloud workbench uses its public HTTPS domain. Do not widen a legacy local runtime's Host/Origin checks to make it appear to be the cloud product.

Shared AgentEngine improvements remain applicable to the cloud kernel. Newly added non-Windows local OAuth fallback and duplicate local file-range changes were withdrawn from this task. The added local-only real-task and SWE-bench runners were withdrawn; no model calls had occurred. Historical local packages remain for provenance, not current product acceptance.

## Acceptance

Real-task and SWE-bench acceptance must use ordinary authenticated cloud sessions, resource bindings, tools and immutable event storage, with the actual server runtime revision recorded. A local AgentEngine/Gateway/JSONL run does not satisfy this requirement. Follow ADR-0024: ordinary Git workspaces and the official grader, without a SWE-specific kernel or fabricated model/business evidence.

For a frozen benchmark, initialize a dedicated ordinary empty Git workspace with the exact base revision using the existing policy-checked cloud process capability. Do not expose later refs from a full clone. Export the actual working-tree patch against that base, including new files; HEAD-relative export alone cannot prove correctness after an Agent commit. Preserve actual cloud session/run identifiers and model audit evidence rather than manufacturing the earlier local report format.

Source changes are not deployed changes. Read-only production checkout/runtime inspection requires working server access; publishing or switching the production runtime still requires explicit deployment authorization under the repository rules. An accessible static page or its release revision is not proof of the Agent runtime revision, authenticated model access or sandbox readiness.
