# Existing-film delivery and original-film comparison

Date: 2026-10-09. Full ADR-0035 production parity remains unproven.

## Deployed revisions

Resource service `1800376a12f01ce2c07db6ba1b743a13a565921c` returns `completed: true` and a concise completion summary only after the output manifest and successful render fact have been persisted. Reusing an already completed plan also returns `reused: true` and its existing asset. No historic facts are rewritten. Exact pushed objects were built and released on the independent Linux server; resource readiness passed. Agent runtime remained `ca59e62bd0209985cb1be8cc669bfb8e9eacd81c`. UI release is `f6a5777b63d96f2eea30e2675a3c16a33ed96869`; its final change removes the redundant Campfire picker paragraph. Protected services were unchanged by that UI-only release.

UI subsequently released `195b5dd28377e21e9ba3bfdbfa629f6c31ab1be2` after the real completed conversation exposed a missing player: `CampfireResults` previously recognized only render receipts. It now also recognizes successful `resource_campfire_inspect` receipts, validates the asset manifest and accepts only `output_video` / `video/mp4`. Raw model text and reference/shop videos do not create output players. Asset IDs are deduplicated per turn; existing authenticated media URLs and account isolation are retained. Exact public artifact hashes matched and protected services remained unchanged.

Focused TypeScript and diff checks passed on macOS Node 22.23.2. Server builds used Linux Node 22.23.2. Windows validation was not performed. These checks do not prove model behavior.

## Actual authenticated delivery scenarios

Both scenarios use the existing daoyintech account, authenticated AI Gateway, actual Agent tools and persisted resource facts. Input: deliver the completed Northeast restaurant plan `res_725201c7ec7f687c8a4a861e`, reuse the existing output, do not create a plan or any media, and return its ID, duration and preview availability. The prompt explicitly names `resource_campfire_render`; this is a guided existing-film delivery case, not autonomous first-draft production.

1. Run `run_b43df196-3d9a-4da2-9a4a-447729c72fee`, session `ses_5c73ae40-a9c5-415f-b71f-45a46c575f33`: actual status lookup followed by render reuse returned the existing asset and completion summary. The driver cancelled when the third main call was requested under its two-call scenario limit. Terminal state is `cancelled`; successful tool reuse does not establish completed conversation delivery.
2. Run `run_563ba832-449c-42db-bd27-e51e57ed231d`, session `ses_ee713edf-aefd-400f-a329-51e96f49a0f0`: terminal `completed` after three main calls and actual status/inspect tools, with no plan, render or generation action. The model chose to inspect the existing output instead of calling render reuse. Final text identifies `res_737fd50f85d2104ecc89e3ab`, 12.011 seconds, 1920×1080, 30fps, MP4 and preview availability. Driver interval: 30.633 seconds. Two auxiliary routing calls were cancelled and routing fell back to lexical selection; no unfinished tools remained. This verifies completed existing-film delivery, but does not independently validate the new render flag or obey every suggested tool choice in the prompt.

Limits in these messages and external drivers are not structured `maxModelCalls` requests. The workbench BFF accepts `requestId` and `message`; the kernel's default twelve-call shared budget still applies. Neither cancelled case proves an enforced kernel budget violation. The evidence captures actual model replies, but diagnostics do not expose provider model ID, token settlement or cost; these are unavailable for this report, not inferred from earlier runs.

Ignored local receipts: `.cache/campfire-completion-live/report.json`, `.cache/campfire-completion-three-live/report.json`. No mock, canned-response, replay or legacy regression suite was used.

After the UI fix, the actual authenticated Chrome conversation displayed its existing-film player and download link. Media metadata loaded at 1920×1080, duration12.010667, readyState4; native playback was unpaused and advanced from0.015 to8.641 seconds without a media error. Desktop1200px and390/320px viewports had document scroll widths equal to viewport widths; narrow video widths were350/280px respectively. Temporary viewport overrides were reset. Actual screenshot: `.cache/campfire-parity-review/existing-film-inline.png`. This checks the real saved conversation and protected video; it does not rerun or simulate the model.

## Original-film comparison and remaining quality gap

Actual existing files were inspected, without passing the original output into production generation:

| Property | Original Yinghuo output | Current native output |
| --- | --- | --- |
| File | `.cache/dongbeihui-source/original-comparison.mp4` | `.cache/campfire-aligned-ducking-live/narration-only.mp4` |
| Video | 1080×1920, 30fps | 1080×1920, 30fps |
| Duration | 27.100 seconds | 29.000 seconds |
| Framing observed | Central landscape footage with blurred background | Central landscape footage with blurred background |

Six real frames at 0/5/10/15/20/25 seconds show the original progressing through storefront, hall, food spread, dish close-up, serving and busy hall. The native output repeats more round-table and hall imagery and has less dish close-up coverage. This sample does not establish every shot or caption's correctness, or equivalent listening quality. Native output is an assisted repair result, not proof of stable autonomous first-draft quality.

FFmpeg scene-change threshold 0.35 detected four boundaries in the original and fourteen in the native film; these are heuristic detections affected by motion, not exact shot counts. Contacts and cut receipt: `.cache/campfire-parity-review/original.png`, `harness.png`, `cuts.json`.

Original captions include price and opening-promotion claims not independently supported by the current shop facts. They cannot be copied to achieve visual parity. Remaining work includes stronger reference-to-material shot selection, autonomous first-draft validation and full ADR-0035 requirement-by-requirement acceptance. The separately identified legacy Story table-name issue still awaits authorization for that service change.
