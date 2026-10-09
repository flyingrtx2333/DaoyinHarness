# Actual automatic reference production and window recovery

Date: 2026-10-09. Full ADR-0035 acceptance is not achieved.

## Fresh automatic production

Resource revision `765a2cf9f51295f2af707f49e9489835b1f252a4`, Agent `ca59e62bd0209985cb1be8cc669bfb8e9eacd81c`, existing authenticated daoyintech account and actual AI Gateway. Input: produce a new28–30 second portrait Northeast restaurant film from the existing shop profile, reference and real shop footage, independently choose shots, reuse the specified existing narration/music, avoid treating dining-wide shots as food close-ups, and preserve old results. No old plan or output was provided as production input. No AI shot, voice or music generation was authorized or used.

Run `run_f37fdec8-ce6b-4e74-ab93-ae06b74adc2d`, session `ses_3874af0e-e919-43f6-87c9-8535568e4ef5`, terminal `completed`,296.531-second driver interval. Ten main calls; actual profile/reference/list/audio/footage/window inspections, new plan and one render. Two inspect windows failed before recovery:0+5 exceeded4.947 seconds;8+8.7 exceeded16.648 seconds. The Agent adjusted its requests from actual failure messages and continued. Limits were message/driver limits, not a structured `maxModelCalls` request.

Stored plan `res_959745ec6bc5e3f118b04992`: fourteen shots, five actual shop-video resources, total27.7 seconds, portrait crop with supplied focus positions and several push-ins. Existing narration `res_a97fdf7bbcfcff9e00dc8c92` and music `res_4ee16bbf70fdd97f29ca5fd1` were reused. No missing shots were recorded. Output `res_4f63f182ebeda21924b3c1a6` persisted; old output still existed. All chosen assets belong to the shop and are existing video footage; starts/durations fit inspected real lengths. This proves completion of the actual new-plan/new-film path, not compliance with every requested output property.

Protected download200,18,222,634 bytes, SHA-256 `0c4ef02f3577c59527b69f85df74f6e53c2afe777b664182f4e3281d13496090`. Actual video/audio27.7 seconds,1080×1920,30fps,831 video frames. Complete FFmpeg decoding passed. Final output is0.3 seconds below the requested28–30 second range, explicitly retained as a failure against that criterion.

Platform usage rows14986–14995 identify `doubao-seed-2-1-pro-260628`, ten successful main calls,203,452 input/4,426 output tokens, calculated CNY1.353492. Auxiliary retrieval/routing records have missing or unconfigured pricing; this is not total settlement. Ignored evidence: `.cache/campfire-shot-center-auto-live/report.json`, `verification.json`, `usage.json`, `output.mp4`, `contact.png`.

Six actual frames at0/5/10/15/20/25 seconds show storefront, serving fried food, a real food close-up, dining, a food table and interior. Food coverage is stronger than the prior repeated-wide-shot result, but the opening crop cuts part of the sign and the outro is an interior view rather than a clear full storefront. Some sampled captions/scene claims still require closer verification. Audio listening equivalence has not been established.

## Only-read window correction

Resource revision `94df004281b8e005a07e640fe5851358c6645e54` appends analysisVersion4 and clamps a requested read window to the real media end while preserving requestedStart/requestedDuration and reporting actual windowDurationSeconds, windowTruncated and a concise adjustment fact. Out-of-media starts still fail. Plan/render range checks remain strict and unchanged. The exact resource-only release passed readiness and protected-service checks; no Agent/UI/original-Yinghuo service changed. Focused macOS Node22.23.2 TypeScript/diff checks passed; packaging used independent Linux Node22.23.2. Windows validation was not performed.

Run `run_5bbcda86-ee06-4610-a92f-eb98f4c782cb`, session `ses_e16b5e67-b22e-4467-939a-0975f1256559`: terminal `completed`, two main calls, two successful inspect tools,32.566-second driver interval. The actual model received the same previously failing windows and correctly reported truncation:

| Request | Actual read window | Actual selected times, seconds |
| --- | --- | --- |
| `res_8ecfeb253d01b7dea1341eef`,0+5 | 0+4.947 | 0,0.833333,1.66667,2.5,3.3,4.13333 |
| `res_2b4c1fcded6d7b79c59e2d21`,8+8.7 | 8+8.648 | 8,9.46667,10.9,12.3333,13.76667,15.2333 |

All receipts are version4 with windowTruncated=true. No plan, render, media generation or quote action occurred. Platform records confirm `doubao-seed-2-1-pro-260628`,22,083 input/715 output tokens, calculated main-call CNY0.153948; auxiliary settlement remains incomplete.

The ignored driver report additionally records an unsuccessful diagnostic file-read after the model run had already completed:400 RESOURCE_INPUT_INVALID from missing session context. A separate read with session context returned403 RESOURCE_NOT_ATTACHED because the internal media workspace is not a user-attached workspace. Neither error was an inspect/model failure, and no permissions or attachments were changed. They remain in the actual receipts rather than being erased.

## Outro subtitle defect and correction

Read-only server inspection of the exact owned output snapshot `snp_c454822f00460ecad1c17fa0` verified its captions.ass digest. The actual file contained only the five measured narration cues ending24.68 seconds; the plan's different outro title was absent. The renderer had chosen narration captions instead of the entire segment-caption timeline.

Commit/resource release `59e465f1715b2321cc314a93f4bd72f0709aee7d` preserves measured narration captions and adds distinct segment captions only in the segment's uncovered time intervals. Duplicates of spoken text are skipped; titles do not overlap measured speech subtitles. An empty narration-caption array now retains ordinary segment captions. Readiness/protected-service checks and focused TypeScript/diff checks passed. Actual new-film validation of this correction is recorded separately after completion.

No mock/stub/canned-response/replay/legacy regression suite was used. New reference sampling, recovered windows and a completed automatic film are meaningful progress, but do not establish stable first-draft quality or full original-film parity.
