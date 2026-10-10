# DeepSeek Harness and uploaded-material validation — 2026-10-10

Environment: authenticated `daoyintech` account 1, production cloud on 42.194.159.81. Node 22 independent Linux server; no Windows validation and no mock/model-replay suites. Actual Northeast Hui media were copied into the existing technical validation shop; originals were not modified. No footage, music or speech generation was requested.

## Deployed components

- Platform backend selected source: `aea746420d2376ac283a729a1d76de1b675afa9a`; earlier committed changes included model gateway and strict analysis response validation.
- Cloud Agent: `7b97cce4707a9f04159ba3e528176c5788116348`.
- Resource worker: `0649e8e7df25b8bcd35c102417670e5cec8a054f`.
- Workbench UI: `ffb6c3e438cd4fdc401295f658368b0f6a198b14`.
- Model: `deepseek-flash` (official DeepSeek V4.1 Flash). Four enabled Harness bindings: `agent_turn`, `capability_routing`, `material_actions`, `material_boundaries`.
- Dedicated platform credential `harness-deepseek` matched the actual Yinghuo runtime key by server-side comparison. No provider credential was sent to Harness or the browser. Other apps' global DeepSeek credential remained unchanged.

## Actual cases

1. Real 4.913-second Northeast Hui MP4 uploaded as `res_e664aff01c6af6c85eb9180e`. Its durable analysis completed with three action candidates; actual boundary refinement also called DeepSeek. Confidence was 0.4–0.6 and boundaries overlapped, so this is sampling-based guidance, not reliable exact segmentation.
2. Real Northeast Hui JPEG uploaded as `res_9cc278447fddc5b4d9d1b562`. Persisted scene summary completed; no continuous actions were inferred from the still image. Combined queued video/image completion after retry took 20.842 seconds.
3. New JPEG uploaded as `res_3855c6a6ea4eccf75627cad3`. Commit returned `queued`; automatic worker processing reached `completed` without an explicit parsing request. Its actual provider request took 1.189 seconds, 383 input / 47 output tokens.
4. Agent run `run_8acb998f-bd5e-48c4-904e-2df8db63642c` performed a real `resource_campfire_inspect`, returned persisted duration/action index and completed in 12.835 seconds. Transcript contains corresponding tool started/completed events.
5. After classifier migration, run `run_841ae8e0-0784-478e-b749-5066cd0544b8` repeated the read-only account scenario and completed in 10.700 seconds. Actual usage rows confirm DeepSeek for capability routing (2105 input / 55 output tokens) and both Agent calls (8175 / 62 and 9186 / 404).

## Fixes discovered by live validation

- JSONB object normalization changed nested identity key order while the established resource ownership hash depends on original serialization. Jobs now retain the original serialized identity as a JSONB scalar; failed validation jobs were requeued through the authenticated resource API, with no transcript rewrite.
- Cloud route admission omitted the new `resource_media_analyze` action; the route now accepts it subject to existing account authorization.
- The classifier previously used the shared Saishi/Qwen binding. Account Harness classification now uses its own DeepSeek scene and dedicated credential.
- Image analysis coverage now describes a single still image instead of video sampling. Historical validation facts retain their original text.

## Limits and checks

Provider token usage is persisted. Existing monetary cost rows report `UNCONFIGURED` for this new model; no cost or provider invoice amount is claimed. Embedding and reranking remain dedicated retrieval models (`text-embedding-v3`, `qwen3-rerank`), not chat LLMs. Long videos above 180 seconds remain uploaded but require shorter segments for automatic semantic analysis. An uncertain metered request is not blindly repeated.

Source diff checks, Python syntax checks, necessary Linux TypeScript checks and committed release packaging passed. Public UI revision/asset hashes and service readiness were checked. Browser automation repeatedly timed out connecting to the existing Chrome tab; desktop/narrow-screen visual acceptance was not performed. Local OAuth model path was changed to the Harness scene but was not separately exercised; the validated product path is authenticated cloud execution.
