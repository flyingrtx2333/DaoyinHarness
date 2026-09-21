# ADR-0024: General resource and workspace execution kernel

- Status: Accepted for implementation; production cutover requires migration verification and real-tool acceptance.
- Date: 2026-09-21
- Supersedes: ADR-0021 where it makes React/Vite, Node.js, one website project or website-specific tools part of the Harness core.

## Decision

Harness is a task-, language-, framework- and product-neutral Agent execution kernel. The kernel recognizes authenticated identities, resources, workspace attachments, capabilities, processes, immutable snapshots, artifacts, deployments, authorization and append-only events. A task name, benchmark name or product name never selects a special executor.

A conversation may attach multiple `ResourceRef` values. File, Git and process calls always name a `workspaceId`; the service verifies account, space, session attachment and current platform authorization again before execution. The shared contracts live in `@daoyin/harness-contracts`. Cloud storage and execution implement them first; local runtimes may implement the same contracts later without creating a second semantic model.

Mutable workspaces and immutable state are separate. `WorkspaceSnapshot` is a content-addressed manifest of safe relative files and relative symbolic links. Blobs live behind a `ContentStore`; PostgreSQL stores metadata and manifests and is not the long-term source file store. Artifacts and deployments reference immutable state. Restoring code does not silently restore databases or uploads.

User code runs only in gVisor. Runtime images are either operator-signed built-in OCI image digests or images produced by the isolated OCI builder. Missing gVisor, an untrusted image, failed launch probes or an unavailable controlled-egress boundary disables execution. There is no host-process or runc fallback. Process calls accept an executable, argument array, workspace-relative cwd and bounded stdin; the model never receives a generic host shell string or Docker socket.

The first OCI builder runs BuildKit without a host Docker socket and with build-step networking disabled. Dependencies that require public access are fetched beforehand by an audited workspace process and copied from the content-addressed workspace context. Any future BuildKit network mode must use the same deny-private, DNS-pinned audited egress contract before it can replace `network=none`.

Public network access is available only through an audited egress boundary. Each workspace receives its own internal container network; only that workspace's sandboxes and the trusted egress proxy join it, so deployments and processes from another workspace have no shared data-plane network. The proxy validates DNS results before connection and again when connecting, rejects loopback, private, link-local, multicast, host/platform networks and cloud metadata, and records destination, port, method, bytes and Run. Secrets are named by `secretRef` and injected by the execution boundary; they are absent from source, model context, arguments, events and tool output.

`secretRef` values are resolved only by the platform's internal account-and-space allowlist endpoint. The resource service passes them over protected local control sockets; executor and deployment workers materialize short-lived files under a root-only runtime directory and mount that directory read-only as `/run/secrets`. Docker configuration contains reference-to-file mappings, never secret values. Missing resolver configuration fails closed.

A deployable Artifact points to an immutable snapshot and contains a structured web-service launch and health specification. The deployment worker reconstructs that snapshot from verified CAS blobs, starts the candidate with gVisor and the workspace limits, and switches its Host route only after health succeeds. Endpoint ownership is claimed globally in PostgreSQL before startup. Failed candidates leave the previous route intact; rollback switches to the retained prior immutable instance. The public TLS proxy forwards only the managed wildcard domain to the loopback deployment router.

Workspace-local edits, dependency installation, tests and bounded processes are covered by workspace execution authorization. Git push, deployment, payment, external resource deletion, data sending and business writes still require explicit current-turn intent and their existing business authorization. Capability routing may reduce which tools the model sees but never grants access.

Every operation request and terminal result is persisted before it may be projected to clients. File changes, process output cursors, network decisions, snapshots, artifacts and deployments are auditable facts. Cancellation terminates the process tree and future work while retaining completed facts. Process sessions are durable metadata and are reconciled against labelled sandbox containers after restart.

## Migration and compatibility

Existing `harness_projects` are converted once to workspaces. Current files and historical versions become content-addressed snapshots; version manifests and concepts become artifacts; session links become multi-resource attachments; legacy deployments become generic deployments while preserving domains and last-known-good service. Database roles, application databases and uploads remain independent persistent resources and require operational hash/availability verification during the maintenance window.

The migration has explicit `--plan`, `--schema`, `--apply`, `--verify` and `--stage-deployments` stages, deterministic IDs, an advisory lock and an idempotent mapping table. Normal startup never runs DDL or data migration. The switch is controlled by `HARNESS_GENERAL_RESOURCES_MODE=off|shadow|enforce`; the former `DAOYIN_` name is read only as a temporary compatibility alias. `shadow` exposes the new path only to authorized inventory without replacing the old runtime. `enforce` removes old `project_*` tools and routes from the Agent path. There is no long-term dual write. Legacy tables stay read-only for seven days after verified cutover and are dropped only by a later explicit operation.

ADR-0021 remains authoritative for identity isolation, gVisor fail-closed behavior, immutable publication, last-known-good failure handling, parent-domain cookie isolation, CSRF/origin checks, domain ownership and independent lifetime of published applications.

## Acceptance

Acceptance uses a small number of real-model scenarios through the authenticated gateway and real tools. It covers Python, Node and Go or Rust workspaces; multi-resource isolation; foreground/background/PTY processes; cancellation and restart reconciliation; public dependency access and denied internal/metadata access; gVisor fail-closed behavior; migration hashes, domains, databases and uploads; and 3–5 SWE-bench Verified tasks treated as ordinary Git workspaces and graded only by the official grader. No SWE-bench-specific branch, fake model, mocked business response or legacy Vitest run is acceptance evidence.
