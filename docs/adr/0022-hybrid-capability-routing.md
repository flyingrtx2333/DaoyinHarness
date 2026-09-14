# ADR-0022: Hybrid capability routing for large tool catalogs

- Status: Accepted
- Date: 2026-09-14

Cloud runs filter the account-authorized inventory into capability packs before model exposure. Routing never grants access: discovery and every exact execution retain the existing identity, permission, resource and revocation checks.

The router first removes unavailable tools and packs, then splits the current request into at most six intents. It retrieves packs using deterministic BM25 and optional platform semantic analysis, merges results, covers the detected intents and enforces six-pack, 48-tool and 48,000-schema-character budgets. A run may expand only into eligible read-only packs through the intrinsic capability search tool.

High-risk packs require a trusted current-turn activation predicate or structured UI action. History, embeddings, reranking and classifier output cannot activate them. Semantic failures fall back to lexical routing and then a bounded read-only set; enforcement never falls back to the complete authorized inventory.

Routing decisions are append-only run evidence and contain catalog identifiers, selected packs, counts, timing and fallback state, never classifier reasoning. Production supports off, shadow and enforce modes. Shadow mode is required before enforcement for a new catalog version.