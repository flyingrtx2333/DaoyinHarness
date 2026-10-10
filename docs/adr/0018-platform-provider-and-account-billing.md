# ADR 0018: Platform provider and account AI billing

Status: accepted, 2026-10-10. Owner requested a shared DeepSeek provider and unified billing.

Harness text, vision and semantic routing use the platform `deepseek` configuration. Provider secrets stay in the platform. Workbench routing uses local candidate retrieval plus DeepSeek intent scoring; no separate embedding/reranking provider is required. Speech uses the platform speech provider because the text/vision API is not a speech generator.

New successful `daoyin-harness` platform usage is priced from actual provider usage and settled in the existing account wallet. Usage insertion, pricing and wallet settlement share a transaction, with serialized wallet locking and a unique usage-id settlement key. Cached operations are not new provider calls. Historical usage is not retroactively charged. Missing pricing or settlement fails visibly and preserves the usage evidence. Available credit is checked before paid calls; actual cost can exceed the last available cents in concurrent calls, leaving a visible balance debt that blocks later admissions. This is actual-cost settlement, not a hard pre-reserved spending cap.

DeepSeek Flash pricing records cache hits and the provider request start time; peak/off-peak rules use Beijing time and the published holiday calendar. Pricing calendar maintenance is required before 2027. Missing time/calendar must never be priced as free.

The workbench refreshes account balance on terminal events. No provider credential or duplicate wallet is added to Harness storage.
