# C concept implementation acceptance

Date: 2026-09-05. Selected direction: C, warm paper canvas, dark navigation rail, coral actions, quiet paper-and-leaf artwork. Local implementation only; no production deployment.

## Implemented surfaces

- Harness at `http://127.0.0.1:4677/`: empty workspace, conversation, history, composer, account popover, files, tasks, tool progress, permission controls and responsive navigation.
- Daoyin platform at `http://127.0.0.1:6087/api/oauth/authorize`: account authorization form, validation/error state and responsive layout. OAuth callback presentation also uses the shared visual direction.
- Repeated capability descriptions and diagnostic badges were removed from the primary reading path. Tool details are expandable. Labels, status and actions remain real DOM, not a screenshot background.

Primary implementation: `packages/ui/src/App.tsx`, `packages/ui/src/canvas.css`, `packages/server/src/app.ts`; companion platform files: `backend/routes/daoyin_harness.py`, `backend/templates/daoyin_harness_authorize.html`, `backend/static/harness/` and `backend/tests/test_daoyin_harness.py`.

## Artwork provenance

ImageGen independently generated the isolated paper-and-leaf artwork using the selected concept as a visual reference. The prompt requested ivory paper sheets, a coral paper corner, a green leaf, a circular paper disc, soft particles and shadows on a warm canvas, with no UI, text or icons. The resulting PNG was converted to WebP; no complete concept image is rendered by the application.

- Source: `C:/Users/17489/.codex/generated_images/01a0680a-711d-77d1-9c8d-de55575b4922/exec-af987dba-5d96-4c2d-95ae-d1716472862e.png`.
- Runtime asset: `packages/ui/public/assets/paper-seed.webp`, 1536 × 1024, 85,624 bytes; identical copy at platform `backend/static/harness/paper-seed.webp`.
- Selector map: Harness `.paper-art`; platform `.art img`. Navigation, brand mark, form fields, buttons and text are code-native.

## Validation evidence

All Harness commands ran from Windows PowerShell with Node.js 22.23.2. Platform checks were invoked from Windows against its Docker development container, not by a WSL contributor.

| Check | Result | Evidence boundary |
| --- | --- | --- |
| `npm run typecheck` | Passed | Static types |
| `npm run lint` | Passed | Static checks |
| `npm test` | 29 files, 101 tests passed | Automated repository tests |
| `npm run build` | Passed | Local build, not deployment |
| Platform Harness pytest suite | 6 passed | OAuth contracts, escaping and fixed asset routes |
| Platform development image build | Passed | Local Docker development image |
| `node scripts/verify-canvas-ui.mjs` | 18 evidence entries, no console errors or failed requests | Real Edge browser; see boundaries below |

The browser report is [browser-verification.json](browser-verification.json). Live local pages cover desktop, tablet, 390 px and 320 px layouts, a 720 px-high authorization view, panels, history, account menu, Escape/focus return, planning control, login redirect and required fields. The error screenshot uses a local DOM fixture. Conversation, permission approval, cancellation, duplicate-submission prevention, reconnect from event 4 and refresh replay use explicitly mocked API/WebSocket responses in a real browser. They do not prove actual model execution or production authentication.

## Selected-reference comparison

Both references and final desktop screenshots are 1586 × 992. Gate: normalized MAE ≤ 0.035, similarity ≥ 0.965, within RGB tolerance 24 ≥ 0.90.

| Screen | MAE | Similarity | Within tolerance | Result |
| --- | --- | --- | --- | --- |
| Workbench | 0.031974 | 0.968026 | 0.921640 | Pass |
| Authorization | 0.028688 | 0.971312 | 0.951549 | Pass |

See [workbench comparison](agent-workbench/comparison.json), [authorization comparison](oauth-consent/comparison.json), and each directory's selected reference, rendered screenshot, diff and overlay artifacts. Scores are aggregate pixel comparisons, not a claim that every component is within 3 px.

## Residual differences and deliberate adaptations

Approximate rectangles below use `(x, y, width, height)` at the desktop comparison size.

| Screen / region | Type | Difference |
| --- | --- | --- |
| Workbench `(150,136,310,480)` | State | Real empty history replaces the concept's invented conversation rows; panel is shorter. |
| Workbench `(630,235,650,100)` | Typography | Shorter Chinese heading and actual system font rendering. |
| Workbench `(630,360,700,350)` | Asset | Independently generated paper, leaf and shadows differ in detail. |
| Workbench `(375,700,1000,220)` | Component | Redundant capability row removed; functional composer has more breathing room. |
| Workbench `(0,0,124,992)` | Navigation | Duplicate status and explanatory labels simplified. |
| Authorization `(0,0,124,992)` | Navigation | Brand-only rail omits concept navigation that has no action on the OAuth page. |
| Authorization `(298,180,440,80)` | Typography | Chinese platform brand replaces the concept's English eyebrow. |
| Authorization `(298,260,440,110)` | Copy | Authorization description shortened. |
| Authorization `(850,360,700,400)` | Asset | Independent artwork differs in leaf and paper geometry. |
| Authorization `(298,620,438,170)` | Component | Functional login-and-authorize text, concise scope/trust copy, no decorative password control. |

Manual screen-reader acceptance, comprehensive enlarged-text acceptance, field performance, real account login and real AI Gateway/model calls remain unverified. Visual comparison does not replace those checks.
