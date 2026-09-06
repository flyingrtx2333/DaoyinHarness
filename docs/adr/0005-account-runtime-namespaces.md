# ADR 0005 — Authenticated runtime namespaces

Date: 2026-09-05. Status: implemented in source; Windows acceptance pending.

## Problem

OAuth identity was connected to the model gateway while local facts, memories and process permissions still used `accountId: local`. Changing accounts could reuse another account's local state. An HTTP refresh error also cleared credentials even for transient failures.

## Decision

- Derive an opaque account key from the trusted authorization authority, tenant ID and user ID. Display names, browser input and model tool arguments are never identity sources.
- With authentication configured, store session catalogs/transcripts, memory, compaction, orchestration, permission facts and recent workspaces under `accounts/<account-key>/`. Signed-out state uses a separate namespace.
- Keep explicitly unauthenticated development/test runtimes in the existing `local` namespace. Do not automatically import, rewrite or assign legacy local transcripts to an OAuth account. Existing data stays on disk; any migration requires a separate explicit user decision.
- Login callbacks and logout require an idle runtime and exclude concurrent requests while swapping the account runtime. Recreate services, rotate browser cookie/CSRF/workspace revision, and close old event sockets. Workspace switching retains the current account namespace.
- Check the authenticated identity against the runtime identity before serving protected requests. A refresh-induced sign-out cannot expose the previous account. Bootstrap can rebind an idle runtime; other stale requests fail with `AUTH_CONTEXT_CHANGED` and require a refresh.
- Shared refresh is independent of one caller's cancellation. Only a confirmed `invalid_grant` clears credentials. Transient HTTP/network failures preserve them. Generation checks and serialized credential writes prevent late responses from resurrecting logout or crossing account identities.

## Boundaries

This isolates application data between authenticated accounts in one local installation, not from the operating-system user who owns the files. User-selected filesystem workspaces remain explicitly shared physical directories, not copies or per-account filesystem sandboxes. No production OAuth deployment, refresh-family server implementation, platform migration or cross-platform credential-store expansion is included.

## Validation

New account namespace, account switching and OAuth failure/race tests are source changes only until run on Windows PowerShell. Existing acceptance JSON files predate this change and must not be cited as validation of it.
