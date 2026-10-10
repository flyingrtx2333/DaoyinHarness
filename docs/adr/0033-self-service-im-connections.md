# ADR-0033: Account-owned, self-service IM connections

- Date: 2026-10-10
- Status: Product decision accepted; implementation pending coordinated platform scope.
- Supersedes: ADR-0032's operator-maintained configuration as the public onboarding path.

## User requirement

Each authenticated user connects their own Feishu application through Harness, in a setup flow similar to Hermes messaging setup. No owner-specific application, sender, conversation, cloud session or execution credential is hardcoded. The existing IM gateway foundation does not yet implement this product flow and must not be released as if it does.

## Product flow

1. Open “渠道连接”, add Feishu, and enter the user's own App ID and App Secret in a secure form. Never ask for secrets in chat.
2. Verify application credentials against Feishu; show validation failure separately from a disconnected transport. Secrets are submitted once, stored encrypted server-side, and never returned in list/detail responses.
3. Prefer the official Feishu SDK's outbound long connection. Show the required bot capability, permissions and message event configuration. Users do not maintain a public callback URL, sender IDs or runtime execution tokens.
4. Pair the desired Feishu identity using a short-lived, one-use code displayed in Harness and sent in private chat. An arbitrary sender reaching a bot does not automatically gain access to the account or consume its credits.
5. Create a dedicated cloud session automatically for each connection/sender/conversation tuple. Route actual private text into the same cloud Agent, platform model provider, tools and account billing used by the web workbench.
6. List connection status, last inbound/outbound message time and a concise actionable failure stage. Support secret replacement, pause/resume and disconnect. Disconnection stops new admissions; it preserves existing session transcripts and billing records.

Scan-to-create onboarding is a desirable later enhancement, subject to verification of the official Feishu provisioning flow. Do not claim that it exists merely because Hermes offers it. First delivery supports private text; files, voice, groups and scheduled push messages need their own implemented contracts.

## Ownership and interfaces

The main platform owns authenticated accounts, connections, installations, authorization and billing. Harness owns transport adaptation, durable delivery processing and the existing session/run execution path. Do not create a parallel identity or an independent model client.

Proposed account BFF surface, subject to implementation:

- `GET /api/agent-apps/saishi/workbench/im/connections`: sanitized connections for the current authenticated account only.
- `POST .../im/connections`: validate and create an account-owned Feishu connection; never accept account/tenant IDs from the browser.
- `POST .../im/connections/:id/pairing`: issue an expiring, single-use pairing code.
- `POST .../im/connections/:id/action`: pause, resume, disconnect or rotate the application's secret, guarded by the same account cookie, CSRF and scope checks as the workbench.

Connection metadata contains platform-derived owner/tenant IDs, app ID, label, encrypted-secret reference, configuration generation and status. Enforce one active ownership of an application within the deployment; replacement requires verified account ownership. Pairings are scoped to the connection and account. Raw secrets, pairing codes and execution credentials never enter audit transcripts or model context.

The platform provides a short-lived, validated execution grant for an enabled connection at admission time. The grant uses current account permissions and normal metering. Browser cookies and copied static runtime tokens are not unattended gateway credentials. Revoking the connection or the account stops new grants. No model-provider secrets are sent to Harness.

The IM service loads enabled connection configurations through authenticated internal platform calls, acquires one connection worker owner, and connects only after configuration validation. It preserves message deduplication and the existing uncertain-delivery rule. Reconnection does not replay an uncertain run or send. All lookups and writes enforce connection ownership and current configuration generation.

## Delivery gate

Implement and review the BFF, encrypted connection persistence, execution-grant issuance and revocation together with the Harness connection UI and long-connection worker. The current static JSON/env binding approach remains a development foundation, not the user-facing product.

Production deployment requires exact committed artifacts and explicit new-table migration scope. Real acceptance uses at least one actual user-owned Feishu bot/private message, platform model/tool events, persisted delivery and observed reply. A second account verifies isolation when authorized credentials are available. No fabricated Feishu messages or fake model/business responses count as acceptance.

## Existing-interface audit — 2026-10-10

Read-only inspection confirmed that the inspected local platform sources match the running `daoyintech-backend` container byte-for-byte for `routes/agent_apps.py`, `services/agent_app_access.py`, and `services/first_party_accounts.py` (SHA-256 comparison).

- `workbench/bootstrap` already resolves the signed-in account and derives full-account execution access using `for_account`. Account scope and CSRF are derived server-side. Reuse these for connection management; do not introduce another login flow.
- Existing runtime `introspect`, `authorize`, profile/model/tool bridge calls already enforce account identity, current business permissions and unified model billing. Reuse them unchanged where possible.
- `for_account` ties the execution grant to `first_party_account_sessions`, with the same expiry. `_validate` checks the session's expiry/revocation on subsequent authorization. Merely closing the browser does not revoke it, but the current grant does not become a durable channel authorization.
- No Feishu/channel management or account-grant renewal entrypoint was found in the inspected platform Python/SQL sources. The existing OAuth refresh endpoint is for `harness:ai` / `daoyin-harness-ai`; its tokens are not the full-account cloud Agent grants admitted by `agent_app_access.resolve`. It cannot silently substitute for cloud execution authorization.

The minimum proposed coordinated platform change is therefore account-owned channel connection persistence/management plus channel-bound unattended execution admission/renewal/revocation. This is an extension of existing account authorization, not a replacement of model providers, tool permissions or billing. Feishu transport, automatic conversation/session mapping, queueing and message replies remain Harness responsibilities. No production migration or platform edit was performed during this audit.
