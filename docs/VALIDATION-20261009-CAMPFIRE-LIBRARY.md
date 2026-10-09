# Native Campfire library: actual account and model verification

Date: 2026-10-09. This report covers profile maintenance and scoped pagination, not a new film generation or completion of production parity.

## Revisions and environment

- Cloud Agent and resources service: `1d946108efa9d64ef99f9416c4ebbe2e72cf675e`.
- Public workbench UI after the mobile upload-input sizing fix: `fdf50e07ae439c1c24f714151c8107b2648cf165`.
- Main-platform resource contract overlay: `f54a3bcbc266998d3e103d239468469389f1de09`.
- Actual production cloud at `https://harness.daoyintech.com`, existing daoyintech account/password session, independent Linux Node 22.23.2 services. Source type checks ran on macOS Node 22.23.2. Neither observation is Windows acceptance.
- Exact pushed Git objects were built on the server. Component revision/hash and health checks passed. The final UI-only release preserved the running Agent process.

## Actual account/storage checks

1. Paginated the account's 24 existing ready assets at two per page: 12 pages, same order and IDs as the actual complete list, without duplicates. No fabricated media or bulk fixture rows were inserted. The library initially displayed 20 and its load-more control displayed all 24. Shop choices are queried independently from recent media.
2. Paginated the two existing profiles at one per page. Reusing a profile cursor with a different role filter returned HTTP 400 `CAMPFIRE_CURSOR_INVALID`.
3. Edited the existing public product-media technical profile `res_3ef3df36e8f9a8ab1dee2778` in the actual library UI, producing version 2. The original profile event remained present. A stale version-1 edit returned HTTP 409 `CAMPFIRE_PROFILE_CONFLICT`; an immediate identical successful-update retry returned `reused: true`, with identical before/after canonical facts.
4. Inspected the real uploaded Harness logo and saved plan `res_e9d49d1c07af891e4ac56a36`. Its immutable `shopProfile` captured version 2. Updated that technical profile to version 3 through the actual account resource endpoint. The saved plan still contained the original version-2 title/content. No render was submitted. Northeast restaurant facts and existing films were not modified by these maintenance checks.

The 24-asset sample proves this observed traversal; it is not a large-library load test or broad cross-account guarantee. Source review confirms the database query applies owner, shop and role filters before keyset pagination, with no old overall 1,000-row materialization cap.

## Two bounded real-model scenarios

Both used the authenticated AI Gateway, actual Agent tools and persisted cloud events. Main model: Ark `doubao-seed-2-1-pro-260628`.

| Run | Input and actual actions | Persisted outcome | Client latency |
| --- | --- | --- | --- |
| `run_305feb50-f33a-472c-90cf-99b728e6c210` | Read the actual profile name, version and material-maintenance rule; one `resource_campfire_inspect`, two main-model calls | Completed; correctly reported title 道引 Harness 媒体验证 and version 2 at that time | 17,603 ms |
| `run_3ec3ee51-65f2-48ed-9d7b-279bad7e051b` | Compare current profile and previously saved plan without generating; one `resource_campfire_inspect` and one `resource_campfire_status`, two main-model calls | Completed; correctly reported current version 3 versus saved plan version 2 | 19,466 ms |

Actual platform usage records 14828–14837 contain four successful main-model calls: 38,311 input and 824 output tokens, calculated CNY 0.254586. Six auxiliary routing/embedding/reranking entries have `UNCONFIGURED` or `MISSING_USAGE` pricing, so that sum is not full cost or account settlement. Routing diagnostics include bounded auxiliary timeouts with lexical fallback; both main scenarios completed with their actual tools. No mock model, replay suite, Vitest or simulated business response was used.

## Actual browser verification

- Desktop: library editing, inspection, load-more and native chat picker were checked against the authenticated production application.
- Narrow: profile inspection at 390 pixels and editing at 320 pixels remained readable without horizontal overflow.
- The picker originally overflowed because the shared asset-form input rule enlarged its hidden file input. The canonical selector now excludes `.composer-file-input`, preserving the existing one-pixel hidden-input rule.
- Post-release picker at 390 pixels: client/scroll width 354/354; at 320 pixels: 284/284. Hidden input width was one pixel in both cases.
- Selected 东北荟 and `preset_reference_luosifen-opening_v1.mp4` (the imported original Yinghuo reference) through the chat plus menu. Clicking 使用营火能力 produced the actual composer selection chip. No new message or generation was submitted during this UI check. Temporary viewport overrides were reset.

Local ignored evidence: `.cache/campfire-library-live/report.json`, `plan-version-report.json`, `picker-ui-proof.json`, `picker-390-fixed.png`, `picker-320-fixed.png`, `picker-desktop-fixed.png`, `profile-desktop.png`, `profile-narrow.png`, and `edit-320.png`. The older `picker-narrow.png` is pre-fix evidence and is not a passing result.

## Scope still open

This change is implemented, pushed, deployed and verified by the above small real sample. It does not establish visual/audio equality with original Yinghuo films. AI completion after explicit missing-shot approval is still unavailable; full speech usage pricing/settlement and independent narration/caption alignment and film-quality comparison remain separate acceptance work. Earlier Northeast restaurant generation evidence remains in the reference and HD validation reports.
