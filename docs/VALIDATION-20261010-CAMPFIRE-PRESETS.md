# System references — actual cloud validation, 2026-10-10

Resource worker and UI revision: `de09924fbd2a888d150a148b717b7284ab04b83e`. Both were built from server Git objects and published. Independent Linux Node 22 cloud/UI type checks and release packaging passed; no mocked model or API tests ran. The cloud Agent was not restarted for this change.

The published source catalog contains three actual MP4s, verified by size, SHA-256 and ffprobe: 螺蛳粉小火锅 · 新店开业 (37.433333s), 新店开业 (57.816009s), 自助烧烤 · 超值畅吃 (63.566667s). Original files are retained; Harness stores deduplicated verified bytes and independently authored metadata. No original analysis results were copied.

Authenticated actual account 1 retrieved all three system presets with `resource_campfire_list`, `filterRole=reference_video`, `limit=1`. A second request returned identical IDs, proving idempotent account defaults and pagination-independent preset access. All three `resource_media_read` responses contained actual MP4 bytes; the first preset's thumbnail path succeeded. No browser upload was made.

Real DeepSeek Agent run `run_160798d0-00f3-4dcc-a69d-27833ce7a735` inspected the first preset at 0–3 seconds, returned actual 37.434-second duration and scene/cut observations, then completed. Corresponding tool lifecycle events persisted. No plan, footage, music or narration was generated.

Account-owned preset handles were `res_57b896b614df16fea91de80f`, `res_54560b87d308d3df3e2ed303`, `res_258a1964b150b4265a0ebc08`. The implementation provisions handles per authenticated account; a second account was not exercised. Private shop resources retain ordinary ownership checks.

Public UI revision and all asset hashes matched. Actual visual/browser verification remained blocked: Chrome CDP connection timed out; native Chrome binding reported an unavailable window. Desktop/narrow visual fidelity is not claimed.
