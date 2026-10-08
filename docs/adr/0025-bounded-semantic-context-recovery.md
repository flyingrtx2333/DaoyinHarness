# ADR-0025: Bounded semantic context and rejection recovery

- Date: 2026-10-08
- Status: Implemented in source; real-model acceptance and release reported separately.

## Decision

The shared engine may condense completed historical turns with the authenticated runtime's existing ModelClient. This is a tool-free model request, at most once per turn, charged against the same request limit and cloud accounting as task execution. It reserves capacity for continuing the actual task. The summary source contains persisted dialogue and bounded tool observations, complete selected turns, a verified predecessor summary and explicit omitted ranges; its serialized input is limited to 40,000 characters. This is a size bound, not an exact token estimate.

Compaction remains append-only derived state. New v3 envelopes contain source ranges, the SHA-256 digest of the currently visible event prefix, the summary strategy and omission/truncation markers. Reuse requires a matching digest. A memory-aware turn supplies its freshly filtered events and checks memory revisions before and after summarization and persistence; legacy or invalidated summaries never return to its model context. If invalidation cannot advance the store's strictly increasing watermark, the engine uses filtered original history without publishing a replacement at the same watermark. Original events and previous summaries are never changed or erased.

Ordinary summarization failure uses an explicitly lossy deterministic projection. Cancellation, authorization, identity, memory validation and quota failures propagate. A failed summary never replays its source tools. Summary output remains untrusted reference data, never authority or evidence of a current resource state.

Only a structured, allowlisted `MODEL_CONTEXT_TOO_LARGE` rejection before any public output permits one reduced model request per turn. Reduction preserves the current user goal, system policy, tool arguments and complete latest call/result group. Historical dialogue and observation previews may shrink, with omission receipts. The engine verifies that the actual serialized request becomes smaller. Both requests consume the original model budget and cloud audit path; no completed tool is replayed. Timeouts, network uncertainty, partial streaming, authorization failures and arbitrary provider messages do not trigger recovery.

Cloud resource `file_read` already supports bounded line ranges and maximum bytes. Reuse that existing capability for large-input tasks; this change does not add a separate local file-reading contract.

## Acceptance

Follow [ADR-0026](0026-cloud-only-product-and-validation.md): use only small actual-model tasks through the authenticated server-hosted cloud runtime, actual resource tools and immutable event storage. Record the deployed runtime revision. Verify generated program output, data statistics and multi-turn constraint retention independently of assistant claims. A real context-rejection recovery requires an actual classified Gateway rejection; normal task success alone does not prove it. Memory invalidation requires a real forget/revocation scenario before claiming that behavior validated.

SWE-bench inference uses the same ordinary workspace and execution contracts, exact dataset base revisions, no gold/test patch in model context and exported actual Git diffs. Only the official grader determines resolved. Infrastructure blockers, ungraded patches and model/task failures are distinct outcomes. The repository's real-model-only testing mandate remains in force.
