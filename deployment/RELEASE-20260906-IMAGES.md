# Event image display release — 2026-09-06

## Delivered

Requests to see event images use `saishi_list_images`, not material-status pagination. Numeric event selection preserves the image request. Tool results immediately produce scoped image cards with loading, retry and modal viewing; the assistant gives a short explanation. Repeated pages and more than two autonomous media pages per turn return an actionable non-retryable result.

Original uploads and highlight photos are preferred. When neither exists, existing video thumbnails are explicitly labeled video previews. No frame generation, face-crop substitution, new consent, data migration or transcript rewriting occurs.

## Versions

| Component | Deployed revision |
| --- | --- |
| Harness runtime and workbench | `7b7437766b8609507597af0c833dba6f30bc632b` |
| Saishi backend | `9c45a099187d99293a3ebe4761cf05fb599c40ad` |
| Main backend | `1e1de7759b6bd683d0e801e2017de90936f1f5ec` (contains image bridge commit `161291146b569227daf3935ab709a16fcccb319a`) |

Saishi [CI 34037078667](https://github.com/flyingrtx2333/daoyintech/actions/runs/34037078667) and main backend [CI 34037770037](https://github.com/flyingrtx2333/daoyintech/actions/runs/34037770037) succeeded. Another coordinated checkout task contributed the later platform revision; its unrelated source changes were not staged by this image repair.

## Evidence

- Windows / Node 22.23.2: typecheck, lint, build and 353 tests passed; 7 gated tests skipped. The shared checkout also contained separate runtime-stability WIP. Release builders read committed Git objects and exclude that WIP.
- Windows-driven Saishi Compose suite: 392 passed. Main platform account/MySQL and media contract suite: 13 passed; additional Harness adapter suite passed earlier.
- Committed workbench browser check: `node scripts/verify-saishi-images.mjs --committed`, desktop 1280px and mobile 390px. Fixture account/API/media verified immediate cards, replay deduplication, failed-image retry, same-origin paths, modal Escape/focus and no horizontal overflow.
- Neighboring company/Saishi WebSocket browser check passed: live text, no polling after ready, reconnect, replay, deduplication, revocation and no resubmission.
- Production static hashes matched all four committed artifacts; anonymous login and account/image denial were checked. Production assets with fixture account data passed username/avatar/menu/settings checks. These checks do not represent a real user browser login.
- Deployed Saishi HTTP facade returned 9 tools for the new bridge and retained 8 for an older service client. Real scoped event 2 returned one video preview, JPEG, 87,712 bytes; content SHA-256 `e7d1ecc0bf63d806662987901dc140021523a9bdc56742be10bad49cae8a979b`. There were no original-image or highlight-photo records for this event at verification time.
- Real account execution grant and real model regression, without fabricating a browser login: session `ses_5843450e-7c6c-4485-9e5d-245b45999790`, titled “图片修复验收”. Event selection completed in 42.6s with one `saishi_list_events` call. Reply “1” completed in 23.8s with exactly one `saishi_list_images` call, one image reference and 28 streamed text deltas; no `saishi_list_materials` call. Result correctly described a video preview, not an original photo.

## Operations

Runtime and workbench symlinks point to the verified Harness release. Backend image pins were updated to the observed deployed revisions. All three direct service health endpoints passed. PostgreSQL remains the cloud database; no migration or historical event rewrite was required.

Host-local backup: `/var/backups/daoyin-agent/images-20260906`, including a PostgreSQL dump, previous runtime/static targets and protected backend environment backups. Rollback must retain PostgreSQL. Do not restore the old frozen SQLite database or overwrite events created after this release.

Entry: [Saishi workbench](https://www.daoyintech.com/harness/?app=saishi).
