# ADR-0017: Account-scoped event images in conversations

Status: accepted, 2026-09-06.

## Problem

The material-status tool could only enumerate video rows. A request to see photos produced status tables and repeated pagination, while the Markdown renderer intentionally blocked arbitrary remote images.

## Decision

`saishi_list_images` inherits the account's existing `saishi.materials.read` permission. It returns at most 12 stable references (6 by default) from uploaded originals and highlight photos. If there are no photos on the initial page, it returns existing video thumbnails with `image_kind=video_preview` and explicit preview labels. It does not generate frames or substitute face crops. Follow-up pagination uses both `source` and `next_after_id` from the result.

Tool results contain `image_id`, `image_kind`, `event_id`, title and capture time, never storage URLs, paths, cookies or credentials. The UI projects completed tool results immediately into image cards, independent of final model text. Replay deduplicates references; cancellation preserves completed evidence. The UI supports loading, retry, native modal viewing and keyboard dismissal.

Images load through a fixed same-origin BFF route bound to the current account scope and HttpOnly login. The BFF and business service recheck identity after download; each image lookup enforces tenant/event visibility. Storage reads use configured COS object storage or a checked tenant-local file, with 12 MiB and format limits. Responses are non-cacheable and cannot redirect to arbitrary locations. Arbitrary model-provided Markdown image URLs remain disabled.

The profile suppresses identical media queries and caps autonomous media pagination at two distinct pages per tool per turn. The refusal is a non-retryable tool result with actionable text, not an exception whose message would be masked. The assistant retains the user's image goal when a numeric reply selects an event, shows the first available page and gives a short answer.

## Rollout and evidence

Deploy Saishi first: native service clients without `x-saishi-image-gallery: 1` retain the previous catalogue, so an older platform stays usable. MCP gets the new tool directly. Deploy the Harness reader next, then the platform bridge that advertises the feature and serves image bytes. This is a server compatibility header, never a user consent flow.

Windows unit/contract tests cover stable references, query bounds, account isolation and result redaction. `node scripts/verify-saishi-images.mjs` uses built UI with fixture account/API/media at desktop and mobile widths; `--committed` validates committed assets. `node scripts/verify-cloud-websocket.mjs` checks neighboring public/Saishi reconnect behavior. Fixture media is not real-account/model acceptance. Production evidence belongs in the release record.
