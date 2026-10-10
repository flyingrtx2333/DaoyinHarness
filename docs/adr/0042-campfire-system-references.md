# ADR 0042: Built-in reference videos

The owner requested ready-to-use system reference videos, without a user upload. Harness publishes the three already-published Yinghuo system media as a fixed, versioned catalog. Metadata and SHA-256 identities were independently verified from the actual MP4s. No Yinghuo source, prompts or analysis results are imported; serving does not depend on a live Yinghuo API.

Deployment installs the verified media into the existing content-addressed store. The first reference-library read idempotently provisions immutable account-owned resource handles for these defaults, without model calls or copying bytes per account. This bounded default provisioning is the only side effect of the library read. Existing ownership, inspection, thumbnail and preview paths remain unchanged. No global private-resource access bypass is introduced.

The reference listing returns system presets separately from the paginated account list, so presets remain visible even after many user uploads. The UI merges resource IDs and groups system presets above uploaded references. Media remains reference-only; it must not replace shop footage or supply facts about the shop. Version changes require a new catalog identity and never rewrite existing resource events.

Install verified media using `node scripts/install-campfire-reference-presets.mjs --source /absolute/published-media-directory --content-root /absolute/existing-blob-store` from the clean server checkout. The operator installs only the three committed hashes; existing blobs are checked and preserved. Missing media produces an explicit library error rather than a fake empty preset list.

System catalog MP4s and 480px quality-35 WebP posters are published at content-addressed COS URLs with one-year immutable public caching. Only explicitly published system references receive public URLs; account-owned resource handles and private media keep existing authorization. Delivery URLs are derived from the catalog and are not added to prior immutable media facts. The browser uses direct COS delivery with a bounded fallback to the authenticated media route; no provider or COS credentials enter the browser.
