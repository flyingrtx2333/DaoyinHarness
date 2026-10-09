# Native Campfire: missing-shot question and caption production

Date: 2026-10-09. These are two bounded actual account/model scenarios, not a full production-parity acceptance report.

## Environment and revisions

- Authenticated production cloud, existing daoyintech account/password session; ordinary account resource APIs, actual Agent tools and canonical persisted events.
- Agent runtime `1d946108efa9d64ef99f9416c4ebbe2e72cf675e`; workbench UI `84e0ec4570b90a8a2d464bed69265f91b3708556`.
- Missing-shot scenario resources: `1d946108efa9d64ef99f9416c4ebbe2e72cf675e`. Caption production resources: `7a9ec534be85b8db07256c7e171b8b0e6d420098`.
- Main-model usage records identify Ark `doubao-seed-2-1-pro-260628` for both scenarios. No original Yinghuo generation service was used.
- Narrow cloud TypeScript check passed on macOS Node 22.23.2. Resource packaging/readiness passed on independent Linux Node 22.23.2. These are not Windows observations or model-behavior proof.

## Actual missing-shot question

Run `run_0807dca4-c564-4967-85b3-04f673bf60bd`, session `ses_c5aaadb6-2722-4f50-aaa4-3101f67fefc5`, client latency 56,416 ms, four main-model calls.

Input requested an independent 9:16 product-media plan using the existing Harness logo plus actual footage of an engineer demonstrating the product in an office. It explicitly requested a question if that actual footage was unavailable, and withheld AI supplementation, narration, music and rendering.

The Agent actually called `resource_campfire_list`, three `resource_campfire_inspect` operations and `resource_campfire_plan`. It inspected the existing product profile and media rather than inventing IDs or treating the logo as office footage. Persisted plan `res_d258aebeff7068d566e863fd` contains only the real logo `res_743ad7ac561409dacec1bb4b`, a three-second segment, and `missingShots: ["工程师在真实办公现场演示产品的实拍镜头"]`; returned `canRender` was false. It asked whether to use explicitly labeled AI dramatization or upload actual footage.

Persisted run events contain no render, narration, music or video-generation tool invocation. A subsequent actual resource status query also found no render events on this plan. This proves the observed stop-and-question behavior; it does not prove approved AI supplementation, which remains unavailable.

Actual platform logs 14838–14844: main-model input 45,624 tokens, output 1,885, calculated CNY 0.330294. Three auxiliary entries are unpriced (`UNCONFIGURED` / `MISSING_USAGE`), so this is not the complete cost or account settlement.

## Caption change and actual new film

Visual inspection of the previously produced Northeast restaurant film found a comma stranded at the beginning of a second subtitle line. The independent caption formatter now moves the break without exceeding its existing line-length bound and avoids ending lines with opening Chinese punctuation. Font, margins and the sentence-level audio timeline were preserved. This is typography, not new word-level speech alignment or Chinese word segmentation.

Run `run_4d97881b-d10d-4e49-9b05-f251a8e1efe3`, session `ses_ad28ff2b-c317-43ae-bfc9-de797e5bd3d2`, client latency 182,719 ms, four main-model calls. Actual tools: original-plan status, shop inspection, new plan, render. All four completed; render took 116,679 ms.

- Original immutable plan: `res_85eb306154650e8b47981388`.
- New plan: `res_444b2482acc2f0f0762db3c8`, title 东北荟探店·字幕排版版.
- New output: `res_42cfae407de405d66cde26cf`.
- Reused narration: `res_a97fdf7bbcfcff9e00dc8c92`; music: `res_4ee16bbf70fdd97f29ca5fd1`.
- Actual resource queries compared canonical `segments`, `audio`, `aspectRatio`, `referenceId` and `missingShots` with the original plan: identical. The previous output `res_ead0d75d4892047a01be9638` remained available.
- No new speech/music/AI generation tool was invoked. Only the new independent plan was rendered.
- Downloaded through the authenticated native media-read API: 16,132,514 bytes; SHA-256 `514c5008356aac4273298c7ffb5ff9ab70d8243be41e90d35e471441b704fa79`.
- Actual local file probe: 28.533333 seconds, 1080×1920 H.264 at 30 fps, AAC 48 kHz. Full-file decode completed with exit 0 and no errors. Frame at 18 seconds was visually inspected: the second line begins with 杯 rather than a stranded comma, with readable, bounded two-line text. Word breaking remains distinct from punctuation typography.

Actual platform logs 14845–14851: main-model input 49,195 tokens, output 2,659, calculated CNY 0.374940. Three auxiliary entries remain unpriced; no complete-cost or billing-settlement claim is made.

The first resource deployment detected a protected-service fingerprint change and rolled back to the prior resource revision. Its observed changed unit was the cloud Agent; the exact cause was not established. A fresh guarded retry deployed the exact pushed resource revision with readiness and protected-service checks passing. It did not switch the Agent runtime or UI.

## Evidence and remaining acceptance

Ignored local evidence: `.cache/campfire-missing-live/report.json`, `usage.json`; `.cache/campfire-caption-live/report.json`, `verification.json`, `usage.json`, `output.mp4`, `caption-fixed.png`. The server resource deployment report is `.cache/campfire-speech-release/caption-resource-deployment-report.json`.

No mocked responses, simulated browser/API fixtures, replay tests, Vitest or broad deterministic suites were used. Decode/probe and source/type checks are artifact/static verification, separate from the actual model runs above.

These scenarios add missing-shot question evidence and a verified caption improvement. Full parity is still unproven: approval-to-AI-generation and explicit generated-shot provenance, speech pricing/settlement, independent audio/caption alignment, and broader visual/audio comparison remain open under ADR-0035.
