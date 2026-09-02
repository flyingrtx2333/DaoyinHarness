# DaoyinHarness Local Protocol

> Status: contract proposal for v1. No endpoint is implemented yet.

## 1. Transport and versioning

The local server exposes JSON REST endpoints under `/api/v1` and a WebSocket event stream at `/api/v1/events`. The browser uses the same loopback origin as the server.

Breaking changes require a new URL version. Additive fields are allowed within v1; clients must ignore unknown fields. All timestamps are RFC 3339 UTC strings, IDs are opaque strings, and sequence numbers are decimal integers.

## 2. Core resources

```ts
type Project = {
  id: string;
  name: string;
  status: "creating" | "ready" | "archived";
  currentCheckpointId: string | null;
  createdAt: string;
  updatedAt: string;
};

type Session = {
  id: string;
  projectId: string;
  status: "idle" | "running" | "recovering" | "needs_attention";
  lastEventSeq: number;
  createdAt: string;
  updatedAt: string;
};

type Turn = {
  id: string;
  sessionId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  userMessage: string;
  startedAt: string | null;
  finishedAt: string | null;
};

type ToolCall = {
  id: string;
  turnId: string;
  toolName: string;
  status: "requested" | "running" | "completed" | "failed" | "cancelled";
  displayText: string;
  startedAt: string | null;
  finishedAt: string | null;
};

type Checkpoint = {
  id: string;
  projectId: string;
  turnId: string;
  status: "candidate" | "usable" | "rejected";
  manifestHash: string;
  previewUrl: string | null;
  createdAt: string;
};
```

`previewUrl` is a local, short-lived URL and is not proof of a public deployment.

## 3. REST surface

### Process and authentication

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/health` | Process, database and workspace readiness |
| `GET` | `/api/v1/auth/status` | Current local login state and user summary |
| `POST` | `/api/v1/auth/login` | Begin PKCE and return the main-platform authorization URL |
| `POST` | `/api/v1/auth/logout` | Revoke credentials and clear the local browser session |

### Projects and sessions

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/projects` | List non-archived local projects |
| `POST` | `/api/v1/projects` | Create a local project and workspace |
| `GET` | `/api/v1/projects/:projectId` | Read project state |
| `POST` | `/api/v1/projects/:projectId/archive` | Archive without deleting local data |
| `POST` | `/api/v1/projects/:projectId/sessions` | Create or resume a session |
| `GET` | `/api/v1/sessions/:sessionId` | Read session state and last sequence |
| `GET` | `/api/v1/sessions/:sessionId/events?after=<seq>` | Replay persisted events |
| `POST` | `/api/v1/sessions/:sessionId/turns` | Persist a user message and queue a turn |
| `POST` | `/api/v1/turns/:turnId/cancel` | Cancel future work for the turn |
| `POST` | `/api/v1/projects/:projectId/preview` | Start or return the verified local preview |

State-changing requests require the local CSRF token in `X-CSRF-Token`. Project and session ownership are resolved from the authenticated local session, never accepted as account IDs from the browser.

## 4. Event envelope

Every persisted and broadcast event uses one envelope:

```ts
type EventEnvelope<TType extends EventType, TPayload> = {
  id: string;
  eventSeq: number;
  type: TType;
  accountId: string;
  projectId: string;
  sessionId: string;
  turnId: string | null;
  occurredAt: string;
  payload: TPayload;
};
```

`eventSeq` is strictly increasing within a session. The server persists the event before acknowledging or broadcasting it.

Required v1 event types:

| Event | Required payload |
| --- | --- |
| `turn.started` | turn status and accepted user-message ID |
| `assistant.delta` | ordered text delta and content-block ID |
| `tool.started` | tool-call ID, tool name and concise display text |
| `tool.progress` | tool-call ID, optional percent and replacement display text |
| `tool.completed` | tool-call ID, sanitized summary and evidence references |
| `tool.failed` | tool-call ID, stable error code, retryability and evidence references |
| `checkpoint.created` | checkpoint ID, status and evaluator summary |
| `turn.completed` | final assistant-message ID and outcome summary |
| `turn.cancelled` | cancellation source and last completed event sequence |

Internal recovery may add `turn.recovering`, `turn.interrupted`, and `session.needs_attention` as additive event types before v1 is frozen.

## 5. WebSocket replay

The browser connects to:

```text
ws://127.0.0.1:<port>/api/v1/events?sessionId=<id>&after=<eventSeq>
```

The server authenticates the browser session and origin, replays all persisted events after `eventSeq`, emits a `stream.ready` control frame, and then delivers live events. A client reconnect may receive duplicates and must deduplicate by event ID or sequence.

The user message is returned by `POST /turns` only after it is persisted. The UI renders that persisted message immediately, so a failed model call cannot make the user's message disappear.

## 6. Tool result separation

A tool executor produces two representations:

```ts
type ToolEvidence = {
  schemaVersion: 1;
  toolName: string;
  result: unknown;
  artifacts: ArtifactReference[];
  diagnostics: DiagnosticReference[];
};

type ToolDisplay = {
  statusText: string;
  summary: string;
  severity: "info" | "warning" | "critical";
};
```

`ToolEvidence` is persisted for Agent reasoning and diagnostics. `ToolDisplay` is safe for normal UI rendering. Raw JSON, validation traces, credentials, absolute secret paths and stack traces never become assistant messages.

After a terminal tool failure, the Agent must generate a normal final response that states what succeeded, what failed, whether work was preserved, and the next safe action. Only explicit security or policy violations use `critical` presentation.

## 7. Errors

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

Known error families include `AUTH_*`, `WORKSPACE_*`, `TURN_*`, `TOOL_*`, `MODEL_*`, `PREVIEW_*`, and `POLICY_*`. Unknown exceptions map to `INTERNAL_ERROR` in the client response and retain the original stack only in redacted local diagnostics.

## 8. Idempotency and concurrency

- Project creation and turn submission accept `Idempotency-Key`.
- Reusing a key with the same body returns the prior resource; a different body is a conflict.
- A project has at most one mutating turn. Additional turns are queued and visible.
- Cancellation is idempotent.
- Checkpoint promotion uses compare-and-swap against the expected current checkpoint.
- Event persistence and the corresponding SQLite materialized update occur in one logical transaction boundary; recovery reconciles partial storage failures from the transcript.
