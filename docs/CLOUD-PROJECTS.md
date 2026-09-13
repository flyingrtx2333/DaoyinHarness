# Independent cloud projects — server pilot

The authoritative checkout is `root@42.194.159.81:/root/DaoyinHarness`.
This feature does not use Builder or a local developer checkout. The main platform
provides its existing account, execution authorization and model accounting bridge.

## User flow

Open https://harness.daoyintech.com/ and select **项目**. Create or select a project,
then use **在新对话中开发** to continue it. The Agent owns code changes through seven
`project_*` tools. Ordinary chat does not allocate a sandbox. **更新预览** builds a
development snapshot; **打开预览** obtains a one-use authenticated preview ticket.
**发布网站**, or the explicit message **发布当前项目**, deploys a health-checked
immutable snapshot. The previous site remains active if the candidate fails.
The published-version selector rolls code back without rolling database records
or uploaded files back.

Accounts admitted for this pilot: platform actors 1 and 3, explicitly selected by
the user. Public admission remains off. This is a resource-limited first release,
not an unrestricted shell or package-installation service.

## Implemented boundaries

- React/Vite, Node.js/TypeScript, dedicated PostgreSQL metadata and per-project,
  per-environment application databases/roles.
- Website users are separate from Daoyin developer accounts. Built-in document
  collections and uploads are scoped to logged-in website users.
- Public HTTPS integration through the trusted broker with pinned IPv4 DNS,
  private/metadata address rejection, bounded responses and no redirect following.
- Dependencies come from the operator-built pinned runtime image. Arbitrary
  dependency installation and arbitrary SQL/destructive migrations are not exposed.
- Source paths are relative and validated. Maximum 200 files / 5 MiB per project;
  128 KiB per file, 60 files / 512 KiB per write. Up to 100 immutable versions and
  100 operations per project per day. Five projects per account/space.
- One combined development/build slot: 1 CPU, 1536 MiB, 256 PIDs, ten-minute command
  deadline. Development sleeps after 15 minutes of inactivity.
- Two simultaneously hosted projects, each 0.5 CPU / 512 MiB. A temporary third
  production instance is allowed only for a health-checked release transition and
  after the same memory-headroom check.
- Every user program uses gVisor, network=none, non-root user, read-only root and
  source/artifacts, no capabilities, no-new-privileges, and no Docker/host sockets.
- Writable build output is a 32 MiB tmpfs, accepted artifact maximum 20 MiB;
  application socket directories are 1 MiB tmpfs; /tmp is bounded to 256 MiB.
- Application sockets are inode-pinned with O_PATH/O_NOFOLLOW. Descriptor-path HTTP
  pooling is disabled. This prevents symlink races and descriptor reuse from
  routing a request into another environment.
- Trusted project-service requests are bounded before buffering, with 8 concurrent
  broker requests globally / 2 per environment. The project service is capped at
  512 MiB / 1 CPU; the root executor at 256 MiB / 0.5 CPU.
- Website uploads: 5 MiB per file / 100 MiB per environment. Up to 1000 website
  users and 10000 JSON records. Broker writes and quota checks serialize.
- Pilot domains use the reserved `h-` namespace under `demo.daoyintech.com`.
  Slugs may change before first publication; exact existing routes are never
  overwritten. HTTPS uses the existing wildcard certificate.
- Preview is authenticated, isolated and embedded with an iframe sandbox.
  The gateway strips parent/platform cookies and authorization headers before
  user code and filters response cookies to host-only application cookies.
  Main-platform exact Origin, CSRF and account-scope checks remain in force.

## Deployment and persistence

`scripts/build-project-services.mjs` bundles the independent project service,
executor and the inspectable socket policy into an explicit release directory.
`scripts/install-project-services.py` installs the schema and constrained systemd
services and maintains `/opt/daoyin-projects/current`. It preserves configured
credentials and admission; secrets live only in root-managed environment files.

- Project service: `daoyin-projects.service`, control Unix socket, HTTP 127.0.0.1:4715.
- Root executor: `daoyin-project-executor.service`, separate restricted Unix socket.
- PostgreSQL: `harness-projects-db`, isolated Docker network, persistent named volume.
- Source snapshots/artifacts: `/var/lib/daoyin-projects`.
- Domains: exclusively managed exact-name Nginx configuration plus root-owned registry.
- Main-platform overlay: `scripts/deploy-project-platform.py` reads the current
  live image, applies exact project-only patches, checks concurrent deployment
  identity before switching, and records image/source hashes. It never deploys
  the stale main-platform source checkout wholesale.

Back up the dedicated PostgreSQL database volume and the immutable project
artifacts together. Code rollback is not a database backup or restore mechanism.
Service recovery records interrupted operations and stops unfinished candidates;
it does not replay uncertain model calls or overwrite the last successful release.
Published instances survive development shutdown and have independent restart policy.

## Evidence (2026-09-13)

Reports are on the server in `/opt/daoyin-projects/acceptance/`. These are actual
cloud accounts, production model gateway calls, gVisor containers and HTTPS
requests, not mock-model or legacy regression results.

- `iterate.json`: actual model changed an existing project and started preview,
  run `run_e1ab7acf-3521-436f-922e-288d51b53b4f`.
- `publish.json`: actual model published that project,
  run `run_8336487c-9578-4d1e-9ba1-dfb897b1d644`.
- Second account: actual model created `校园活动报名` in
  `run_d7f63d17-0146-4e38-8254-d6c2476cc893`. Its later model response failed after
  two completed tools; the project was retained. `create.json` records successful
  continuation and real preview in `run_e9e11a98-c26c-4804-96a1-995caeafbbf8`.
  These are not claimed to be a flawless single-turn generation result.
- `lifecycle.json`: nine real checks, including both accounts' cross-project
  read/write/publish/ticket rejection; application users and uploads; separate
  development/production databases; failed builds; running cancellation; actual
  update/rollback; service and published-container restart with retained data.
- `sandbox-boundaries.json`: actual container host/path/network/metadata rejection,
  successful controlled public HTTPS, absent secret environment, resource settings,
  real ENOSPC at the writable-directory quota, symlink rejection and inode-pinning
  resistance to a live pathname replacement.
- `browser-auth-boundaries.json`: actual second-account browser login/bootstrap/BFF,
  rejected foreign-site Origin, missing CSRF and caller-supplied ownership.
- browser-ui.json: actual desktop and 390 px workbench, mobile navigation, file browser,
  publication/rollback controls and authenticated iframe content. The published-site
  registration and data-entry interface was also exercised at 390 px.
- Published acceptance site: https://h-412187209e7d.demo.daoyintech.com/

Fresh cloud/UI TypeScript checks, scoped lint and committed-source release builds
are recorded separately from the above runtime evidence. No full-host power-loss
test, CPU/memory stress benchmark or external penetration-test certification is claimed.

## Scoped release during parallel development

When HEAD also contains unrelated code requiring an unapproved migration, build
the cloud/workbench release with --project-overlay followed by the exact current
production revision. The manifest records that base explicitly. The cloud bundle
overlays only the independent projects directory and the shutdown connection fix;
the workbench overlays only its project panel and project styles. This preserves
other work's source and deployment boundaries without creating another checkout
or applying unrelated database migrations.
