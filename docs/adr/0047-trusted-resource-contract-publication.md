# ADR-0047: Publish the trusted resource contract with its consumers

Date: 2026-10-11. Status: Accepted. Extends ADR-0046.

The main platform owns authorization and validates model tool arguments against its trusted resource descriptor artifact. Harness owns the canonical resource definitions. Updating only Harness leaves the provider with an older schema and rejects new arguments after a paid response. This is protocol skew, not proof of model inability or execution failure.

Export the canonical descriptors from the exact pushed Harness revision, review the compatibility diff, and commit the generated artifact in the main platform. Release the compatible platform consumer before admitting real runs that need added fields. Verify the active platform artifact against the canonical producer as parsed JSON; compare every descriptor, not just the revision label. Retain both exact artifact hashes and the producer revision in the release evidence. Never accept tool schemas from a browser or model to bypass the trusted contract.

For this extension the only differences are optional process verification names, an optional explicit environment retry reference, and catalog runtime identifiers instead of a fixed client enum. Existing authorization, billing, budget records and account checks remain unchanged. Publish a candidate derived from the actually running platform image that replaces only the committed descriptor file; preserve other production overlays, existing services and the rollback image. No migration or model change is required.

Validation admission includes a read-only active-contract audit against the exported canonical artifact. An unmatched or inaccessible descriptor stops admission before a model call. Keep failed runs, uncertain request reservations and previously completed writes; repair and continue only the affected task.
