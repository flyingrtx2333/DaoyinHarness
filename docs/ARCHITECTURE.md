# DaoyinHarness Architecture

> Status: general-agent architecture baseline. The local process, REST/UI slice, append-only session transcript, multi-turn Agent loop, per-step System Prompt assembly, workspace/Web capability packs and first local Skills catalog/loader are implemented. OAuth/AI Gateway, SQLite indexes, durable memory storage, sandboxed process execution, Browser, workflows, sub-agents, MCP and plugin discovery remain staged work.

## 1. Product boundary

DaoyinHarness is a **general-purpose local Agent Harness**. It is not a website builder and it is not defined by software projects. A coding repository may be the current workspace, but the same session model must also support research, document work, local file operations, analysis, browser tasks, workflows and other tool-backed work.

The browser is a view and input surface, not the owner of Agent state. The Daoyin cloud is the account/model control plane, not the executor for ordinary local tools.

The architecture optimizes for five outcomes:

1. One persistent conversation can move between plain chat, research, local files and engineering tasks without switching products.
2. Every model-visible capability is registered through an explicit capability seam instead of being hard-coded into the Agent loop.
3. Refresh, reconnect, cancellation and process restart preserve the append-only trajectory and completed tool evidence.
4. The Agent can continue from prior turns using persisted session history rather than browser-provided chat text.
5. Successful actions, failures and external facts are backed by tool evidence instead of UI inference.

Cloud publish, cross-device state and IM channels are not required for the local v1 loop.

## 2. Runtime shape

```text
CLI / Local Server / Web UI
            │
            ├── Local browser session + CSRF
            ├── Session Catalog
            ├── Append-only Trajectory (JSONL)
            ├── Agent Engine
            │    ├── Context Assembler
            │    ├── System Prompt Registry
            │    │    ├── cached stable sections
            │    │    └── per-step dynamic sections
            │    ├── Model client seam
            │    ├── Bounded tool loop
            │    └── Cancellation
            └── Capability Registry
                 ├── Workspace pack
                 │    ├── list/read/search
                 │    ├── write/patch
                 │    └── allowlisted package operations
                 ├── Web pack
                 │    ├── web_search
                 │    └── web_fetch
                 ├── Skills pack
                 │    ├── catalog injection
                 │    ├── list_skills
                 │    └── load_skill
                 ├── Process / Sandbox        [planned]
                 ├── MCP / Plugins            [planned]
                 ├── Browser / Computer Use   [planned]
                 ├── Workflow / Goals         [planned]
                 └── Sub-agents               [planned]

Daoyin cloud control plane
            ├── OAuth / account / membership
            ├── authenticated AI Gateway
            └── usage / model policy / audit
```

The Agent Engine depends on model, event-store and tool-registry interfaces. It must not know whether a tool came from the built-in workspace pack, Web pack, a Skill, MCP server or future plugin.

## 3. Core components

### CLI

The npm executable owns process startup, loopback port selection, data-directory resolution, workspace selection, browser opening, signals and shutdown.

```text
daoyin-harness [--port <number>] [--no-open]
               [--data-dir <path>] [--workspace <path>]
               [--log-level <level>]
```

Without `--port`, the CLI scans `4677` through `4699`. An explicit occupied port fails instead of silently moving.

### Local Server

Fastify serves the compiled UI and `/api/v1`, owns the local browser session, protects state changes with an HttpOnly SameSite cookie plus CSRF token, exposes persisted session/event APIs and dispatches Agent turns.

The server is composition glue. Capability-specific business logic belongs in capability packages, not route handlers.

### Web UI

The React UI renders persisted protocol events and capability metadata. It is intentionally task-neutral: a conversation is not automatically a project and tool cards are driven by event data.

The current implementation recovers via `eventSeq` polling. WebSocket delivery may replace polling later without changing transcript semantics.

### Agent Engine

The Agent Engine owns the bounded loop:

1. read prior persisted session events;
2. reconstruct bounded recent user/assistant context;
3. add the current turn-specific instruction without rewriting the user message;
4. persist `turn.started`;
5. call the configured model with current capability descriptors;
6. validate and dispatch tool calls through the registry;
7. persist tool success/failure evidence before continuing;
8. stop on a terminal assistant response, cancellation or bounded failure.

The workspace is a context source, not a mandatory semantic category. The default prompt explicitly forbids assuming that every request is coding or website work.

### System Prompt Registry and Context Assembler

The core prompt is no longer one hard-coded string. `SystemPromptRegistry` resolves named sections in priority order and returns separate stable and dynamic text blocks.

- **Stable sections** currently cover identity, general scope, tool behavior, safety/evidence and truthful completion. They are cached after first resolution and reused until the registry changes.
- **Dynamic sections** are rebuilt before **every model step**, not merely once at turn start. Core dynamic sections include mounted capabilities, persisted recent tool evidence and turn-specific instructions.
- The local Server composition root adds runtime time/OS metadata, selected workspace context, bounded workspace guidance from `.daoyin/AGENT.md` / `AGENTS.md`, an automatically discovered Skill catalog, and an optional provenance-bound memory provider seam.
- Tool schemas are snapshotted from the current `ToolRegistry` for the same model step. A capability added or removed between steps can therefore change both the schema and dynamic capability section without changing the Agent loop.

`ContextAssembler` is responsible for bounded historical dialogue plus per-step System Prompt assembly. Recent user/assistant turns are reconstructed from the append-only transcript. Historical tool execution is not inferred from assistant prose: `tool.started` now persists bounded JSON input, and completed/failed evidence is projected into the `recent_tool_evidence` dynamic section. Older transcripts without tool inputs remain readable and simply expose `null` input for that evidence.

Skill discovery follows progressive disclosure. The dynamic Skill catalog injects only `name + description`; the complete `SKILL.md` body enters model context only after an explicit `load_skill` tool call. This keeps normal turns smaller and prevents all installed skill instructions from competing in every prompt.

A future model adapter may map `stableText` and `dynamicText` to provider-specific prompt-cache blocks. The Agent core deliberately preserves that boundary now rather than flattening away the distinction.

### Capability Registry

Each model-facing tool declares:

- stable `name`;
- description and JSON input schema;
- capability category (`workspace`, `web`, `process`, `system`, `extension`);
- whether the operation is mutating;
- one policy-checked executor.

Tools can be registered individually or as a named tool pack. The registry is the first composition layer; future Skills/MCP/plugins should resolve into the same model-facing tool contract rather than creating parallel Agent loops.

### Workspace capability

The selected local root is safety-scoped. File paths are workspace-relative, lexical and real-path escapes are rejected, symlinks are not followed for unsafe writes, and writes use temporary files plus atomic replacement where supported.

The workspace pack is useful for code, notes, documents and arbitrary text-based local work. It no longer owns process execution; process capabilities are mounted through the independent Process Service described below.

### Web capability

`web_search` and `web_fetch` are read-only model-facing tools behind one Web capability pack.

Public fetch policy currently:

- only HTTP/HTTPS;
- only ports 80/443;
- URL credentials rejected;
- localhost and `.local` rejected;
- DNS results checked before requests;
- private, loopback, link-local, carrier-grade NAT and other non-public address ranges rejected;
- every redirect target is revalidated;
- response body and timeout are bounded;
- only textual response types are returned to the model.

Fetched/search content is untrusted data and cannot override system or policy instructions.

### Memory and compaction

Local memory is implemented as append-only JSONL records with explicit `session`, `resource`, or `account` scope. Each record carries `kind`, bounded keywords, confidence, source event IDs, creation time and optional `supersedes`. Updating a memory appends a replacement record; forgetting appends a tombstone. Old records remain auditable but stop participating in normal retrieval. The current built-in retriever uses bounded lexical/CJK token overlap, scope priority, confidence and recency; semantic/vector retrieval can replace or augment this derived index later without changing the record format.

The model-facing memory pack exposes `memory_search`, `memory_remember`, `memory_update` and `memory_forget`. Account/session/resource IDs are injected by trusted Tool execution context rather than accepted from model arguments. `resource` scope uses a stable hash of the canonical workspace root, preventing memory bleed across different selected workspaces without exposing the path as an identifier.

Context compaction is a separate derived store. When older completed turns exceed configured turn/character thresholds, `ContextCompactor` writes a `SessionCompaction` covering an explicit `sourceStartSeq..sourceEndSeq` range. The first implementation uses a deterministic trajectory projection so it never requires an extra model call or hidden reasoning. Covered raw dialogue and tool events remain in the canonical transcript; only model context changes. The prompt receives the compacted summary plus raw recent dialogue/tool evidence after the covered range, avoiding duplicate context.

### Process, permission and future sandbox capability

Process execution is now separated from the Workspace pack in `@daoyin/harness-process`. The model never receives a generic shell-string tool. `ProcessService` accepts only an executable plus argument array, resolves `cwd` beneath the selected canonical workspace root, uses a minimal inherited environment, disables interactive Git credential prompts, bounds runtime/output, supports cancellation, and reports structured execution evidence.

The first policy registry exposes named operations rather than arbitrary commands. `process_inspect` currently permits bounded read-only `node_version`, `git_status`, `git_diff_check`, `git_diff_stat` and `git_log_recent`. Git inspection disables fsmonitor, external diff and textconv helpers where applicable and sets the selected workspace as `GIT_CEILING_DIRECTORIES`, preventing an apparently read-only inspection from discovering a parent repository or launching repository-configured helpers.

Workspace-controlled executable code is treated differently. `run_package_script` requires both a runtime allowlist match and a declaration in the target workspace `package.json`. The exact executable/arguments/cwd/risk plan is hashed into a command fingerprint. Without a matching approved grant, the tool emits `PROCESS_APPROVAL_REQUIRED` with a structured permission request. The local UI shows the exact display command and reason; the user can allow once or deny through a CSRF-protected endpoint. Approval alone never starts background execution. A later turn consumes the exact grant once, and changing script/cwd/fingerprint requires a new decision. Permission history is append-only in `process/permissions.jsonl` and scoped to account + resource + session.

This is **not yet an OS sandbox**. Current successful process evidence explicitly reports `osIsolation: "none"`; the stable System Prompt forbids describing permission-only execution as isolated. A future Bubblewrap/Seatbelt/Windows isolation provider should sit beneath the same Process Service contract so tool names, permissions and transcript evidence do not need to change. Persistent interactive process sessions are also deferred until lifecycle, resource and cancellation semantics are auditable.

### Skills, MCP and plugins

Skills provide reusable instructions/workflows; MCP and plugins provide capabilities. They should be discoverable and mountable per runtime/session without requiring Agent Engine changes.

The long-term invariant is **capabilities are composable, the loop stays small**.

## 4. Sources of truth

| Data | Source of truth | Derived/read model |
| --- | --- | --- |
| Conversation and tool trajectory | Append-only JSONL transcript | UI turns, summaries, future SQLite indexes |
| Session list/active turn | Local session catalog | UI sidebar |
| Local files | Selected workspace | File list/search results |
| Execution state | Persisted events | In-memory cancellation map and UI state |
| Capability availability | Runtime capability registry | Bootstrap capability list |
| Identity | Daoyin authorization server | Local browser/account session |
| Memory | Versioned records with provenance | Retrieval indexes and summaries |
| Process permission decisions | Append-only permission snapshots keyed by exact fingerprint | UI pending/approved/denied/consumed state |

An event is persisted before it becomes authoritative UI state. Derived stores must be rebuildable from facts where practical.

## 5. Session and trajectory model

### Session

A session is a conversation identity, not a project identity. It may contain ordinary chat, research, tool work or engineering changes in any order.

`idle -> running -> idle`

A session has at most one active turn in the current local implementation.

### Turn

`queued -> running -> completed | failed | cancelled`

The user message is persisted in `turn.started`. Turn-specific controls such as “careful planning” are separate instructions and must not be prepended to or rewrite the visible user message.

### Tool call

`requested/running -> completed | failed | cancelled`

Tool results contain structured evidence for model reasoning and a bounded display summary for the UI. Raw failures do not become fake assistant prose.

### Multi-turn context

Before a new model call, the Agent reconstructs recent dialogue from the persisted transcript with bounded turn and character budgets. Current-user text outranks historical context. Later compaction may replace older raw turns in the model context with derived summaries, but never deletes the underlying trajectory.

### Fork and resume

Forking is planned as a new session identity whose context references a source event boundary. It must not duplicate or rewrite the source trajectory.

## 6. Recovery and interruption

### Browser refresh / reconnect

The client requests events after its last `eventSeq`. Duplicate transport delivery is acceptable; duplicate application is not.

### Process crash

Completed events remain immutable. Unknown non-idempotent side effects must not be automatically replayed. A future recovery service will mark interrupted turns and expose the last known evidence.

### Cancellation

Cancellation aborts the active model/tool signal and prevents future tool dispatch. It records `turn.cancelled` and never erases already persisted events or file effects.

### Context compaction

Compaction is implemented as a separate append-only derived store. The current deterministic strategy summarizes completed older turns and tool outcomes into an explicit source event range while retaining a configurable number of recent raw turns. `ContextAssembler` excludes covered raw dialogue/tool evidence from the model request and injects the derived `session_compaction` section instead. The canonical JSONL transcript is never rewritten or shortened. A later semantic summarizer may improve the summary contents, but it must preserve the same source-range/provenance contract.

## 7. Memory model

General-agent memory is not synonymous with “project memory”. The implemented persistent scopes are:

1. **Session memory** — durable goals, decisions, facts or preferences that should apply only to the current conversation.
2. **Resource memory** — durable facts tied to the selected workspace/resource; the scope ID is derived from a hash of the canonical root rather than supplied by the model.
3. **Account-local memory** — stable preferences/facts suitable for reuse across local sessions for the authenticated account namespace.

Turn context remains transient and comes from the canonical trajectory. Future knowledge/attachment memory can reuse the same provenance contract when those resource types exist.

Each stored memory has a stable ID, kind, content, bounded keywords, confidence, source event IDs, scope and creation time. Retrieval is authorized before scoring. Corrections append a new record that `supersedes` the prior record; forgetting appends a tombstone. A superseded branch cannot be updated again, preventing contradictory active forks. Original messages and tool evidence remain the factual layer; memory is derived, replaceable and auditable.

## 8. Security boundaries

- local HTTP binds only to loopback;
- Host/Origin checks reject cross-origin access;
- state changes require local session cookie + CSRF token;
- workspace paths are scoped and escape-checked;
- public Web tools reject private-network destinations and validate redirects;
- external content is data, never policy;
- model-provider secrets are never sent to the browser;
- no arbitrary shell-string tool exists; named read-only process operations are policy-checked and workspace-controlled executable code requires an exact one-shot permission. Linux uses the Bubblewrap provider when its startup probe passes; Windows/macOS currently report `osIsolation: none` rather than pretending to be sandboxed.

## 9. Cloud integration

v1 cloud dependencies are intentionally narrow:

- OAuth 2.1 Authorization Code + PKCE for local loopback clients;
- a user-token-authenticated AI Gateway accepting normalized messages/tools and returning normalized model events.

The gateway handles membership, quota, model policy and audit. Local capabilities remain local except for bounded context explicitly sent to the model.

## 10. Package boundaries

| Package | Responsibility |
| --- | --- |
| `@daoyin/harness` / `packages/cli` | Published executable and local startup lifecycle |
| `packages/server` | Loopback HTTP, browser session and composition root |
| `packages/agent-core` | General turn loop, context, cancellation and compaction |
| `packages/cloud` | Daoyin AI Gateway model adapter and cloud credential-provider boundary |
| `packages/process` | Confined process execution, named-operation policy and append-only permission grants |
| `packages/workspace` | Safe local files, session transcript and local state primitives |
| `packages/protocol` | Shared API/event/capability/error contracts |
| `packages/tools` | Capability registry and built-in tool packs |
| `packages/evaluator` | Optional task-specific evidence/evaluation adapters |
| `packages/ui` | Task-neutral local React application |

Likely future packages include `skills`, `sandbox`, `browser`, `mcp`, `workflow`, `memory` and `plugins`. They should depend on explicit runtime interfaces rather than importing the UI or server routing layer.
