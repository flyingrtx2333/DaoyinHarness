# Account username and avatar

The signed-in sidebar displays the platform username and profile avatar instead of a fixed account-space label. Missing or failed avatar images fall back to the first username character. Reconnection refreshes the profile; authentication failure and account switches remove the previous identity.

The main-platform bootstrap adds `account: { username: string, avatarUrl: string | null }`, read from the active server-resolved user's `user_name` and `user_avatar_url`. Only display fields enter the browser, remain in memory, and are not stored in transcripts or browser storage. Existing account, tenant and CSRF boundaries are retained. No database migration is needed.

Avatar URLs must use HTTPS without embedded credentials. The workbench image CSP allows HTTPS profile images, including platform object storage. Avatar requests send no referrer; assistant Markdown remote-image rendering remains disabled. Deploy the updated `harness-workbench.conf` with the static release.

Windows validation: typecheck, lint, 294 unit/contract tests and the full build passed. The main-platform isolated MySQL/FastAPI suite passed 35 tests, including current database profile refresh and account switches. Edge mocked-API acceptance passed at 320/390/1280/1920px, including avatar loading under the production CSP, broken-image fallback, profile refresh, account switches and sign-out. Browser screenshots live in `output/playwright/account-access/`. These are fixture accounts, not real-user login evidence.

Main-platform implementation: `922dac9812a7e10f4fc5c981b90a3ee313037f1a`. Production verification is recorded below after deployment.
