# ADR-0029: Builder archive format for Docker import

- Status: Accepted
- Date: 2026-10-08

## Evidence and decision

An ordinary isolated workspace build completed, but the actual executor's
`docker load --input` failed with `blobs/json: no such file or directory` on
the production Docker classic image store. The builder exported an OCI-layout
tarball. These are different archive layouts, as documented in
[Docker's exporter specification](https://docs.docker.com/build/exporters/oci-docker/).

Export the same single-platform build result with BuildKit's `type=docker`
exporter, matching the existing importer. The runtime remains content-addressed:
the executor verifies the protected archive's SHA-256 before import, inspects
the loaded image's exact SHA-256 ID, and pins that ID to the workspace. Base
images still require exact digests. No named mutable image reference, registry
push, host build socket, image-store migration or Docker daemon restart is added.

Deploy only the builder entry point from an exact pushed, server-built release,
with idle checks, preserved service groups, a bounded readiness check and
rollback. Existing runtime, executor, resource proxy and UI releases stay pinned.
Validate through an actual authenticated workspace creation and sandbox process;
static checks are not evidence that an image imports successfully.

This format correction does not alter BuildKit networking. ADR-0024's
`network=none` requirement and the currently observed network-enabled build
steps need separate reconciliation; this change does not establish compliance
with that network boundary.
