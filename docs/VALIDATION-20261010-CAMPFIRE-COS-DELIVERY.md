# System reference COS delivery — 2026-10-10

## Scope and deployed revision

Implementation and public UI/resource service: `f856eca90fb2236f92df480c21ec030826b03840`.
Environment: independent Linux production server, Node 22. This is not Windows acceptance.
The resource service alone was restarted. Agent, executor, platform, other services and containers remained unchanged; UI switch only changed static artifacts.

Three existing public system reference MP4s and 480px-edge quality-35 WebP posters were published to the fixed COS catalog. Every object uses content-addressed paths, inline delivery and `Cache-Control: public, max-age=31536000, immutable`. Poster sizes are 12,092 / 15,438 / 16,950 bytes. No bucket-wide policy change was made.

Existing account-owned preset handles and immutable media events remain unchanged. Delivery URLs are derived from the fixed role/key/digest catalog. Uploaded/private shop media retains its authenticated resource path. The frontend validates the fixed HTTPS COS host/path and falls back to authenticated delivery on errors.

## Actual validation

- Node 22 cloud/UI TypeScript checks passed on the independent Linux server; resource and UI artifacts built from the pushed exact revision.
- Public UI revision and every released file SHA-256 matched. Previous hashed assets were retained; Agent readiness stayed ready.
- Authenticated production account 1 returned all three system presets even with list limit 1. Repeated calls reused the prior IDs: `res_57b896b614df16fea91de80f`, `res_54560b87d308d3df3e2ed303`, `res_258a1964b150b4265a0ebc08`. Their new playback/poster URLs matched the public catalog.
- Actual original media bytes and thumbnail reads remained readable through the fallback path. An actual shop-video list returned no public playback/poster URLs.
- Anonymous COS poster GET returned 200, image/webp, exact sizes and immutable cache headers for all three presets.
- Actual first-1MB and middle-64KB requests returned 206 with correct Content-Range and byte counts for all three MP4s. Remote decoding at 0s and 10s passed for each video. MP4 moov metadata is already at the beginning.
- Existing production CSP permits HTTPS image/media URLs; no CSP change was needed.

Observed server-side request times (single sample per object; not browser/client performance):

| Preset | Poster | First 1MB | Middle 64KB | Decode 0s / 10s |
| --- | --- | --- | --- | --- |
| luosifen-opening | 133ms | 156ms | 136ms | 644ms / 729ms |
| new-store-opening | 91ms | 133ms | 148ms | 384ms / 913ms |
| buffet-value | 141ms | 215ms | 100ms | 392ms / 506ms |

Before this change, sampled proxy requests took 340–563ms for posters and 855–1164ms for the first MB. These are observational server measurements, not a controlled user-browser benchmark or a latency guarantee.

## Evidence and limits

Operator receipts on the server: `/root/harness-preset-cos-publication.json`, `/root/harness-preset-cos-verification.json`, `/root/preset-cos-resource-deployment-report.json`, `/root/preset-cos-ui-deployment-report.json`; authenticated account receipt in the platform container: `/tmp/harness-preset-cos-account-validation.json`. Receipts contain no provider credentials.

Browser automation was unavailable (CDP focus timeout / native window lookup failure). Actual browser playback, drag interaction, visual layout and cache-hit behavior were not verified. HTTP range and remote codec seek checks are the available media-delivery evidence. No mock tests or model calls were run for this delivery-only change; no model behavior claim is made.
