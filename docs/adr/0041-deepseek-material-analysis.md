# ADR 0041: DeepSeek model binding and durable upload analysis

Status: amended 2026-10-10; provider and billing policy follows [ADR 0018](0018-platform-provider-and-account-billing.md).

Harness chat and material understanding use the platform's explicit `daoyin-harness` scene bindings and shared `deepseek` provider. The owner's earlier request meant the unified platform provider, not an independent Harness credential. The old separate provider is disabled and its credential override code is removed. Provider secrets stay in the platform; Harness receives only authenticated, metered receipts.

The four LLM scenes are `agent_turn`, `capability_routing`, `material_actions` and `material_boundaries`. Routing uses local candidate retrieval and shared DeepSeek intent scoring; the obsolete embedding/reranking call paths have been removed. Narration uses the platform speech service with unified account billing.

Uploads remain usable after a parsing failure. Images and videos enqueue durable analysis after their immutable upload fact is committed. A resource worker claims jobs with PostgreSQL advisory locks (released on disconnect, no expiring lease), records running/completed/failed facts, and resumes interrupted jobs after restart. Explicit retry never replaces prior valid analysis or original media. The queue is derived operational state; immutable resource events are the evidence.

Video analysis covers consecutive windows, identifies visible actions, then refines boundaries using additional decoded frames around candidate boundaries. Results include actual timestamps, model, usage receipts and sampling limitations. Reference content remains reference-only. No generated footage or audio is introduced. The first release bounds automatic semantic analysis to 180 seconds per upload, matching the editing capability's maximum output length; longer media retains technical metadata and an explicit analysis failure requiring a shorter upload.

Model operations use the platform's existing idempotency and usage records. An uncertain paid operation is not automatically repeated. Administrator model selection uses the existing AI application configuration UI and tables rather than a second secrets/configuration system.

Validation follows the owner mandate: small actual account/model/tool scenarios only, no mocked model or API tests.
