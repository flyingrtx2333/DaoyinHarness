# ADR-0013: Incremental cloud replies and stable transcript views

Accepted 2026-09-06. Extends the platform bridge and workbench contracts without replacing append-only events or operation admission.

Sending, cancellation and poll recovery refresh the selected session incrementally from its last persisted event sequence. They must not clear or remount existing messages. Clearing is reserved for session/account changes and loss of authorization. A submitted question is visible immediately while admission is pending. Active polling fetches run metadata and event additions concurrently every 500ms after the previous request completes; transient transport failures retain the view and retry the read after two seconds. This browser transport is incremental HTTP polling, not WebSocket or SSE.

`ModelRequest.onTextDelta` is an optional awaited callback for public assistant content. The platform bridge negotiates bounded NDJSON using `Accept: application/x-ndjson` while retaining JSON compatibility. Provider content chunks are persisted as `assistant.delta` events before replay; tool arguments and reasoning are never streamed to this channel. A final validated reply must match received content; completion waits for platform accounting and operation persistence. Missing completion, size violations, cancellation and revoked access retain the recorded partial evidence and produce a terminal outcome. Tool-call commentary uses its own content block; final replies do not duplicate previously streamed text.

Tool activity is projected from actual start/completion/failure events with fixed user-facing operation names, a spinner while running and elapsed time. It does not expose raw payloads or simulate business progress percentages. Completed/cancelled runs stop activity indicators. Existing message alignment and timestamps are retained as part of the verified conversation layout.

Evidence: unit and protocol fixtures, persisted early-delta tests, browser checks for node identity and nonzero replay cursors at desktop/narrow widths, and platform Docker tests with isolated MySQL. Deployment and real-provider evidence are recorded separately in the release note.
