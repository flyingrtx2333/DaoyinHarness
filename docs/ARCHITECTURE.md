# DaoyinHarness Architecture

> Status: architecture baseline. No runtime described here has been implemented yet.

## 1. Goals and boundaries

DaoyinHarness turns a local Node.js process into the durable execution environment for an AI application builder. The browser is a view and input surface, not the owner of task state. The Daoyin cloud is an account and model control plane, not the executor for ordinary local edits.

v1 optimizes for four outcomes:

1. A simple project reaches a working local preview without a remote job queue.
2. The Agent always sees and continues from real project files.
3. Refresh, process restart, cancellation, and transient network failure do not lose the conversation or last usable result.
4. Every completion or failure is backed by structured evidence instead of UI inference.

Cloud publish, COS synchronization, cross-device state, and IM channels are deliberately deferred.

## 2. Components

```text
CLI
 └─ Local Server
     ├─ Auth Session ─────────────── Daoyin OAuth / AI Gateway
     ├─ Web UI
     ├─ Agent Engine
     │   ├─ Context and Memory
     │   ├─ Model Stream
     │   └─ Tool Dispatcher
     ├─ Workspace Service
     ├─ Checkpoint Service
     ├─ Build and Preview Service
     ├─ Evaluator
     ├─ Transcript Store (JSONL)
     └─ State Index (SQLite)
```

### CLI

The npm executable owns process startup, port selection, data-directory resolution, browser opening, signal handling, and clean shutdown.

Planned interface:

```text
daoyin-harness [--port <number>] [--no-open]
               [--data-dir <path>] [--log-level <level>]
```

Without `--port`, the CLI attempts `4677` through `4699`. With `--port`, occupation is an error; silently moving to a different port would break the OAuth callback and operator expectations.

### Local Server

The Fastify server serves the compiled UI and `/api/v1`, establishes the browser session, serializes project writes, persists events before broadcast, and shuts down running tools on termination. It binds only to loopback.

### Web UI

The React UI renders persisted protocol events. It does not synthesize success from progress percentages and does not own authoritative message state. On reconnect it requests every event after the last acknowledged `eventSeq`.

### Agent Engine

The Agent Engine owns the turn loop:

1. persist the user request;
2. assemble current context and retrieved memory;
3. stream a model response from the Daoyin AI Gateway;
4. validate and dispatch requested tools;
5. persist tool evidence;
6. continue until a terminal assistant response, cancellation, or bounded failure;
7. summarize user-visible results and create a checkpoint only when warranted.

The model never executes a tool directly. A policy layer validates the tool name, arguments, workspace scope, permission and budget.

### Workspace Service

Each project has a fixed canonical root. All file operations resolve both the lexical path and real path beneath that root. Writes use temporary files plus atomic replacement where supported. Mutations for the same project are serialized.

### Build, Preview and Evaluator

Build execution uses named operations and argument arrays, not arbitrary interpolated shell text. The evaluator distinguishes:

- source and configuration checks;
- build-process success;
- preview HTTP health;
- browser runtime and console health;
- optional interaction assertions.

A failed optional capability is reported as follow-up work, not automatically as a blocking failure. Route startup, syntax failure, policy violation, missing required artifact, or an unusable preview is blocking.

Generated pages are served from a separate preview origin and embedded with an explicit iframe sandbox policy.

### Cloud Client

The Cloud Client exchanges the authorization code, refreshes user credentials through an OS credential-store adapter, fetches user identity and streams model responses. It never exposes the model-provider credential to the local server or browser.

## 3. Sources of truth

| Data | Source of truth | Derived/read model |
| --- | --- | --- |
| Project source | Workspace files | File index and search cache |
| Conversation | Append-only JSONL transcript | SQLite message and turn tables |
| Execution state | Persisted events | In-memory scheduler and UI state |
| Last usable result | Immutable checkpoint manifest | Project current-checkpoint pointer |
| Memory | Versioned memory records with provenance | Embedding/keyword indexes |
| Identity | Daoyin authorization server | Local session and account metadata |

SQLite transactions maintain the current queryable view, but recovery must be possible by replaying transcripts and checkpoint manifests. A write is not visible to clients until its corresponding event is durably appended.

## 4. Local data layout

```text
~/.daoyin-harness/
└─ <accountId>/
   ├─ index.sqlite
   ├─ logs/
   ├─ memory/
   │  └─ user-memory.jsonl
   └─ workspaces/
      └─ <projectId>/
         ├─ files/
         ├─ transcripts/<sessionId>.jsonl
         ├─ checkpoints/<checkpointId>/manifest.json
         ├─ artifacts/
         └─ project-memory.jsonl
```

Credential material is stored outside this tree in the operating-system credential manager. IDs are opaque UUIDs; display names never become path components.

## 5. Entity lifecycle

### Project

`creating -> ready -> archived`

Deletion is not part of the initial v1 interface. Archive hides a project without removing files or transcripts.

### Session

`idle -> running -> idle`

A session may enter `recovering` during transcript replay. An unrecoverable transcript integrity error produces `needs_attention`; it is never silently replaced with an empty session.

### Turn

`queued -> running -> completed | failed | cancelled`

Only one mutating turn runs per project. A new user message while a turn runs is classified as:

- cancellation, which aborts future tools;
- correction or additional requirement, which is appended to the current turn inbox and applied at the next model boundary;
- independent request, which remains queued.

The original user message is always persisted and rendered immediately.

### Tool call

`requested -> running -> completed | failed | cancelled`

Progress is optional and monotonic within one tool call. A tool result contains structured evidence for the Agent and a separately sanitized display summary for the UI.

### Checkpoint

`candidate -> usable | rejected`

A candidate becomes usable only after required evaluator checks pass. Updating the project's current pointer is an atomic operation. Rejected candidates remain available for diagnosis but cannot replace the current usable checkpoint.

## 6. Recovery and interruption

### Browser refresh or reconnect

The browser presents its last `eventSeq`; the server replays later events from persistent storage, then switches to live WebSocket delivery. Duplicate delivery is permitted; duplicate application is not.

### Process crash

On startup the server scans turns left in `running`. Completed tool evidence remains immutable. Non-idempotent tools are not retried automatically. The turn becomes `interrupted` internally, a recovery event is appended, and the Agent receives explicit evidence about what finished and what is unknown.

### Cancellation

Cancellation signals the active model stream and child process, prevents new tool dispatch, records the best-known state, and emits `turn.cancelled`. It does not delete the user request, assistant deltas, tool results, or candidate files.

### Context compaction

Compaction creates a derived summary referencing a contiguous event range, important facts, unresolved requirements and checkpoint IDs. The original events remain available for recovery and audit. Recent raw tool payloads are excluded unless required to explain an active failure.

### Failure rollback

Working files may contain a failed attempt, but the preview selector and project current-checkpoint pointer remain on the last usable checkpoint. The UI describes this accurately without repetitive boilerplate.

## 7. Memory model

Memory has three v1 scopes:

1. **Turn context**: active request, recent events, current plan, running tools and failure evidence.
2. **Project memory**: durable requirements, architecture decisions, accepted design choices, open defects and checkpoint lineage.
3. **Account-local memory**: stable preferences and a lightweight index of projects created on the current machine.

Every memory record includes source event IDs, scope, created time, confidence and supersession state. Retrieval combines explicit entity matches, recency and semantic/keyword relevance. Retrieved memory is context, never an instruction that overrides the current user request.

Cross-device memory synchronization is not part of v1. The UI and Agent must not claim knowledge of projects that exist only on another machine.

## 8. Cloud integration

v1 requires two main-platform capabilities:

- OAuth 2.1 Authorization Code + PKCE for local loopback clients.
- A user-token-authenticated streaming AI Gateway that accepts normalized messages and tools and returns normalized model events.

The model gateway performs membership, quota, policy and audit checks. Local tool execution and workspace content remain local except for the minimal model context explicitly sent in a request.

Future snapshot sync uploads immutable, content-addressed artifacts. It cannot turn COS into a mounted or live-edit workspace.

## 9. Planned package boundaries

| Package | Responsibility |
| --- | --- |
| `@daoyin/harness` / `packages/cli` | Published executable and startup lifecycle |
| `packages/server` | Loopback HTTP, WebSocket, browser session |
| `packages/agent-core` | Turns, model loop, interruption, compaction, memory assembly |
| `packages/workspace` | Paths, files, transcript, SQLite, checkpoints |
| `packages/protocol` | Shared API, event and error schemas |
| `packages/tools` | Tool registry, policies and executors |
| `packages/evaluator` | Build, route, browser and evidence checks |
| `packages/ui` | Local React application |

Packages depend inward through explicit interfaces. UI code cannot import workspace or credential implementations, and tools cannot write directly to protocol transports.

