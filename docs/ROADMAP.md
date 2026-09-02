# DaoyinHarness Roadmap

> Status: implementation sequence. A phase is complete only when its exit criteria are met.

## P0 — Documentation and repository baseline

Deliverables:

- independent Git repository on `main`;
- README, repository rules, architecture, protocol, auth, security, testing and ADRs;
- local reference directory ignored and absent from the Git index.

Exit criteria:

- all internal Markdown links resolve;
- terminology and public names are consistent;
- `git diff --check` passes;
- one focused `docs:` commit contains no implementation or main-platform change.

## P1 — npm CLI and local shell

Deliverables:

- npm workspace skeleton and locked Node.js 22 toolchain;
- published-package layout for `@daoyin/harness` and `daoyin-harness` binary;
- loopback Fastify server, static React UI and `/api/v1/health`;
- port scan `4677..4699`, explicit-port failure, `--no-open`, `--data-dir`, `--log-level`;
- process diagnostics and clean shutdown.

Exit criteria:

- packed tarball installs on clean Windows, macOS and Linux Node.js 22 environments;
- default and explicit port behavior passes integration tests;
- browser displays local health with no cloud credentials;
- package audit excludes local reference and runtime state.

## P2 — Daoyin PKCE login

Deliverables:

- main-platform OAuth client and endpoints defined in [AUTH](AUTH.md);
- local PKCE flow, callback, browser session, CSRF and OS credential-store adapters;
- authenticated user summary and logout;
- user-token-authenticated AI Gateway contract available in a non-production environment.

Exit criteria:

- positive, replay, redirect, origin, CSRF, refresh and revocation tests pass;
- tokens are absent from localStorage, URLs, logs, transcript and SQLite;
- account switch cannot mix data namespaces;
- platform changes are independently reviewed and deployed before production claims.

## P3 — Workspace, persistence and recovery

Deliverables:

- account/project data layout and workspace confinement;
- append-only transcript, SQLite materialized view and rebuild command;
- project/session/turn state machines;
- immutable checkpoints and atomic current pointer;
- cancellation, crash recovery and context compaction primitives;
- turn, project and local cross-project memory records.

Exit criteria:

- acknowledged messages survive forced exit and restart;
- truncated transcript and stale SQLite index recover safely;
- failed candidates do not replace usable checkpoints;
- path traversal and symlink/junction escape tests pass;
- memory retrieval exposes source IDs and respects account/project scope.

## P4 — Agent loop, model gateway and tools

Deliverables:

- normalized model streaming client through the Daoyin AI Gateway;
- durable Agent loop and structured tool registry;
- file, search, web inspection, named package/build/test and diagnostic tools;
- real-time persisted events, progress UI and final error summarization;
- inbox semantics for cancellation, correction and additional requirements.

Exit criteria:

- deterministic replay suite covers success, multi-tool, interruption and failure;
- one terminal event and one final assistant response exist for every turn;
- raw tool payloads never render as chat messages;
- direct URLs remain inspectable when search is unavailable;
- real-model gate completes the minimum application scenario within budget.

## P5 — Build, evaluation and local preview

Deliverables:

- named build/test/preview process policies;
- evaluator for required files, build, routes, browser runtime and optional interactions;
- isolated preview origin and sandboxed UI integration;
- candidate/usable/rejected checkpoint workflow;
- reliability dashboard backed by evidence-level reports.

Exit criteria:

- a simple one-page application reaches a usable preview in one normal turn;
- refresh and reconnect preserve all messages and progress;
- route or runtime failure remains blocking while optional capability gaps are follow-up work;
- UI never claims a missing preview exists;
- Windows, macOS and Linux packaged E2E suites pass.

## v1 release

v1 is P0 through P5. It includes the local closed loop and Daoyin account/model access. It does not wait for P6.

Internal beta requirements are defined in [TESTING](TESTING.md). Public npm publication is a separate product and security decision after internal beta evidence.

## P6 — Optional cloud and channels

Potential deliverables, each requiring its own ADR and threat model:

- immutable COS snapshot backup and cross-device restore;
- verified public preview and publish domains;
- encrypted cloud project metadata;
- 微信、飞书、QQ channel identity binding, unified conversation and completion delivery.

P6 cannot change local project files from another device without explicit conflict and authorization semantics. COS remains snapshot storage, not an active workspace.
