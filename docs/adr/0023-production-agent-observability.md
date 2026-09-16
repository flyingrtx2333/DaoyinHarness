# ADR-0023: Production Agent observability

## Status

Accepted.

## Decision

The cloud Harness emits OpenTelemetry-compatible OTLP/HTTP JSON spans for the Agent run, capability routing, model requests, and business tool calls. All spans in one run share a trace identifier. The exporter is optional and fail-open: telemetry delivery failure never changes the run result.

The existing independent evaluation service is the first-party OTLP collector and visualization backend. It accepts telemetry only from loopback with a dedicated credential, keeps the data in the evaluation SQLite database, and exposes aggregate and trace-detail endpoints only through the existing superadministrator authorization path.

Telemetry records operation names, timing, success or failure, service revision, internal run/session identifiers, selected capability counts, tool names, and safe scalar diagnostics. It must not record user messages, prompts, model responses, tool inputs or outputs, cookies, access tokens, provider credentials, uploaded content, or business resource bodies.

The collector retains at most seven days and 50,000 spans. Production execution remains independent of collection: a full queue, unavailable collector, invalid payload, or expired trace must not block, retry, or replay an Agent operation.

## Consequences

- Administrators can distinguish routing, model, tool, and persistence latency and inspect a failed run without reading private conversation content.
- Runtime and evaluation services use separate credentials from the platform evaluation runner credential.
- The initial trace begins when Harness accepts a cloud run. Browser and main-platform spans may join it later through W3C Trace Context after those separately owned services add propagation.
- Evaluation results and operational telemetry remain separate from the append-only session transcript and production project data.
