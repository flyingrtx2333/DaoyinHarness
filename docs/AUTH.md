# DaoyinHarness Authentication

> Status: required main-platform contract for v1. The current Daoyin platform does not yet expose these OAuth endpoints.

## 1. Decision

DaoyinHarness is an OAuth 2.1 public client using Authorization Code with PKCE. It must not ask for, proxy, inspect, or store a Daoyin account password. The current username/password endpoint and long-lived platform JWT are not a substitute for this flow.

Registered client:

```text
client_id: daoyin-harness
client_type: public
grant_types: authorization_code, refresh_token
response_types: code
pkce: S256 required
redirect_uri policy: http://127.0.0.1:<dynamic-port>/auth/callback
```

`localhost`, LAN addresses, wildcard hosts and `0.0.0.0` are not valid redirect hosts. Dynamic loopback ports are allowed only for this registered native client.

## 2. Main-platform endpoints

### `GET /api/oauth/authorize`

Required query parameters:

```text
client_id=daoyin-harness
response_type=code
redirect_uri=http://127.0.0.1:<port>/auth/callback
code_challenge=<base64url-sha256-verifier>
code_challenge_method=S256
state=<cryptographically-random-value>
scope=openid profile harness:use
```

The platform authenticates the user in its own first-party page, displays the requesting product and scopes, and redirects only after consent or a safe denial. Existing platform login cookies may be reused by the platform page; they are never shared with the local origin.

Authorization codes are single-use, expire after 60 seconds, are bound to the client, exact redirect URI and PKCE challenge, and contain no user data visible to the browser.

### `POST /api/oauth/token`

Authorization-code exchange body:

```json
{
  "grant_type": "authorization_code",
  "client_id": "daoyin-harness",
  "code": "...",
  "redirect_uri": "http://127.0.0.1:4677/auth/callback",
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
  "scope": "openid profile harness:use"
}
```

Access tokens expire after 15 minutes. Refresh tokens expire after 30 days, rotate on every successful use, and invalidate the previous token. Reuse of an already rotated token revokes the token family and requires a new login.

### `POST /api/oauth/revoke`

Accepts a refresh or access token plus `client_id`. Logout is idempotent and invalidates the corresponding local-device grant. The platform account page must eventually list and revoke authorized DaoyinHarness devices.

### `GET /api/oauth/userinfo`

Requires the access token and returns only the local product identity:

```json
{
  "sub": "stable-account-id",
  "name": "display name",
  "avatar_url": "https://...",
  "tenant_id": "optional-active-tenant",
  "scopes": ["openid", "profile", "harness:use"]
}
```

The local filesystem uses `sub`, never display name, as the account namespace.

## 3. Local login flow

1. The UI calls `POST /api/v1/auth/login` with a valid CSRF token.
2. The local server generates a 32-byte `state`, a PKCE verifier and S256 challenge.
3. Pending-login state is held server-side with a five-minute expiry and bound to the browser session.
4. The server returns the main-platform authorization URL; the browser navigates there.
5. The platform redirects to the exact loopback callback with `code` and `state`.
6. The local server verifies state before exchanging the code over a direct HTTPS request.
7. The server stores the refresh token in the OS credential manager and retains the access token in process memory.
8. The server fetches `userinfo`, creates the account data directory and rotates the local browser session ID.
9. The callback returns a short success page that redirects to the local application without placing tokens in the URL.

PKCE verifier, authorization code and state are never logged or written to transcripts.

## 4. Local browser session

The local server issues a random opaque cookie:

```text
HttpOnly; SameSite=Strict; Path=/; Max-Age=<process-session>
```

`Secure` is used when a future local HTTPS mode exists; loopback HTTP v1 relies on loopback binding plus Host and Origin validation. Every state-changing request also requires a session-bound CSRF token delivered through authenticated bootstrap JSON, not a readable authentication cookie.

The cookie authenticates only the browser to the local process. It is not accepted by the Daoyin cloud.

## 5. Credential storage

The runtime exposes a `CredentialStore` interface with per-platform adapters:

- Windows Credential Manager/DPAPI.
- macOS Keychain.
- Linux Secret Service.

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

The user-facing model endpoint requires `harness:use`, validates account status and quota, and emits a request/audit ID. It accepts normalized messages and tool schemas but never executes local tools. The cloud credential must not be forwarded to model providers or included in model input.

The local client contract is now implemented in `packages/cloud`. The planned main-platform endpoint is:

```text
POST /api/ai/harness/responses
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

The client accepts HTTPS only, except loopback HTTP for a local development gateway. It bounds response size and timeout, validates the normalized output shape, and maps authorization, quota, rate-limit and upstream failures to stable `MODEL_*` errors. Until the platform OAuth endpoints exist, a development-only bridge may inject a process-memory credential through `DAOYIN_HARNESS_GATEWAY_URL` and `DAOYIN_HARNESS_GATEWAY_CREDENTIAL`; this bridge is not the production authentication design and never writes the credential to Harness state.

## 8. Required tests

- Successful PKCE login with a dynamic loopback port.
- State mismatch, missing verifier, wrong redirect URI, expired code and code replay.
- Refresh rotation and replay-family revocation.
- Local callback requested from a non-loopback Host.
- Browser Origin and CSRF rejection.
- Credentials absent from localStorage, SQLite, logs, transcript and URLs.
- Expired access token refresh without duplicate model requests.
- Offline restart, account switching, logout and platform-side device revocation.

