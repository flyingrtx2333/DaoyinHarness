# Account connection loop

A 30-day account session exceeded the browser timeout maximum of 2,147,483,647 ms (~24.8 days). The workbench passed its full remaining lifetime to `setTimeout`, which overflowed and fired immediately, repeatedly reconnecting before the conversation could become usable. Anonymous and one-hour mocked-account checks did not cover this case.

The expiry scheduler now waits in bounded intervals and checks the actual deadline before expiring. Account connection failures also expose a retry button. Username/avatar display and account isolation are preserved.

Reproduction: changing the Edge account fixture to 30 days caused the previous UI to time out waiting for the conversation. After the fix the same fixture connects with one bootstrap request and stays ready. Unit coverage advances across the timer limit, checks the exact expiry, cancellation, and shorter visitor sessions.

Production diagnosis: the active account session had more than 2.49 billion milliseconds remaining. Server-resolved account identity, business profile, user display profile and cloud session listing completed in 1.91 seconds; the list contained zero sessions. No credentials or private values were printed, and no model call was made.

Windows validation passed: typecheck, lint, 297 tests and full build. Edge acceptance passed 12 groups, including a 30-day account without repeated bootstrap requests, failure/retry, account switching, profile refresh, and desktop/mobile layouts.

Deployed workbench revision: `f7dc7cf7a08c89c47416759468cd830d7a58d8cd` (2026-09-06 14:42 China time). All four HTTPS artifacts match the committed Windows build. Production anonymous/private and Origin checks still reject correctly. Deployed assets with a mocked 30-day account response stayed connected with one bootstrap, a usable composer and visible username/avatar at 1280px and 390px. This browser evidence uses a fixture account; the production account service path was diagnosed separately above. The main backend, cloud kernel and database schema were unchanged. Previous static release: `78c952a35f9586586d9439b975ee5fb736c6ce6c`.
