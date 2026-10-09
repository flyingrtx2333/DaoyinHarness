# Material library masonry and actual image streaming

Date: 2026-10-09. Scope: the user-supplied Yinghuo library layout, existing account materials and previews. No new video, AI shot, narration, music or quote was generated.

## Implementation and publication

- Harness UI: `e857c637864f8eec63e1641e4607cc2c38e7d27c`, including layout commit `4e05b39f9acbde0f0e748eb34c6bfc174536eccd`.
- Actual main-platform media adapter overlay: `629a5843b989f91a50fd86109447b3e10ad715a4`; the running backend image retains its prior overlays and replaces only `services/harness_media_stream.py` from that commit. This is not a whole-platform checkout deployment.
- Exact pushed UI Git objects were built and published on the independent Linux server with Node 22.23.2. Public artifact hashes matched; the Agent, resources, executor and original Yinghuo service process identities remained unchanged.
- Focused UI TypeScript and diff checks passed on macOS Node 22.23.2. Python AST check passed for the adapter. These are static checks, not Agent acceptance. Windows validation was not performed.

The library uses two source tabs, media type filters, a submitted title search, actual visible counts, upload dialog and working masonry/list controls. Native visuals retain their actual image/video aspect ratios in one gallery, up to five desktop columns and two narrow columns. Names appear on hover or keyboard focus; documents and audio keep visible identification. Store uploads and reference videos stay separate from output videos through existing resource roles. Profile editing, file types and account-scoped pagination remain available. No reference code, snapshot assets, branding or invented recognition counts were copied.

## Actual account/browser observations

Authenticated production at https://harness.daoyintech.com/ using the existing daoyintech login, macOS Chrome:

- Native list returned 33 actual materials: 18 store/reference/support items and 15 existing output videos. No fixture assets were inserted. The first page now requests up to 100; a cursor continues to expose load-more where applicable. Search applies to loaded items, not unloaded pages or a claimed global server index.
- Image filter showed three actual images; video filter showed nine actual store/reference videos. Searching `raw_mupq5yox4un` yielded exactly its one existing video; clearing restored the list. List and masonry controls changed the actual gallery.
- Actual JPEG `raw_mupq5za06gn.jpg` opened in its dialog at 4032 by 3024 pixels. Actual `raw_mupq5yox4un.mp4` reached ready state 4 at 1280 by 720, duration 14.433991 seconds, and played through 14.269 seconds with no media error observed.
- Upload dialog displayed real shop options, selecting Northeast restaurant enabled file selection, and profile entry could be opened and cancelled without a write. No new upload or profile mutation was made during these checks.
- Document client/scroll widths matched at 1440, 390 and 320 pixels. Desktop used five columns; both narrow widths used two. Filters, search and view controls remained visible.

## Image failure and responsible fix

Before the adapter fix, two actual JPEGs and one PNG returned HTTP 502 `MEDIA_RESPONSE_INVALID`. The actual upstream Nginx configuration gzips image types; httpx defaults permitted compressed responses whose transfer length no longer described original media bytes. The adapter now requests `Accept-Encoding: identity` and rejects a non-identity response, preserving original length/range/type checks.

After publication, the same three protected media requests returned HTTP 200 with actual JPEG/PNG signatures and exact received byte counts matching stored sizes: 728257, 912849 and 501871. SHA-256 receipts are in the ignored diagnostic artifact; ownership and existing byte/range restrictions were preserved.

## Remaining limitation

The pre-existing project/story asset endpoint still returns HTTP 409 `STORY_OPERATION_FAILED`. Store browsing no longer calls it; the generated tab honestly reports its project load failure while showing actual native output videos. This report does not claim that legacy endpoint or complete original-film visual/audio parity is fixed. No real-model calls were needed for this UI/media read change; no mock, replay, Vitest or paid business generation was performed.

Local ignored evidence: `.cache/campfire-masonry-live/media-diagnostic-before.json`, `media-diagnostic.json`, browser screenshots and `.cache/campfire-release/masonry-ui-deployment-report.json`. Deployment and browser observations are distinct from model evidence.
