# ADR 0041: DeepSeek model binding and durable upload analysis

Harness chat and material understanding use the main platform's explicit `daoyin-harness` scene bindings. The owner requested DeepSeek V4.1 Flash (`deepseek-flash`) and the same server-side credential used by Yinghuo. The existing global DeepSeek credential differs from Yinghuo. Store the requested key in the separate platform provider configuration `harness-deepseek`, while retaining `deepseek` as the model/provider billing identity. Other applications keep their existing key. Provider secrets stay in the platform; Harness receives only an authenticated, metered analysis receipt.

Uploads remain usable after a parsing failure. Images and videos enqueue durable analysis after their immutable upload fact is committed. A resource worker claims jobs with PostgreSQL advisory locks (released on disconnect, no expiring lease), records running/completed/failed facts, and resumes interrupted jobs after restart. Explicit retry never replaces prior valid analysis or original media. The queue is derived operational state; immutable resource events are the evidence.

Video analysis covers consecutive windows, identifies visible actions, then refines boundaries using additional decoded frames around candidate boundaries. Results include actual timestamps, model, usage receipts and sampling limitations. Reference content remains reference-only. No generated footage or audio is introduced. The first release bounds automatic semantic analysis to 180 seconds per upload, matching the editing capability's maximum output length; longer media retains technical metadata and an explicit analysis failure requiring a shorter upload.

Model operations use the platform's existing idempotency and usage records. An uncertain paid operation is not automatically repeated. Administrator model selection uses the existing AI application configuration UI and tables rather than a second secrets/configuration system.

Validation follows the owner mandate: small actual account/model/tool scenarios only, no mocked model or API tests.
