# Native Campfire autonomous editing: focused real validation

Date: 2026-10-09. Environment: actual production cloud workbench, existing authorized account and Northeast Hui resources. No fake model, fabricated business response, replay suite or AI media generation was used.

## Changes and deployed components

- Resource service `d09e3be659ff114e71541bcd915990bc2bb79244`: immutable saved plans now expose the validated segment sum as `durationSeconds`; the save receipt states shot count and total duration. Commit `198f5ba21ec57d5ff24d21093d053e864c225229` also makes an invalid inspection window report the actual probed media length and remaining available window. It does not silently clamp the request.
- Main platform adapter `365e4f58f6670f4c8c2eab8e49fe2b1e0c1a4106`: cloud Seed interactive requests default to the local Harness path's disabled thinking mode, while honoring explicit enabled/disabled configuration. The exact Seed model/provider remains unchanged. Preceding commit `21047113073795b5be0c7de1c99b3e4b52ef0e70` records content-free streamed tool timing and argument character counts.
- Agent runtime `ca59e62bd0209985cb1be8cc669bfb8e9eacd81c`; UI `748df4600b7504c4800efb0eba592250383fb0cd`. Existing authenticated inline media streaming is unchanged by these resource releases.

Python syntax review, focused server-cloud TypeScript checking under macOS Node 22, packaging on the independent Linux production host, and diff checks passed. These are static/packaging observations, not Windows acceptance or proof of model behavior. Legacy test suites were not run.

## Failures retained in the evidence

The first fresh autonomous request (`run_377facbd-23ed-474c-b053-4194655b80a1`) inspected real materials but produced no plan: the provider timed out at 140002ms without visible text. A subsequent diagnostic resume was cancelled prematurely because its validation driver counted historical requests; the driver's history pagination was corrected. Neither case is a passing editing test.

After the interactive thinking adjustment, fresh request `run_d7775ffa-4312-443a-a72c-beb77d98c50d` autonomously produced an 18-shot plan and real film, but guessed inspection windows repeatedly and claimed 29 seconds for a plan whose segments summed to 31.5 seconds. Its film was 31.51 seconds. The driver cancelled the ninth main request under its predefined eight-call budget; this was not successful completion of the original 28–30 second task.

These failures motivated actual media-bound receipts and server-calculated plan duration rather than accepting the model's arithmetic.

## Actual repair scenario

Session `ses_59bf8abc-fe8f-43f7-b5cd-3486960b64c4`, run `run_39f1b653-4615-4f82-ad48-4a3e92c7b0a7`, model `doubao-seed-2-1-pro-260628` via authenticated AI Gateway. Input requested autonomous correction of the just-created 31.5-second plan to 28–30 seconds, reuse of its real shop/ref/audio sources, and confirmation of the new server duration receipt before rendering. No per-shot replacement timeline was supplied. The input also deliberately requested an oversized inspection of an actual short clip to exercise recovery.

Observed actions:

1. Read the existing automatic plan's persisted state. Inspect real short clip `res_72a6a8d5c97921f2c3c249a6` with a 15-second window; receive actual total/maximum 4.913 seconds.
2. Inspect the next window at 0–4.913 seconds successfully, without repeated guessing. Inspect existing narration/music without video windows.
3. Save new plan `res_255fb9b4a056a6209baa7529`: 18 shots, server-calculated 29 seconds. Read the receipt and then submit rendering.
4. Save new film `res_6492f50bf75a343cde96d404` and return normal completed assistant text. Five main model requests, measured run latency 208391ms.

Actual storage/media verification independently checked each segment's owned shop-video resource and valid probed source range, no generated segments or missing shots, unchanged reference `res_4b08c01cb6cd5b0101324266`, narration `res_a97fdf7bbcfcff9e00dc8c92`, music `res_4ee16bbf70fdd97f29ca5fd1`, and the preserved earlier successful output facts. Audio settings are source volume 0.55 and music volume 0.2; their presence alone does not prove perceptual narration clarity.

Authenticated download returned 17768107 bytes of MP4; SHA-256 `e95bfb8d8deba5766d4388dbd7b2f775f697964bb48a14af57a37459ea564307` matches the actual output manifest. Independent probing: 29.013333 seconds, H.264 1080×1920 at 30fps, AAC stereo 48kHz. Complete decode passed. A six-frame contact sheet was visually reviewed.

In the actual production browser the chat's inline native player loaded this film, played from zero to 4.52277 seconds, and returned to the start successfully. Desktop document/client width was 1200/1200; at 390px it was 390/390, with no page horizontal overflow. The existing download control remained visible. Local ignored evidence is under `.cache/campfire-auto-reference-repair-live/` (`report.json`, `verification.json`, `usage.json`, `output.mp4`, `contact.jpg`, `workbench.png`).

Actual platform usage records contain five successful priced main calls, calculated total CNY 0.505230, plus three auxiliary records without complete pricing/usage. This is the available main-call accounting, not a complete provider/media infrastructure cost. Earlier failed/cancelled attempts also incurred recorded usage; they are not included in that passing-scenario figure.

## Remaining boundary

The repair passes duration, real-source selection constraints, persistence, actual rendering/download, inline playback and focused overflow checks. It does not establish reliable first-attempt autonomous planning, semantic accuracy of every selected shot, perceptual audio quality, or equivalent quality to the original Yinghuo film. ADR-0035 remains in progress; no broad parity claim is made.
