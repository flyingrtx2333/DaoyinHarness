# ADR-0018: Agent-maintained cloud memory

> Testing policy superseded later on 2026-09-07: do not add or run simulated/replay suites. Future behavior validation uses small-sample real-model calls only; see [TESTING.md](../TESTING.md). The acceptance numbers below are historical, not current gates or real-model evidence.

Date: 2026-09-07
Status: implemented and validated in the independent Linux server clone; not deployed

## Decision

The authenticated cloud Agent maintains ordinary durable memory during its existing tool loop. A management page is a visibility/override surface, not a prerequisite for every ordinary write. Keep the current `acceptRun -> startRun` single-instance lifecycle; no queue, worker, extra model, background extractor, production migration or platform permission changes are part of this iteration.

Implement first-party `memory_search`, `memory_remember`, `memory_update` and `memory_forget` bindings over the existing SQL repository. Require the existing authenticated `memory.read` / `memory.write` permissions AND delegated tool names. Do not manufacture grants, widen business tool permissions, or expose these tools to public visitors. Organization records continue to require the existing organization-level read/write permissions; autonomous maintenance does not confer additional rights or remove ordinary account rights. If the upstream platform does not yet delegate the kernel tools, they remain unavailable rather than silently acquiring rights.

The Saishi profile supplies fixed kernel memory descriptors for model-response validation by the existing platform adapter. The cloud server discards profile-supplied memory executors and installs only its own run-bound implementations. Memory operations execute in Harness, never via a business backend call endpoint. Public sponsorship and private app credentials remain separate and unchanged.

Ordinary autonomous writes are atomic and immediately active. User-management proposals retain their reviewed `pending -> active` lifecycle. Autonomous records carry distinct agent provenance, the authenticated current user event or completed non-memory tool result, the memory invocation event, and a digest of a bounded exact source excerpt. Do not duplicate the excerpt in stored source metadata. Source linkage does not establish that the model's paraphrase is true; label provenance accurately and evaluate semantic extraction separately. Credentials are rejected in body, key and keywords. Current task progress belongs to run/workflow state, not durable memory.

Keep stable keys, idempotency, optimistic revision checks, version chains and audit metadata. Never implement autonomous writes by invoking the human confirmation endpoint. A fresh operation cannot overwrite a stale revision. An exact retry must not resurrect forgotten data. A forgotten stable key currently requires a new user-management proposal and confirmation to restore; dedicated chat restoration authorization and semantic/topic-level erasure are future work.

## Context lifecycle

Before inference, include at most two allowlisted response preferences within the bounded recall budget and query-relevant memories. The model may explicitly search for more. Search-result references join the run dependency set before results are exposed, including results that did not match automatic recall.

A committed memory mutation is a context boundary: retain only metadata receipts for earlier operations, discard earlier memory-influenced in-turn model text/tool payloads, defer unexecuted calls from that model batch, load current memory, and let the model replan. A trusted run-local transition receipt permits ONLY the exact superseded/forgotten revisions changed by that run; externally changed versions, grants and access revocation remain fail-closed. Old reference audit rows remain append-only. Do not replay prior side effects.

A trusted runtime note is budgeted separately from complete tool-call/result groups. Do not weaken the group integrity checks merely to insert a memory-refresh receipt. This conservative boundary can require rereading business data; finer dependency-aware preservation is deferred.

## Storage and compatibility

Use existing SQLite/PostgreSQL tables, with agent provenance in the existing source JSON and new audit action strings. No production schema change is required by this decision. Shared/local JSONL behavior remains unchanged. Cross-app sharing policy changes and physical deletion of transcripts/backups are not claimed here.

## Acceptance evidence

See [2026-09-07 validation](../VALIDATION-20260907-MEMORY.md). In the independent server clone, typecheck, lint and build passed. Full test execution with an isolated PostgreSQL 16 test container passed 399 tests across 72 files, including 8 PostgreSQL integration tests. The container was stopped after verification and used no production database or user volume.

The 22 added tests cover autonomous lifecycle, cross-session recall, restart persistence, version refresh, same-batch deferral, explicit-search dependency tracking, false provenance and credential rejection, public/undelegated access, repeated delivery, gateway/profile compatibility and real PostgreSQL transactions. Models, platform authorization and business responses are simulated. These are not Windows shared-checkout results, genuine model-quality scores, real-account grant validation, or production deployment evidence.
