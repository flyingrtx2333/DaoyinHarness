# Actual reference shot-center sampling

Date: 2026-10-09. ADR-0035 parity remains in progress.

## Change

Commit `83891097a8e0a8c89d663a2f20bb9ac031ccf678` changes media inspection to append analysisVersion3, leaving prior analyses immutable. Reference scene detection runs before extraction. If at least six candidate intervals last0.5 seconds or longer, six intervals distributed across the window are selected and sampled at their centers. Otherwise six evenly spaced targets are used. Short cut fragments remain visible in the candidate metadata but are not selected as independent center-sampling candidates.

Actual video frames are selected once as their decoded timestamps cross each target. Returned sample times come from FFmpeg showinfo instead of nominal fps positions. The grid retains six160px cells and the existing14,000-byte JPEG limit; no platform adapter, permission, media generation or renderer contract changed. The [FFmpeg select documentation](https://ffmpeg.org/ffmpeg-filters.html#select_002c-aselect) specifies `prev_selected_t`; the [tile documentation](https://ffmpeg.org/ffmpeg-filters.html#tile) specifies unused grid cells.

Follow-up `765a2cf9f51295f2af707f49e9489835b1f252a4` reports the actual count when a very short/sparse video yields fewer than six selected frames, with an explicit blank-cell note. This avoids claiming duplicated frames or rejecting an otherwise readable sparse video solely for not having six samples. Sparse-video behavior was source-reviewed and typechecked, not verified with an actual sparse resource in this scenario.

Both exact pushed revisions were packaged on independent Linux Node22.23.2 for resource-only deployment. Readiness and protected-service checks passed for both releases. The final revision is765a2cf, recorded in the final resource deployment receipt. Agent remains `ca59e62bd0209985cb1be8cc669bfb8e9eacd81c`; UI remains `195b5dd28377e21e9ba3bfdbfa629f6c31ab1be2`. Focused macOS Node22.23.2 TypeScript and diff checks passed; Windows validation was not performed.

## Actual small-sample model scenario

Revision under real-model validation: `83891097a8e0a8c89d663a2f20bb9ac031ccf678`. Existing account, actual authenticated AI Gateway, Agent tools, real resource storage and existing reference/shop media. Provider model identifier and usage settlement are not exposed by the captured diagnostics; no cost or model name is inferred.

Session `ses_d82d9e26-ed86-4478-89cf-e4ecc6d8a2f9`; run `run_7f6dcf40-ee5b-4287-a2d0-6f6c0add6d23`. Input: read the complete existing reference `res_4b08c01cb6cd5b0101324266`, its8–12 second window, and the existing shop footage `res_72a6a8d5c97921f2c3c249a6`; explain visible content and limitations, with no plan, render or generation action. This deliberately specifies the three reads; it is not autonomous production acceptance.

Terminal `completed`: two main model calls, three successful inspect tools, no failed tools or media mutation, driver interval85.277 seconds. All three actual receipts have analysisVersion3:

| Actual material/window | Returned decoded frame times, seconds |
| --- | --- |
| Reference,37.434s | 1.23333,8.63333,15.6667,21.4,28.2,36.6667 |
| Reference,8–12s | 8,8.666667,9.33333,10,10.66667,11.33333 |
| Shop footage,4.913s | 0,0.833333,1.66667,2.46667,3.3,4.1 |

The model distinguished reference exterior/person, overhead food arrangement and close-up pot actions from the shop clip's continuous round-table dining scene. It reported candidate-cut and sample limitations. The six-cell reference contact was visually inspected. Exact food identification and every claimed semantic interval have not been independently verified; some output language still approximates candidate intervals as shots. This is improved visual evidence, not proof of perfect scene understanding or completed film quality.

Ignored receipts: `.cache/campfire-inspection-samples-live/report.json`, extracted `frame-0.jpg` through`frame-2.jpg`; final deployment report `inspection-samples-resource-deployment-report.json`. No mock/stub/canned-response/replay/legacy regression tests were run. No new film or audio was produced.

Remaining acceptance: autonomous new-plan/new-film production with improved food coverage and actual comparison against the original output, plus the other incomplete ADR-0035 requirements. The original output remains comparison-only, never generation input.
