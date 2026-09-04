# DaoyinHarness Roadmap

> Status: implementation sequence for a general-purpose local Agent Harness. A phase is complete only when its exit criteria are met; website preview is an optional capability, not the definition of v1.

## P0 — Repository and architecture baseline

Deliverables:

- independent Git repository on `main`;
- README, architecture, protocol, auth, security, testing and ADRs;
- local research/reference trees excluded from product source and packages;
- clean-room implementation rule.

Exit criteria:

- terminology consistently describes a general Agent Harness;
- docs do not imply every session is a software project;
- package and Git audits exclude reference/runtime state.

## P1 — Local runtime shell

Deliverables:

- npm workspace and Node.js 22 baseline;
- `@daoyin/harness` / `daoyin-harness` CLI layout;
- loopback Fastify server and React Web UI;
- port scan, explicit port, data directory, workspace and browser-launch options;
- local Host/Origin/CSRF boundary and clean shutdown.

Current state: substantially implemented.

Exit criteria:

- package installs on clean Windows, macOS and Linux Node.js 22 environments;
- runtime starts on loopback with no cloud credential;
- package audit contains no local references, secrets or runtime state.

## P2 — Daoyin identity and model gateway

Deliverables:

- OAuth 2.1 Authorization Code + PKCE for the local client;
- OS credential-store adapters and authenticated local browser session;
- user-token-authenticated Daoyin AI Gateway;
- normalized model request/response/tool-call contract;
- quota, membership and audit integration without exposing provider keys locally.

Current state: the normalized Daoyin AI Gateway `ModelClient` is implemented in `packages/cloud`, including HTTPS/loopback policy, bounded timeout/response handling, strict assistant/tool-call parsing and stable gateway error mapping. A development-only process-memory credential bridge is wired through the CLI so a real gateway can be exercised before OAuth exists. Main-platform OAuth endpoints, credential-store adapters, token refresh/rotation and the production Gateway service are still required.

Exit criteria:

- login, refresh, revocation, replay, redirect, origin and CSRF tests pass;
- tokens never enter URL history, localStorage, transcript or plaintext data stores;
- account switching cannot mix local namespaces;
- one real model can complete a no-tool chat turn and one tool-backed turn.

## P3 — Session trajectory, context and recovery

Deliverables:

- persistent session catalog;
- append-only JSONL trajectory with strictly increasing `eventSeq`;
- user/assistant multi-turn context reconstructed from persisted events;
- bounded context history and append-only derived compaction records;
- cancellation and incremental replay;
- provenance-bound session/resource/account memory with append-only supersession/tombstones;
- crash/interruption semantics and future fork/resume metadata;
- derived SQLite/search indexes that can be rebuilt from facts.

Current state: session catalog, append-only events, incremental REST replay, session-scoped WebSocket live delivery with `eventSeq` reconnect recovery, cancellation, bounded multi-turn dialogue reconstruction, deterministic context compaction and the first scoped JSONL memory store/retriever are implemented. Crash takeover, fork/resume, SQLite materialization and semantic/vector retrieval remain.

Exit criteria:

- a follow-up turn can answer from prior persisted dialogue without the browser resending history;
- acknowledged events survive restart;
- truncated-tail recovery cannot invent or erase completed events;
- cancellation never deletes prior evidence;
- old context can be compacted without deleting the source trajectory.

## P4 — Capability registry and core tool packs

Deliverables:

- model-facing capability registry independent from the Agent loop;
- tool metadata including category and mutating/read-only status;
- workspace pack for safe file list/read/search/write/patch;
- public Web pack for `web_search` and `web_fetch`;
- SSRF, timeout, redirect and response-size policies;
- capability metadata exposed to the UI/runtime bootstrap;
- tool packs mountable without adding Agent-loop branches.

Current state: the capability registry plus Workspace, public Web, local Skills, scoped Memory, controlled Browser and explicit remote Streamable HTTP MCP packs are implemented. Tool execution now receives trusted account/session/resource/turn provenance context, and bootstrap exposes the mounted capability snapshot plus configured MCP server status.

Exit criteria:

- Agent loop tests run unchanged when capabilities are added or removed;
- private-network Web fetches and redirect escapes are rejected;
- workspace path traversal/symlink escape tests pass;
- UI displays actual mounted capabilities rather than a hard-coded product mode;
- tool failure evidence returns to the model and produces one truthful terminal answer.

## P5 — Standard general-Agent capability set

This is the main v1 capability phase. It replaces the previous assumption that “build + preview” defines product completeness.

Deliverables:

- **Process service + permission policy + OS sandbox provider**: cwd, argument arrays, env allowlist, output/time/resource bounds, cancellation, risk classification, exact user decisions and real isolation where available;
- **Skills**: discover, load and inject reusable instructions/workflows with provenance and bounded context;
- **MCP / extension seam**: external capabilities normalize into the same registry contract;
- **Browser capability**: public navigation, page inspection and controlled interaction separated from raw HTTP fetch;
- **Goals / plans / task state**: persistent task artifacts that are data, not hidden chain-of-thought;
- **Workflow execution**: reusable multi-step routines with child execution records;
- capability/settings UI for inspecting what is installed and enabled.

Current state: Process Service, named read-only process inspection, exact one-shot package-script permission grants, permission UI/API, local Skills, the first scoped Memory/Compaction layers, controlled Browser, remote Streamable HTTP MCP, persistent Goals/Task State, sequential Workflow execution, and bounded Child Agents are implemented. Goal/Workflow/Child Run facts are append-only and visible through the task-state panel; Goal revisions can detect stale updates. Workflow steps run as child Agent sessions with explicit parent/child links, and failed/cancelled child work cannot produce a completed parent Workflow Run. Browser auto-discovers system Chrome/Edge/Chromium, mounts only when available, isolates state per Harness session, returns bounded DOM snapshots with element refs, and separates raw Web fetch from navigation/click/type/back operations behind a public-network filtering proxy. `browser_type` uses persisted-audit redaction and rejects password fields. MCP servers are explicitly configured at CLI startup, isolate individual connection failures, normalize `tools/list` into namespaced `extension` tools, conservatively classify mutation unless `readOnlyHint=true`, redact argument values from persisted audit input, and bound/strip binary results. Process execution has explicit cwd/argv/minimal-env/time/output/cancellation policy. Linux now has a Bubblewrap provider with startup probing, namespace isolation and network blocked by default for sandboxed operations; Windows/macOS still report `osIsolation: none`. stdio MCP through the Process boundary, a richer high-impact Browser confirmation policy and full capability settings remain.

Exit criteria:

- one session can naturally move through plain chat → Web research → controlled Browser inspection/interaction → explicit MCP capability use → local file work → controlled process execution;
- high-risk process actions cannot bypass the permission/sandbox policy;
- disabling a Skill/tool pack removes it cleanly without breaking transcript replay;
- browser evidence is distinguishable from model claims;
- a failed child workflow cannot be reported as completed by the parent.

## P6 — Advanced Agent runtime

Deliverables:

- sub-agents with explicit parent/child trajectory links and bounded delegation;
- session fork/resume/search;
- long-context compaction and provenance-aware memory;
- account-local stable preferences, session memory and workspace/resource memory;
- plugin discovery, enable/disable and versioned runtime composition;
- scheduling/background task interfaces where product authorization allows them;
- richer trajectory inspector for context injections, tools and child runs.

Current state: bounded Child Agents with explicit parent session/turn links, separate canonical child trajectories, parent cancellation propagation and non-recursive capability snapshots are implemented. The next advanced-runtime priority is session fork/resume/search; plugin lifecycle, scheduling and richer trajectory inspection remain after that.

Exit criteria:

- child-agent work is auditable and cancellable;
- forks never rewrite source history;
- memory injection exposes provenance and scope;
- plugin removal cannot corrupt existing session logs;
- scheduled work has explicit ownership, limits and cancellation.

## P7 — Task-specific capability packs

These are useful applications of the Harness, not core identity:

- software build/test/evaluation;
- isolated local web preview;
- screenshot/browser fidelity evaluation;
- document/PDF/media processing;
- data-analysis helpers;
- optional publishing/snapshot capabilities.

A coding or website task may mount these packs. A research or document session does not need them.

## v1 release definition

v1 is the local runtime plus P2–P5: authenticated model access, durable multi-turn sessions and a credible **standard general-Agent capability set**. P6 advanced orchestration may continue after v1.

Public npm publication is a separate security/product decision after clean Node.js 22 package tests on Windows, macOS and Linux.

## Later cloud and channels

Potential later capabilities, each requiring its own ADR and threat model:

- encrypted cross-device session/resource sync;
- immutable artifact backup;
- verified publish/preview services;
- 微信、飞书、QQ and other channel identity binding;
- remote execution only with explicit device ownership, authorization and conflict semantics.

Cloud storage must never silently become the authority for a live local workspace.
