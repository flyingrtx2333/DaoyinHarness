# ADR-0034: Persistent login with bounded execution credentials

- Date: 2026-10-11
- Status: Accepted by the owner.
- Scope: Explicitly authorized minimal main-platform login change; Feishu connection management remains in Harness.

First-party login persists until explicit logout/revocation or account disablement. A null expiry on the platform account-session row records this policy. The cookie stays HttpOnly, Secure on production domains, SameSite=Lax and server-side hash-only. Browser storage may expire or be cleared independently; the 400-day cookie is refreshed on authenticated login/bootstrap.

Existing valid sessions upgrade only when authenticated bootstrap succeeds. Expired or revoked sessions are not restored. JWTs, OAuth credentials and manual business grants retain their existing expiry semantics.

Account execution grants remain bounded: platform time buckets issue a new grant every 12 hours, valid to the end of the next bucket (12–24 hours). Stable account/tenant installation identity preserves transcripts and billing. Old grants are not extended; the overlap lets already admitted runs finish while new requests use the next credential. Every authorization still validates the linked session and current user/business permissions. Logout therefore invalidates all linked grants.

Harness already re-bootstraps when its credential expires and when the page becomes visible. No model-provider secret, browser password or account cookie is persisted in Harness. This login change does not itself finish the pending Feishu onboarding or introduce an unattended renewal API.

An additive schema change makes account-session expiry nullable; it does not revive or bulk-update historical sessions. Production application must precede code deployment. Do not roll back to older code after persistent sessions exist without first handling its incompatible null-expiry assumptions.
