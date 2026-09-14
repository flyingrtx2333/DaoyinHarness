# ADR-0021: Independent cloud projects and isolated application hosting

- Status: Accepted for implementation; public admission gated on acceptance.
- Date: 2026-09-13
- Authority: user-approved cloud-only plan; no Builder dependency.

Harness owns account-scoped projects, session links, immutable source versions and deployment facts in dedicated PostgreSQL tables. A separate root-owned executor accepts bounded operations over a protected Unix socket; the Agent never receives Docker access. Runtime images and host paths are operator-controlled.

Every generated program runs under gVisor with network=none, non-root uid, no capabilities, resource limits and only its own mounted files. Project-specific Unix brokers provide database, uploads and validated public HTTPS requests without exporting infrastructure credentials. Development and production data are separate. Broker endpoints enforce sizes, quotas and user/session ownership.

One development/build slot (1 CPU, 1536 MiB, 256 PIDs) and two online applications (each 0.5 CPU, 512 MiB) are admitted only with host memory headroom. Idle development stops after 15 minutes. No fallback to runc or host execution is permitted. Online applications outlive development and conversations.

A session binds to one project; multiple sessions may share it. Writes serialize under database advisory locks. Operations are durable and idempotent; unknown external effects are reconciled, never blindly replayed. Cancellation preserves prior events and the last successful release.

Publication requires a UI request or explicit current-turn publication instruction, binds to an immutable source version, and switches the public route only after health succeeds. Rollback selects a previous immutable artifact; it does not roll back application data. Domain changes cannot overwrite another owner or existing legacy routes. Preview uses short-lived single-use tickets exchanged for host-only HttpOnly cookies on an isolated origin. The existing platform uses a parent-domain HttpOnly cookie. The trusted gateway strips all platform cookies and authorization before user code, forwards only the application __Host cookie, and rejects user responses attempting to set parent-domain cookies. Existing platform CSRF and exact Origin checks remain mandatory.

React/Vite + Node.js/TypeScript is the first template. The trusted application SDK supplies separate website login, JSON document collections, uploads and public HTTP integration. Database roles are isolated per project/environment; no arbitrary destructive migration capability is exposed.

Main-platform changes are limited to existing account/permission/model bridge and authenticated proxy support. No second plugin consent or privileged identity is introduced. New functionality is feature-gated and initially admitted only for explicitly configured test accounts.

Concept-first UI work is a durable project capability. The Agent inspects current project files, generates A, B and C as separate complete 1536×864 concepts through the dedicated harness-projects.ui_concept model scene, and stops for the user's choice. Concept bytes, prompts and tradeoffs are stored in project PostgreSQL; account-scoped image reads pass through the authenticated workbench. While a concept set is generating or awaiting selection, the repository rejects source writes. Selection creates a versioned manifest and advances the project revision before implementation resumes. This state is independent from Builder and survives reconnects and service restarts.

Validation uses a bounded set of real-model / real-cloud scenarios and direct runtime checks. No mock-model or legacy test suites. Production, model, packaging and browser results are reported separately.

The pilot account adapter validates real account sessions and active tenant membership. A project-only installation has an independent identity boundary and no inherited business tools when the account lacks an unrelated business application subscription. Existing business tool authorization is unchanged.

Build and development share one slot. A build may suspend its own preview but never its published application; another project's active development queues it. Immutable completed artifacts can be reused without allocating a build sandbox. Completion markers are root-owned outside writable artifacts. Published containers restart independently; interrupted operations are recorded and unfinished candidates are stopped on service recovery.

The workbench CSP explicitly permits preview iframe origins. User code receives neither parent-domain cookies nor platform authorization headers. The gateway controls response security headers and cookie forwarding; the app origin itself is never treated as a trusted platform origin.

Writable build outputs use a 32 MiB tmpfs and runtime socket directories use a 1 MiB tmpfs. Code and verified artifacts are read-only in every user container; /tmp is separately bounded. Root copies verified completed outputs into immutable storage only after the build container stops. These mounts are restored for existing instances after startup.

Gateway and health connections pin the Unix socket inode using Linux O_PATH plus O_NOFOLLOW, reject symlinks and non-sockets, and connect through the pinned descriptor. HTTP connection pooling is disabled on descriptor paths because descriptor numbers are reusable. Real acceptance alternates preview and production requests and verifies that development cannot change the online page.
