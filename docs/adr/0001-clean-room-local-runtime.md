# ADR-0001: Build an independent clean-room local runtime

- Status: Accepted
- Date: 2026-09-02

## Context

`D:\AllProjects\DaoyinHarness\claude-code-main` is a local reverse-engineered/decompiled restoration of another product. Its own documentation describes a Bun terminal application with a large Ink UI, provider compatibility layers, native modules and many features that DaoyinHarness does not need. The local copy does not include a license file.

DaoyinHarness needs selected behavioral properties—durable turns, tool loops, transcript replay, interruption, recovery and evidence-backed completion—but targets a browser UI, Daoyin account system, local web-project workspaces and a substantially smaller security surface.

## Decision

DaoyinHarness will be implemented independently from written product requirements, public standards, observable behavior and independently authored tests.

The reference directory is ignored by Git and package tooling. Contributors may study behavior and write neutral requirements, but may not copy source code, type definitions, prompts, file layouts, UI text, assets, branding, compiled output or decompiled symbol names.

The new implementation uses Node.js 22 and npm workspaces rather than inheriting the reference's Bun/Ink architecture. Compatibility with the reference's private API or configuration files is not a goal.

## Consequences

Benefits:

- clear ownership and provenance;
- a smaller architecture matched to the product;
- no dependency on reference internals or feature flags;
- browser and local-server security designed from first principles;
- requirements and tests can evolve independently.

Costs:

- slower initial implementation than copying modules;
- behavioral contracts must be specified and tested explicitly;
- the team cannot treat the reference's feature completeness as DaoyinHarness progress.

## Guardrails

- `.gitignore` excludes `/claude-code-main/`.
- CI audits package contents and prohibited paths/strings.
- Code reviews reject unexplained structural or textual similarity.
- Provenance uncertainty is resolved by replacing the implementation with a contract-driven version.
- Any change to this decision requires a superseding ADR and legal/provenance review.

## Rejected alternatives

### Directly modify the reference

Rejected because it imports irrelevant complexity, unclear provenance and a runtime/UI model misaligned with the target product.

### Selectively copy the Query Engine

Rejected because seemingly isolated modules depend on private types, global state, prompts and tool conventions. Reimplementation from an event contract is safer and easier to test.

