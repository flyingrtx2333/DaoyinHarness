# DaoyinHarness Local Protocol

This is the **local adapter** protocol. Cloud sessions/runs/events use `/api/v1/cloud/*`, documented in [server-cloud](../packages/server-cloud/README.md). The main platform's browser-facing `/api/company-assistant/agent/*` proxy and service-only `/api/internal/agent-public/v1/*` adapters are documented in [UNIFIED-AGENT.md](UNIFIED-AGENT.md). Cloud request idempotency is implemented independently of local turn submission. `ExecutionIdentity.expiresAt` is epoch milliseconds; event timestamps remain RFC 3339.

> Status: local bootstrap/workspace/session/turn REST, OAuth integration, capability metadata, shared events, Skills, scoped Memory, Context Compaction, Process permissions, WebSocket replay, controlled Browser/MCP and local orchestration are implemented. Windows/macOS Sandbox providers, interactive capability management, stdio MCP and local submission idempotency remain staged. Cloud Run idempotency is implemented in the separate cloud protocol.

## 1. Transport and versioning

The local server exposes JSON REST endpoints under `/api/v1` and one session-scoped WebSocket event stream at `/api/v1/sessions/:sessionId/events/ws`. The browser uses the same loopback origin as the server.

Breaking changes require a new URL version. Additive fields are allowed within v1; clients must ignore unknown fields. All timestamps are RFC 3339 UTC strings, IDs are opaque strings, and sequence numbers are decimal integers.

## 2. Core resources

A session is the primary conversational resource. It does not require a software project identity.

```ts
type Session = {
  id: string;
  title: string;
  status: "idle" | "running" | "recovering" | "needs_attention";
  lastEventSeq: number;
  activeTurnId: string | null;
  forkedFrom?: { sourceSessionId: string; sourceEventSeq: number };
  createdAt: string;
  updatedAt: string;
};

type Turn = {
  id: string;
  sessionId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
  userMessage: string;
  startedAt: string | null;
  finishedAt: string | null;
};

type ToolCapability = {
  name: string;
  description: string;
  category: "workspace" | "web" | "browser" | "process" | "system" | "extension";
  mutating: boolean;
};

type WorkspaceSummary = {
  name: string;
  root: string;
  fileCount: number;
};

type McpServerSummary = {
  id: string;
  endpoint: string;
  status: "connected" | "failed";
  serverName: string | null;
  serverVersion: string | null;
  toolCount: number;
  errorCode?: string;
  message?: string;
};
```

Task-specific resources such as build checkpoints, previews, documents, workflows or browser artifacts are capability-owned extensions. They are not mandatory fields on every session.

## 3. REST surface

### Implemented local MVP surface

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/health` | Process, catalog and workspace readiness |
| `GET` | `/api/v1/bootstrap` | Issue the local HttpOnly session cookie and return CSRF token, workspace summary, recent sessions, mounted capability metadata and configured MCP server status |
| `GET` | `/api/v1/workspace/files` | List files from the selected, policy-checked workspace |
| `GET` | `/api/v1/orchestration?sessionId=<id>` | Read scoped Goal, Workflow, Workflow Run and Child Agent Run snapshots |
| `GET` | `/api/v1/process/permissions?sessionId=<id>` | List append-only Process Permission state visible to the current local account/resource/session |
| `POST` | `/api/v1/process/permissions/:requestId/decision` | Approve once or deny the exact pending Process Permission request; requires cookie + CSRF |
| `GET` | `/api/v1/sessions` | List local sessions |
| `POST` | `/api/v1/sessions` | Create a local session |
| `GET` | `/api/v1/sessions/search?q=<query>&limit=<n>` | Search persisted session titles, dialogue and tool evidence |
| `POST` | `/api/v1/sessions/:sessionId/forks` | Create an empty branch referencing a safe immutable terminal event boundary |
| `POST` | `/api/v1/sessions/:sessionId/resume` | Reconcile a crash-stale `activeTurnId` by appending `turn.interrupted`; rejects a turn still running in this process |
| `GET` | `/api/v1/sessions/:sessionId/events?after=<seq>` | Replay persisted events after a sequence number |
| `WS` | `/api/v1/sessions/:sessionId/events/ws?after=<seq>` | Replay the persisted gap and then push live session events |
| `POST` | `/api/v1/sessions/:sessionId/turns` | Start one Agent turn for the session |
| `POST` | `/api/v1/sessions/:sessionId/turns/:turnId/cancel` | Abort future model/tool work for the active turn |

The bootstrap response sets `daoyin_harness_session` as an HttpOnly `SameSite=Strict` cookie. State-changing requests currently require that cookie plus the in-memory bootstrap token in `X-Daoyin-CSRF`. The browser never supplies `accountId` or an arbitrary workspace path to turn endpoints.

### Planned v1 surface

Authentication (`/auth/*`), runtime capability enable/disable, interactive MCP/Browser management, Windows/macOS Sandbox management and idempotency keys are still contract targets rather than implemented endpoints. Remote Streamable HTTP MCP itself is already mounted from explicit CLI startup configuration, Goal/Workflow/Child Agent orchestration is already model-facing plus read-visible through `/api/v1/orchestration`, and the first session fork/resume/search recovery surface is implemented. Remaining recovery work is richer derived indexing/inspection rather than a second trajectory authority. Task-specific preview/checkpoint APIs belong to optional capability packs rather than the core session protocol.

## 4. Event envelope

Every persisted and broadcast event uses one envelope:

```ts
type EventEnvelope<TType extends EventType, TPayload> = {
  id: string;
  eventSeq: number;
  type: TType;
  accountId: string;
  scopeId: string;
  sessionId: string;
  turnId: string | null;
  occurredAt: string;
  payload: TPayload;
};
```

`eventSeq` is strictly increasing within a session. The server persists the event before acknowledging or broadcasting it. `scopeId` is a runtime/resource namespace for authorization and recovery; it must not be interpreted as a mandatory software-project ID.

Implemented core event types:

| Event | Required payload |
| --- | --- |
| `turn.started` | running status, accepted user-message ID and visible user text |
| `assistant.delta` | ordered assistant text delta and content-block ID |
| `tool.started` | tool-call ID, tool name, concise display text and bounded JSON input when serializable |
| `tool.completed` | tool-call ID, sanitized summary and structured evidence |
| `tool.failed` | tool-call ID, stable error code, message, retryability and optional bounded structured `details` (for example a Process Permission request) |
| `turn.completed` | final assistant-message ID and outcome summary |
| `turn.failed` | stable failure code and terminal outcome summary |
| `turn.cancelled` | cancellation source and last completed event sequence |
| `turn.interrupted` | `runtime_restart` / `runtime_recovery` reason and the last persisted event sequence before interruption |

Planned additive events include richer tool progress and any future capability-owned recovery signals. Session forks are represented as immutable catalog ancestry metadata rather than copied transcript events, while parent/child Agent execution remains represented by explicit orchestration records. Context compaction is a separate derived store keyed to event ranges rather than a canonical Agent event. Task-specific capability packs may define namespaced artifact/checkpoint events without making them core Agent events.

## 5. WebSocket replay

The browser connects to:

```text
ws://127.0.0.1:<port>/api/v1/sessions/<sessionId>/events/ws?after=<eventSeq>
```

The WebSocket handshake is subject to the same loopback Host/Origin policy as REST and also requires the local HttpOnly browser-session cookie. The server registers the live subscriber before reading the persisted replay gap, buffers any events produced during that replay window, sends all persisted events after `eventSeq`, drains the buffered live events in sequence order, and then enters live mode. A `ready` control message carries the current session summary and last delivered sequence.

Persist-before-broadcast remains authoritative: the Agent event is appended to the JSONL transcript before the catalog is updated and before a live event is published. If the socket disconnects at any point, the client reconnects using its latest `eventSeq`; both server and UI deduplicate by sequence/event ID. The REST replay endpoint remains the canonical fallback and recovery surface.

The user message is returned by `POST /turns` only after it is persisted. The UI renders that persisted message immediately, so a failed model call cannot make the user's message disappear.

## 6. Tool result separation

A tool executor produces two representations:

```ts
type ToolEvidence = {
  schemaVersion: 1;
  toolName: string;
  result: unknown;
  artifacts: string[];
  diagnostics: string[];
};

type ToolDisplay = {
  statusText: string;
  summary: string;
  severity: "info" | "warning" | "critical";
};
```

`ToolEvidence` is persisted for Agent reasoning and diagnostics. `ToolDisplay` is safe for normal UI rendering. Raw JSON, validation traces, credentials, absolute secret paths and stack traces never become assistant messages.

After a terminal tool failure, the Agent must generate a normal final response that states what succeeded, what failed, whether work was preserved, and the next safe action. Only explicit security or policy violations use `critical` presentation.

## 7. Memory and compaction state

Memory is a derived local state store, not part of the canonical conversation transcript. Each `MemoryRecord` is append-only and includes an authenticated account namespace, one of the `session | resource | account` scopes, a memory kind, bounded content/keywords, confidence, source event IDs, creation time and optional `supersedes` pointer. Corrections append a replacement record. Forgetting appends a tombstone. Superseded and tombstoned records remain auditable but are excluded from normal retrieval.

Model-facing memory tools never accept `accountId`, `sessionId` or resource scope IDs from model arguments. The runtime injects these through trusted tool execution context. A new memory also requires source-event provenance from the current persisted turn/tool trajectory. The current built-in retrieval ranks only authorized active memories with bounded lexical/CJK token relevance, scope, confidence and recency; semantic/vector indexes may be added later as replaceable derived retrieval layers.

Context compaction is also derived state and is stored separately from the transcript. A `SessionCompaction` contains `sessionId`, `sourceStartSeq`, `sourceEndSeq`, summary, strategy and creation time. Covered events are not deleted, rewritten or renumbered. Model context uses the compacted summary for covered older events and raw dialogue/tool evidence only after `sourceEndSeq`, so replay/audit semantics remain unchanged.

There is no public browser Memory/Compaction REST mutation surface in the current slice. Memory mutation happens through the model-facing capability registry; compaction is internal context maintenance. Future management APIs must preserve the same authorization, provenance and append-only invariants.

## 8. Process permission state

The model-facing Process capability does not accept arbitrary shell text. Read-only named inspections can run automatically when their policy plan is classified `inspect`. Workspace-controlled package scripts require an exact one-shot permission. The command plan fingerprint covers operation, executable, argument array, relative cwd and risk classification; account/resource/session scope is added by the permission store.

A package-script attempt without an approved fingerprint returns a normal `tool.failed` event with code `PROCESS_APPROVAL_REQUIRED`, `retryable=true`, and structured `details` containing the permission request ID, display command, risk, reason, status and fingerprint. The browser may decide that request only through the current loopback account/resource namespace. Approving does not execute anything by itself; a later Agent turn must request the exact same operation, which atomically consumes the approved grant before the Process Service starts it. A consumed grant cannot be reused. A denied request remains denied until the user explicitly changes the decision.

Permission history is append-only in the local process state store. Model-facing arguments never contain `accountId`, `resourceScopeId`, `sessionId` or permission status. On Linux, process success evidence reports `osIsolation: "bubblewrap"` only when the Bubblewrap startup probe passed and that operation actually requested sandboxing; unavailable/non-Linux providers report `osIsolation: "none"`. Permission-only execution must never be presented as sandboxed.

## 9. MCP extension state

Remote MCP servers are process-startup configuration rather than session-owned resources in the current slice. The CLI accepts repeated `--mcp <id>=<url>` entries plus optional `--mcp-bearer-env <id>=<environment-variable-name>`. The actual Bearer Token is resolved from process memory at startup; it is not part of the CLI value, bootstrap response, tool schema or transcript.

The runtime supports Streamable HTTP transport. Remote endpoints require HTTPS; explicitly configured loopback endpoints may use HTTP for local development. Endpoint URLs reject embedded credentials and query parameters, and the transport does not follow HTTP redirects automatically. Each successfully connected server is listed in `RuntimeBootstrap.mcpServers` with its public endpoint, server metadata and tool count. A failed server is also listed with a bounded public error, but contributes no tools. `health.capabilities.mcp` is `ready` when the MCP subsystem initialized with no configured servers or at least one configured server connected; it is `unavailable` when servers were configured and none connected.

MCP `tools/list` entries are normalized into ordinary `extension` ToolRegistry definitions. Harness tool names include the configured server ID, a sanitized external tool name and a stable short hash to avoid collisions. Only an explicit MCP `readOnlyHint=true` is treated as read-only; other tools are conservatively marked mutating. Persisted `tool.started` input for MCP records only argument key names/count, not argument values. MCP text/structured results are bounded before entering evidence; image/audio binary payloads are represented only by metadata and encoded length. External tool metadata and results are untrusted data and cannot grant permission or override runtime policy.

stdio MCP remains planned because it starts local processes. Its transport must delegate process creation to the existing Process Permission/Sandbox boundary rather than introducing a parallel executable path.

## 10. Goals, workflows and child-Agent state

The orchestration subsystem stores Goal revisions, Workflow definitions, Workflow Run snapshots and Child Agent Run snapshots in `orchestration/state.jsonl`. Goal records are session-scoped while reusable Workflow definitions are resource-scoped. Goal updates append a new revision and may include `expectedRevision`; stale updates fail with `GOAL_REVISION_CONFLICT` rather than silently overwriting newer visible task state.

Child Agent delegation creates a new opaque child session and turn in the canonical Agent event store, plus a `ChildAgentRun` linking that child identity back to the parent session/turn. Child runs share the parent cancellation signal and have bounded Agent/tool budgets. The child capability snapshot excludes orchestration tools, `run_package_script`, and persistent Memory mutations. A Child Run is therefore auditable without recursive delegation, hidden package-script approval requests or invisible long-lived memory writes.

A Workflow Run executes definition steps sequentially through Child Agents and persists running/terminal snapshots. If one child fails or is cancelled, the remaining steps do not run, the Workflow Run becomes `failed`/`cancelled`, and an optional linked Goal becomes `blocked`/`cancelled`. Only an all-success run can become `completed` and complete its linked Goal. `/api/v1/orchestration` exposes the current scoped read model to the local UI; model-facing mutation still occurs through the capability registry.

## 11. Errors

REST errors use a stable envelope:

```json
{
  "error": {
    "code": "PORT_IN_USE",
    "message": "指定端口 4677 已被占用。",
    "retryable": false,
    "requestId": "req_...",
    "details": {}
  }
}
```

Known error families include `AUTH_*`, `WORKSPACE_*`, `WEB_*`, `BROWSER_*`, `SKILL_*`, `MEMORY_*`, `COMPACTION_*`, `PROCESS_*`, `MCP_*`, `GOAL_*`, `WORKFLOW_*`, `CHILD_AGENT_*`, `ORCHESTRATION_*`, `TURN_*`, `TOOL_*`, `MODEL_*`, `EXTENSION_*`, and `POLICY_*`. Task-specific capability packs may define their own stable families. Unknown exceptions map to `INTERNAL_ERROR` in the client response and retain the original stack only in redacted local diagnostics.

## 12. Idempotency and concurrency

- Turn submission and future state-creating operations should accept `Idempotency-Key`; this is not yet implemented in the current local slice.
- Reusing a key with the same canonical request body returns the prior resource; the same key with a different body is a conflict.
- The current runtime allows at most one active turn per session. Future child agents/workflows use separate execution identities rather than pretending to be parallel turns in the same slot.
- Capability implementations own finer-grained mutation serialization for protected resources such as a workspace, document or browser session.
- Cancellation is idempotent and never deletes prior events.
- Derived SQLite/materialized state must reconcile from append-only trajectory facts after partial persistence failures.
- Capability-specific atomic pointers, such as a verified preview/checkpoint, use compare-and-swap or an equivalent explicit expected-version guard when introduced.
