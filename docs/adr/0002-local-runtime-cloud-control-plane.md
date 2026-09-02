# ADR-0002: Local execution runtime with a Daoyin cloud control plane

- Status: Accepted
- Date: 2026-09-02

## Context

The existing Builder experience routes interactive work through multiple remote services, queues, databases, workers, storage and verifiers. Failures in those dependencies can delay a simple page, separate the Agent from real files, lose user-visible state, or misclassify a storage failure as a page/model failure.

Users need an installable product that opens a local port, logs into the existing Daoyin account and continues working on durable local files. Daoyin must still control identity, membership, model access, quota, policy and future publishing.

## Decision

Interactive execution belongs to a local DaoyinHarness process. The local runtime owns:

- workspaces and project files;
- sessions, turns and append-only transcripts;
- tool execution, cancellation and recovery;
- local builds, evaluator evidence, checkpoints and previews;
- v1 memory on the current machine.

The Daoyin cloud owns:

- OAuth identity, consent, scopes and device revocation;
- membership, quota and policy;
- the model gateway and provider credentials;
- audit identifiers;
- future immutable synchronization, public publish and IM services.

The browser is a client of the local runtime. It does not call model providers or own authoritative conversation state.

## Data authority

Local workspace files are the v1 source of truth for editable projects. JSONL transcript is the source of truth for conversation events. SQLite is a rebuildable local read model. COS may later store immutable snapshots and artifacts, but it is never the live workspace.

Cloud outage may prevent new model responses, but it must not prevent opening local projects, reading history, previewing an existing usable checkpoint or exporting diagnostics.

## Authentication

The local runtime is an OAuth 2.1 public client using Authorization Code + PKCE and an exact loopback callback. Cloud tokens remain in the local server/OS credential store and are not exposed to the browser. The current long-lived platform JWT/localStorage pattern is not reused.

## Consequences

Benefits:

- low-latency access to real files and previews;
- fewer distributed failure modes in the interactive path;
- durable recovery independent of a remote queue;
- cloud secrets and business controls remain centralized;
- future cloud features can be added without changing local data authority.

Costs:

- the package must support three desktop operating systems;
- local process, dependency and preview security become first-class responsibilities;
- main-platform OAuth and user-facing model gateway work is required;
- v1 data does not automatically follow the user to another machine.

## Rejected alternatives

### Thin local UI over the existing cloud Builder

Rejected because it preserves the same remote queues, storage dependencies and split state that motivated the redesign.

### Fully local model credentials

Rejected because it exposes provider keys, bypasses Daoyin membership/policy and complicates model configuration for users.

### Cloud/COS as the active filesystem

Rejected because object storage does not provide the atomic, low-latency, process-compatible semantics required by local builds and Agent edits.
