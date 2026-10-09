# Existing-material push-in motion: actual cloud evidence

Date: 2026-10-09. Goal remains in progress; this is one production effect and one read-only legacy-library diagnosis.

## Code and deployment

Harness commit/resource release `ab88f33023969735b5a761f94158a4833ddddcdd` fixes video footage silently ignoring `motion=push-in`. Images previously used a current-input `zoom` increment with `d=1`; the implementation now uses output-frame progress for both media types. Input frames are normalized to 30fps before zoompan; each selected shot progresses from 1 to 1.08 over its own frame count. `none` retains existing framing. No AI media or new audio is generated.

The independently authored contract uses [FFmpeg zoompan output-frame semantics](https://ffmpeg.org/ffmpeg-filters.html#zoompan). Focused server-cloud TypeScript and diff checks passed on macOS Node 22.23.2. Exact pushed Git objects were built on the independent Linux server; resource readiness passed with the existing gVisor media executor. Agent runtime, UI, original Yinghuo and unrelated services were preserved. Windows acceptance was not performed. Static/build checks do not establish Agent behavior.

## Actual model/tool/storage scenario

- Authenticated production account: existing daoyintech login at https://harness.daoyintech.com/.
- Model: `doubao-seed-2-1-pro-260628` through the authenticated AI Gateway.
- Session: `ses_08d28a1c-d789-495b-83ad-1b2be2f61cee`; run: `run_33f1b289-a4ff-4baf-a448-29942eafe0cd`.
- Input: inspect real Northeast restaurant profile, image `res_7cf8ee87060568dae3abce70` and video `res_1cab8ddf9b2ac712f56fcc2a`; save four three-second shots: image none, same image push-in, video none, same video push-in. Start zero, 16:9 crop, no subtitles, narration or music, source volume 0.3. Make new plan/output without overwriting old assets.
- Actual successful tools: three inspect calls, one plan, one render, one status; no tool failure or media-generation action. Stored plan `res_725201c7ec7f687c8a4a861e` has exactly those four segments and a 12-second timeline. Output `res_737fd50f85d2104ecc89e3ab` was saved before cancellation.
- Important failure: the input/driver bounded main calls to four. The Agent requested a fifth call after the status tool; the driver cancelled it. The original run is terminal `cancelled`, not a completed Agent scenario. Tool rendering success is not a passing conversational-call-budget result. No retry/re-render was performed.
- End-to-end driver interval: 93.296 seconds. Actual platform records 14961–14964 contain four successful main calls: 60,864 input and 805 output tokens, calculated CNY 0.389334. Record14965 is the cancelled fifth call, `FAILED_FREE` / `APP_MODEL_FAILED`. Three auxiliary usage records have unconfigured/missing pricing; the main calculated amount is not total settlement.

## Actual media verification

Authenticated protected media read returned the stored output and exact byte count; SHA-256 and persisted facts are in the ignored verification receipt. Full FFmpeg video/audio decoding passed. Video is 1920x1080, 30fps, 360 frames, exactly12 seconds; container/audio duration is12.010667 seconds from AAC framing.

Compared same-time final frames of each paired real shot against unchanged and independently cropped1.08x references. RGB PSNR improved from13.359 to20.272dB for the image and13.591 to25.580dB for the video after central zoom alignment. This demonstrates the expected spatial change in both actual media types; it is not an original-Yinghuo film-quality equivalence metric. Actual final video frame was visually inspected.

No fixtures, mocked models, replay suite, legacy Vitest or synthetic business media were used. Local ignored evidence: `.cache/campfire-motion-live/report.json`, `verification.json`, `output.mp4`, extracted real frames and `decode-and-motion.json`; server release receipt `motion-resource-deployment-report.json`.

## Legacy library issue still pending

A fresh authenticated `/assets?category=all&offset=0` request returned409 `STORY_OPERATION_FAILED`: the generation metadata query references missing `daoyintech.story_profiles`. The current Story schema/app use `story_user_profiles` with the same tenant/user/nickname columns. A one-line patch is prepared in `.cache/campfire-release/story-profile-table-fix.patch`. No Story code, schema, data or service was changed; coordinated Story API modification/publication awaits the separately requested authorization.

Full production parity, the legacy library fix and conversational call-budget closure remain unproven. This report must not be treated as the goal completion audit.
