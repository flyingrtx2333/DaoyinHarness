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

Validation uses a bounded set of real-model / real-cloud scenarios and direct runtime checks. No mock-model or legacy test suites. Production, model, packaging and browser results are reported separately.
