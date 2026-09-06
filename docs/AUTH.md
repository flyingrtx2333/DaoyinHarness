# DaoyinHarness Authentication

> This document covers the local OAuth client. Current unified platform evidence is in [UNIFIED-AGENT.md](UNIFIED-AGENT.md); production login availability must be verified live rather than inferred from this source document.

## Automatic account access for all business plugins

All Harness business plugins must inherit the signed-in account's full existing permissions for the selected space, including reads, writes, generation and management, without per-plugin consent, manual grants, scope checkboxes or pasted credentials. Reuse valid account connections and issue execution credentials internally. Authentication and business access checks remain required; do not create an Agent-only permission subset. External services without a usable connection may require their own sign-in, but Harness adds no extra plugin consent. [ADR-0012](adr/0012-first-party-account-access.md) defines this rule and the distinction between implemented Saishi reads and pending business capabilities.

## Cloud public execution authorization

The public company entry uses an independent random, 30-minute visitor grant issued by the main platform, not a local OAuth token or an employee account. The platform stores only its hash, visitor ID, explicit sponsor membership, policy version, expiry and revocation. The browser receives an HttpOnly SameSite Cookie; state changes require the configured Origin and a CSRF token. Login/refresh/logout for local accounts remains separate.

Harness introspects the visitor grant through the dedicated service-authenticated platform bridge, then rechecks the entire identity before and after model/tool work. Changing sponsor, policy revision or active membership invalidates the grant. Visitor permissions never inherit the sponsor's administrator role. See [ADR-0008](adr/0008-platform-public-bridge.md) and [the bridge protocol](../packages/server-cloud/README.md).

## 1. Decision

DaoyinHarness is an OAuth 2.1 public client using Authorization Code with PKCE. It must not ask for, proxy, inspect, or store a Daoyin account password. The current username/password endpoint and long-lived platform JWT are not a substitute for this flow.

Registered client:

```text
client_id: daoyin-harness
client_type: public
grant_types: authorization_code, refresh_token
response_types: code
pkce: S256 required
redirect_uri policy: http://127.0.0.1:<port 4677-4699>/api/v1/auth/callback
```

`localhost`, LAN addresses, wildcard hosts and `0.0.0.0` are not valid redirect hosts. Dynamic loopback ports are allowed only for this registered native client.

## 2. Main-platform endpoints

### `GET /api/oauth/authorize`

Required query parameters:

```text
client_id=daoyin-harness
response_type=code
redirect_uri=http://127.0.0.1:<port>/api/v1/auth/callback
code_challenge=<base64url-sha256-verifier>
code_challenge_method=S256
state=<cryptographically-random-value>
scope=harness:ai
```

The platform authenticates the user in its own first-party page and validates the registered Harness client, redirect URI and PKCE challenge. The product requirement is to reuse an existing platform login and complete the first-party connection without an additional scope-consent screen; when no valid login exists, show platform sign-in. Existing platform login cookies are never shared with the local origin. This requirement does not claim that every local OAuth or business adapter has already been delivered; track current implementation separately.

Authorization codes are single-use, expire after 120 seconds, are bound to the client, exact redirect URI and PKCE challenge, and contain no user data visible to the browser.

### `POST /api/oauth/token`

Authorization-code exchange uses `application/x-www-form-urlencoded` with these fields:

```json
{
  "grant_type": "authorization_code",
  "client_id": "daoyin-harness",
  "code": "...",
  "redirect_uri": "http://127.0.0.1:4677/api/v1/auth/callback",
  "code_verifier": "..."
}
```

Refresh body:

```json
{
  "grant_type": "refresh_token",
  "client_id": "daoyin-harness",
  "refresh_token": "..."
}
```

Successful response:

```json
{
  "access_token": "...",
  "token_type": "Bearer",
  "expires_in": 900,
  "refresh_token": "...",
  "refresh_expires_in": 2592000,
  "scope": "harness:ai",
  "user": { "id": 7, "user_name": "example", "tenant_id": 3 }
}
```

Access tokens expire after 15 minutes. Refresh tokens expire after 30 days, rotate on every successful use, and invalidate the previous token. Refresh-token family replay detection and device-grant management remain release hardening work.

### `POST /api/oauth/revoke`

Accepts a refresh or access token plus `client_id`. Logout is idempotent and invalidates the corresponding local-device grant. The platform account page must eventually list and revoke authorized DaoyinHarness devices.

## 3. Local login flow

1. The UI calls `POST /api/v1/auth/login` with a valid CSRF token.
2. The local server generates a 32-byte `state`, a PKCE verifier and S256 challenge.
3. Pending-login state is held server-side with a five-minute expiry and bound to the browser session.
4. The server returns the main-platform authorization URL; the browser navigates there.
5. The platform redirects to the exact loopback callback with `code` and `state`.
6. The local server verifies state before exchanging the code over a direct HTTPS request.
7. The server stores the refresh token in the OS credential manager and retains the access token in process memory.
8. The token response supplies the minimal account summary used by the local UI.
9. The callback returns a short success page that redirects to the local application without placing tokens in the local application URL.

PKCE verifier, authorization code and state are never logged or written to transcripts.

## 4. Local browser session

The local server issues a random opaque cookie:

```text
HttpOnly; SameSite=Strict; Path=/; Max-Age=<process-session>
```

`Secure` is used when a future local HTTPS mode exists; loopback HTTP v1 relies on loopback binding plus Host and Origin validation. Every state-changing request also requires a session-bound CSRF token delivered through authenticated bootstrap JSON, not a readable authentication cookie.

The cookie authenticates only the browser to the local process. It is not accepted by the Daoyin cloud.

## 5. Credential storage

The runtime exposes a `CredentialStore` interface. The current Windows implementation uses current-user DPAPI through the built-in PowerShell security module:

- Windows current-user DPAPI: implemented and verified with an encrypted round trip.
- macOS Keychain and Linux Secret Service: deferred because Windows is the sole test/build/runtime environment for this repository.

Stored key: service `DaoyinHarness`, account `<sub>:refresh-token`. SQLite stores only account ID, display metadata, scopes, expiry and credential-store reference.

If a supported credential manager is unavailable, v1 falls back to an in-memory session and clearly states that login will be required after restart. It must not silently write plaintext credentials to disk.

## 6. Token use and failure handling

- The local browser never receives cloud tokens.
- Only the Cloud Client attaches an access token to Daoyin HTTPS requests.
- Refresh happens once when the access token is near expiry; concurrent requests share one refresh operation.
- `invalid_grant` clears the stored credential and changes local auth state to `login_required` without deleting projects.
- Network failure preserves the credential and reports `offline`; it is not treated as logout.
- Account switching stops active model calls before changing the account namespace.
- Logout revokes cloud credentials when reachable, clears local credentials regardless, and leaves local project files intact.

## 7. AI Gateway authorization

The user-facing model endpoint requires `harness:ai`, validates current account/tenant membership and Builder credit, and emits a request/audit ID. It accepts normalized messages and tool schemas but never executes local tools. The cloud credential is not forwarded to model providers or included in model input.

The local client and main-platform handler are implemented. The endpoint is:

```text
POST /api/harness/ai/responses
Authorization: Bearer <short-lived access credential>
Content-Type: application/json
```

Request body:

```json
{
  "schemaVersion": 1,
  "model": "optional-policy-model",
  "messages": [],
  "tools": [
    {
      "name": "read_file",
      "description": "...",
      "inputSchema": {}
    }
  ],
  "systemPrompt": {
    "stableText": "...",
    "dynamicText": "...",
    "sections": [
      { "id": "identity", "kind": "stable" }
    ]
  }
}
```

Successful response:

```json
{
  "schemaVersion": 1,
  "requestId": "req_...",
  "output": {
    "kind": "assistant",
    "content": "..."
  }
}
```

or:

```json
{
  "schemaVersion": 1,
  "requestId": "req_...",
  "output": {
    "kind": "tool_calls",
    "content": "optional assistant preface",
    "calls": [
      { "id": "call_...", "name": "read_file", "input": { "path": "README.md" } }
    ]
  }
}
```

The client accepts HTTPS only, except loopback HTTP for a local development gateway. It bounds response size and timeout, validates the normalized output shape, and maps authorization, quota, rate-limit and upstream failures to stable `MODEL_*` errors. `DAOYIN_PLATFORM_URL` may explicitly point Windows development at a loopback main-platform backend; production defaults to `https://www.daoyintech.com`. The earlier static development credential bridge remains available only for isolated gateway tests.

## 8. Required tests

- Successful PKCE login with a dynamic loopback port.
- State mismatch, missing verifier, wrong redirect URI, expired code and code replay.
- Refresh rotation and replay-family revocation.
- Local callback requested from a non-loopback Host.
- Browser Origin and CSRF rejection.
- Credentials absent from localStorage, SQLite, logs, transcript and URLs.
- Expired access token refresh without duplicate model requests.
- Offline restart, account switching, logout and platform-side device revocation.
