# Provider cleanup — 2026-10-10

## Scope and deployed state

- Platform committed source overlay: `b43965dabf52b248e41de6a644ff813bd4142fbe`.
- Harness cloud runtime: `e131d81abd1f91d8f430c69c1c4911a80b9582f5`.
- UI was unchanged and remains `e4285aca5bc7ad5492de8de6789afdde2653052f`; no UI release was necessary.
- Removed all `credential_provider_key` override reads, the unreachable embedding implementation, unused document serialization/imports, loading an obsolete Saishi routing binding before replacing it, and the cloud vector adapter that only returned empty scores. Kernel local retrieval remains in place. Backend empty retrieval receipts remain compatible with older clients.
- Updated ADR 0041 to the shared platform provider decision. Historical evidence documents and disabled provider records remain for provenance. Cached old narration compatibility remains to prevent repeated generation/charges.
- Production configuration verified: `agent_turn`, `capability_routing`, `material_actions`, `material_boundaries` each resolve `deepseek` / `deepseek-flash` without a separate credential override. Old `harness-deepseek` is disabled. Credentials were not printed or copied.

## Real account/model/tool proof

Used the existing authenticated user 1 account and actual production cloud/storage path, with a read-only request selected through the same structured marker as the workbench's Campfire picker. No narration, music, video generation, upload or resource modification was requested.

Input: “只读取这个店铺的真实资料，并报告店铺名称和主营品类。不要生成、上传或修改任何内容。” Shop `res_4fad430cc14b89adaf21a979`.

| Stage | Run | Outcome | Tool | Latency | Actual cost CNY |
| --- | --- | --- | --- | --- | --- |
| Before cleanup deployment | `run_72488fa7-37e3-4bd4-b058-5b5a143bbc93` | completed; 东北荟 / 东北菜 | resource_campfire_inspect | 10763 ms | 0.00866664 |
| After cleanup deployment | `run_9f1caf13-8c65-4839-9f18-013cae9b6760` | completed; 东北荟 / 东北菜 | resource_campfire_inspect | 10790 ms | 0.01222040 |

Before usage IDs 15163–15165 and after IDs 15166–15168 each contained one DeepSeek routing call plus two DeepSeek main-model calls. All were CALCULATED and settled exactly once. No independent provider, embedding, reranking or speech call occurred in either scenario. After wallet: 37.16878116 → 37.15656076 CNY; exact balance delta equalled priced usage and settlement sum. Different token/cache counts explain different costs; provider-reported cache hits were preserved.

## Other observations and limits

Two exploratory plain-text requests made before deployment did not retrieve the shop: one rejected an invalid model tool call (`run_9276c029-8942-4eaf-93a8-1d8a2115ac33`), and one only called capability_search / memory_search and reported inability to retrieve (`run_a73e0213-2cbc-4961-8577-947fe12c2b48`). They are not successful store-read evidence. The reproducible picker scenario passed before and after. Plain-text read-only capability selection is an existing limitation outside this structural cleanup.

Changed Python syntax reviewed; independent Linux server / Node.js 22 cloud typecheck and exact revision packaging passed. Source hashes, readiness and protected service checks passed on release. No Windows checks, new vision analysis or browser interaction checks were performed. No mock, legacy regression or replay tests ran. This small sample verifies the stated scenario, not general routing reliability.
