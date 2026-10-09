# Native Campfire narration-priority mixing

Date: 2026-10-09. Actual production cloud account, real Northeast Hui shop footage and existing audio; no media generation, synthetic input or fake business response.

## Responsible mechanism and implementation

Before this change, music was ducked by narration but camera sound was only multiplied by `sourceVolume`. With an explicitly requested source gain of 0.55, camera speech/noise could compete with narration. Commit `e5191c5ac67c240c07edd2b6a8e2ed9d862169a2` adds an independent narration-controlled camera compressor, alongside the existing music compressor. Narration splits into two branches without music and three with music; every branch is consumed. Without narration, camera/music mixing retains the previous behavior.

A real-audio diagnostic then exposed inconsistent sample counts when narration loudness processing negotiated 192kHz downstream while the baseline camera path remained at 48kHz. The unaligned isolated camera output contained 5013284 samples at 192kHz (26.110854 seconds), versus the 1380506 camera samples at 48kHz (28.760542 seconds). The original diagnostic's nominal late-window gain cannot be compared directly because it did not have equal coverage.

Commit `4a3221dd8a7d0451398679cdbd142cca2e69fb72` resamples the normalized narration back to 48kHz before splitting it into the mix/control branches. With the same actual inputs, both baseline and compressed camera outputs contain 1380506 samples at 48kHz. In the 1–20 second window, camera RMS changes from 0.01454600 to 0.00636915, a reduction of 7.17325dB; in the fully covered 26–28.5 second window after narration ends, the gain difference is approximately zero. This is an isolated measurement on real audio, not a universal attenuation guarantee, end-to-end perceptual score or claim that every previous film lost the same duration.

Diagnostic inputs were the actual short clip `res_72a6a8d5c97921f2c3c249a6` (local camera bytes SHA-256 `4e0ca211cdbb86581c6e5abba33c304d54af3b1afe27deace744af1c47a635c9` matches its owned resource manifest) and existing narration `res_a97fdf7bbcfcff9e00dc8c92`. The diagnostic loops real camera media and measures the changed filter against the same camera signal, without manufactured tones or fabricated model/tool responses.

## Release and static observations

Final resource-service release is `4a3221dd8a7d0451398679cdbd142cca2e69fb72`, built from exact pushed Git objects on the independent Linux production host. Revision-stamped artifact hashes and resource readiness passed; deployment receipts show idle jobs and unchanged protected services. Agent runtime, UI, main platform, original Yinghuo, executor and other services were not restarted by these resource-only deployments. No data migration or historical event rewrite occurred.

Focused server-cloud TypeScript checking used macOS Node 22 after the branch change; diff checks passed. These are static/packaging observations, not Windows acceptance or real-model validation. Legacy suites were not run.

## Real Agent scenarios

Both scenarios ask the Agent to read existing plan `res_255fb9b4a056a6209baa7529`, save a new immutable plan preserving all 18 shot ranges, captions, framing, motion, reference and aspect ratio, and render once. They reuse the existing narration and source gain 0.55. One preserves existing music with gain 0.2; the other omits music. No replacement timeline or tool response was supplied. Model: `doubao-seed-2-1-pro-260628` through the actual authenticated AI Gateway and Agent/tool/storage path.

The first release's two cases completed normally with four main calls each:

| Combination | Run | Output | Run latency | Available priced main-call cost |
| --- | --- | --- | --- | --- |
| Narration + camera + music | `run_19268b87-ca41-4b6c-858a-22fcf16d3686` | `res_bb2f2caeecc85a50d5e625bb` | 193233ms | CNY 0.443754 |
| Narration + camera | `run_85e392e8-1ab6-49eb-9393-cec33a7ae108` | `res_86efecc4e174243e694c9b1d` | 194962ms | CNY 0.475740 |

Actual persisted plan comparison passed, authenticated media downloads matched output manifest hashes, and both MP4s fully decoded. Each film has 870 decoded video frames, identical to the previous film: the mix modification did not change visuals or subtitles. Both native chat players loaded; the music version advanced to 15.261884 seconds and the no-music version reached 29 seconds. Earlier successful output remained available. Each scenario also has three auxiliary records without complete pricing/usage; the figures above are not complete provider/media infrastructure cost or account settlement.

The sample-rate correction is a new behavior change, so these two focused real scenarios were repeated against the final release rather than treating earlier results as final acceptance. Both completed normally with four main calls each:

| Combination | Run | Output | Run latency | Main input/output tokens | Available priced main-call cost |
| --- | --- | --- | --- | --- | --- |
| Narration + camera + music | `run_7be25cda-d407-4f05-8ab6-af5dcabf61fa` | `res_ed0e1c4ea682cfa0ef5332c3` | 189003ms | 67317 / 2056 | CNY 0.465582 |
| Narration + camera | `run_c8b64137-faf4-425b-921c-1889010f43ac` | `res_11c9298fdcfa7f6ce013e994` | 184118ms | 69749 / 1997 | CNY 0.478404 |

Actual final plans `res_f115927100a7459b066db0fa` and `res_e9a66443bb350eff8105b09b` preserve the original canonical visual timeline and appropriate audio choices. Both files are 29 seconds, H.264 1080×1920/30fps and AAC stereo 48kHz. Actual downloads matched manifest sizes and hashes:

- Music version: 17773209 bytes, SHA-256 `81d54e0b28bb3fbd0ad155005bb393d8e3c441c81b88f2a6b2ac0264d0e1465c`.
- No-music version: 17738967 bytes, SHA-256 `4b0dc785ea8d59c148c4239acd3f1b6d579330423f7ab52ce72fd874a760cb74`.

Complete video/audio decode passed. Each final film's 870 decoded video frame hashes are identical to the previous successful film. Actual final music-version playback reached the end at 29 seconds with no media error in the native chat player. Measured final integrated loudness is -14.8 LUFS with music and -14.3 LUFS without music; both true peaks are -3.2dBFS. These measurements do not establish subjective clarity or fidelity to the reference. Each final case has three additional auxiliary records without complete cost/usage, so priced totals remain partial accounting.

## Evidence and boundary

Ignored local evidence for the first two cases and real-audio diagnosis: `.cache/campfire-camera-ducking-live/` (`report.json`, `verification.json`, `usage.json`, `media-check.json`, `sample-alignment.json`, `audio-gain-measurement.json`, the unaligned diagnostic receipt, actual audio/video downloads and browser screenshots). Final correction scenarios use `.cache/campfire-aligned-ducking-live/`. Deployment receipts are under `.cache/campfire-release/`.

This change establishes an actual narration-controlled camera mix and rate alignment. It does not separate human voices from camera audio, prove all scenes subjectively clear, or establish complete original-film/Agent parity. ADR-0035 remains in progress.
