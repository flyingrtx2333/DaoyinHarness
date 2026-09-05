# DaoyinHarness Testing and Reliability

> Current Windows verification for the unified platform is recorded in [UNIFIED-AGENT.md](UNIFIED-AGENT.md#验证记录). Results describe the tested working checkout; visual workbench and real-account acceptance remain separate.

> Passing one layer never implies a higher layer passed. Platform-adapter tests use the real AgentEngine and SQLite with simulated HTTP/provider responses. Backend bridge tests run from Windows Docker Compose against isolated MySQL and FastAPI, with fixture memberships, provider and corpus; no production data or billable model calls.

## 1. Evidence levels

Every report labels its evidence level:

| Level | Meaning | May claim |
| --- | --- | --- |
| `static` | Type, lint, schema or source inspection | The checked contract/source condition holds |
| `unit` | Deterministic isolated code | The tested function or state transition holds |
| `replay` | Recorded model/tool fixtures | The orchestration handles known event sequences |
| `integration` | Real local stores/processes with isolated cloud fixtures | Local components interoperate |
| `real-model` | Billable request through the Daoyin AI Gateway | The selected model handled the exact scenario |
| `browser` | Real local server and browser | Visible local UI/preview behavior works |
| `production` | Deployed service and real account | The named production path works at the recorded time |

Mock or replay success is never described as real-model quality, a local preview is never described as a public deployment, and a successful build is not proof that required routes or interactions work.

## 2. Test suites

### Unit tests

Cover pure reducers, state machines, path policies, event ordering, memory scoring, context budgeting, checkpoint promotion, redaction and error classification. Side-effect dependencies are injected rather than globally mocked.

### Protocol contract tests

Validate REST schemas, WebSocket envelopes, monotonic `eventSeq`, unknown-field compatibility, idempotency, error codes and sanitized tool display. Shared protocol fixtures are consumed by both server and UI tests.

### Deterministic Agent replay

Replay normalized model streams and tool results through the real Agent loop. Required fixtures include:

- assistant text without tools;
- one tool and final answer;
- multiple sequential tools;
- tool failure followed by an accurate summary;
- malformed or oversized tool result;
- cancellation during model streaming and during a child process;
- interruption after a tool completed but before the model saw its result;
- context compaction followed by continued work;
- additional user requirement arriving at a model boundary.

Replay tests prove orchestration and persistence, not model intelligence.

### Integration tests

Use temporary data directories, real JSONL transcripts, real SQLite and controlled child processes. Verify restart recovery, index rebuild, project serialization, preview lifecycle and OS-specific path protections.

### Real-model gates

Real-model suites are opt-in, budgeted and tagged. Each case records prompt, selected context, model identifier, tool schemas, threshold, output tokens, latency, cost/audit ID, verdict and redacted evidence.

Required quality gates include:

- recalls explicitly required project memory without importing unrelated memory;
- continues from existing files rather than starting a duplicate project;
- reports the actual failing stage after a tool or storage error;
- does not claim preview or file evidence that does not exist;
- produces a terminal user-facing response after terminal failure;
- handles a one-page application within the configured turn/tool budget.

### Browser E2E

Run the packaged local server with Playwright. Verify visible interaction, WebSocket reconnect, loading indicators, message preservation, project switching, preview isolation, responsive layout and absence of uncaught console errors.

## 3. Mandatory scenarios

| Scenario | Required evidence |
| --- | --- |
| First login | PKCE integration plus browser redirect |
| Invalid/expired token | Auth integration; project files remain intact |
| Default port occupied | CLI integration selects next port |
| Explicit port occupied | CLI returns stable error and does not scan |
| Page refresh during tool | Browser reconnect replays every persisted event once logically |
| User cancellation | Replay and child-process integration |
| User correction/addition | Replay shows original and added messages preserved |
| Network interruption | Agent pauses or summarizes accurately; no fake logout |
| Process crash | Restart reconstructs session and incomplete turn state |
| Failed build | Last usable checkpoint and preview remain selected |
| Workspace isolation | Cross-project traversal, symlink and junction tests |
| Tool error | Raw payload hidden; Agent final summary present |
| Memory recall | Required fact retrieved, forbidden/unrelated facts absent |

## 4. Memory evaluation

Memory tests define a dataset containing:

- conversation and project histories;
- query at the future turn;
- `must_recall` memory IDs;
- `must_not_recall` memory IDs;
- acceptable answer facts;
- leakage and contradiction labels.

Metrics:

- required-memory recall;
- retrieval precision;
- forbidden-memory leakage rate;
- stale/superseded-memory usage;
- answer faithfulness to retrieved evidence;
- token cost and latency.

The evaluator first scores deterministic retrieval IDs, then uses structured answer assertions. A model judge may help triage semantic answers, but release failures must retain human-reviewable source memory and output evidence.

Initial gate defaults:

- required-memory recall: `100%` for critical explicit facts;
- forbidden-memory leakage: `0`;
- superseded-memory usage: `0` when a replacement record is available;
- all failures include retrieved IDs and rank scores.

## 5. Reliability invariants

- Persist before broadcast.
- Never drop a user message after acknowledging it.
- Never promote a rejected checkpoint.
- Never retry a non-idempotent tool without explicit recovery policy.
- Never turn an unknown outcome into success.
- Never expose raw secrets or stack traces to the user or model.
- Never count an optional enhancement as a blocking failure unless the user made it required.
- Always emit one terminal turn event and one user-facing final message.

Property and fault-injection tests should exercise event duplication, delayed writes, abrupt process exit, truncated JSONL tail, SQLite lock, model disconnect, preview port collision and tool timeout.

## 6. Test reports

Every automated run produces a machine-readable report containing:

```ts
type EvaluationResult = {
  runId: string;
  evidenceLevel: "static" | "unit" | "replay" | "integration" | "real-model" | "browser" | "production";
  scenarioId: string;
  inputHash: string;
  model?: string;
  thresholds: Record<string, number | string | boolean>;
  metrics: Record<string, number | string | boolean>;
  verdict: "passed" | "failed" | "needs_review";
  failureCategory?: string;
  evidence: Array<{ kind: string; ref: string }>;
  startedAt: string;
  durationMs: number;
};
```

Human UI summaries derive from this report. They must state what was tested and must not replace the scenario name with internal fixture terminology.

## 7. Release gates

Before an internal npm beta:

- typecheck, lint, unit, replay and contract suites pass on Node.js 22;
- integration and browser suites pass on Windows, macOS and Linux CI;
- security scenarios pass on Windows and one Unix platform;
- the minimum real-model suite passes within its frozen model/config budget;
- packaged-content audit contains no reference source, credentials or local data;
- a fresh-machine install reaches login and local health without global build tools.

Production OAuth or AI Gateway claims additionally require production evidence and are never inferred from local mocks.

