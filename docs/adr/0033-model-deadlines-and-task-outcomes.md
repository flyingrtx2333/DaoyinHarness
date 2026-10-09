# ADR-0033: Model deadlines, cancellation and reported task outcomes

- Date: 2026-10-09
- Status: Implementation and real-model acceptance reported separately.

## Evidence

Two actual cloud runs at `3483765` exposed different boundaries. One read five
documents and ended while four shared calls remained. The other was aborted by
the Engine at 90 seconds, but the gateway recorded its model failure about one
minute later. The gateway's daemon worker had no cancellation path into provider
I/O. Its original provider exception was wrapped as `MODEL_OUTCOME_UNCERTAIN`.
The sequential twelve-document case intentionally exceeded its available budget;
its partial result is not proof that all long tasks fail.

## Decision

Keep the five-minute cloud turn and twelve-call shared allowance. Cloud parent
and child Engines use a 150-second per-model deadline, outside the gateway's
140-second total deadline and inside the adapter's 160-second transport limit.
The gateway bounds the first provider chunk to 90 seconds and gaps between
provider chunks to 45 seconds. Provider reasoning counts only as transport
progress; its content is never exposed or recorded. NDJSON heartbeats do not
reset these deadlines. Local runtime defaults are unchanged.

Only Harness model streaming uses a per-request asynchronous provider client.
It retains the selected account provider configuration and disables retries.
Disconnect cancels that request's asynchronous I/O and closes its client/stream.
This bounds our waiting; it cannot guarantee the provider stops computation or
charges nothing. The existing operation admission and unknown-result guard
remain authoritative and prohibit automatic replay.

Log only run/operation identifiers, sanitized provider request identifiers,
exception class chains and timing facts for first/last provider chunks and first
public text. Do not log provider messages, credentials, business content or
reasoning. Preserve explicitly recognized timeout stages in Harness errors.

When tools and budget permit, a model should continue a legal next step even if
the entire task will not fit. Only the last reserved request disables tools.
Normal answers and actual blockers may still end a turn; do not infer whether
to continue by matching prose keywords or spend extra calls to force completion.

For cloud ordinary final replies, the model declares one trailing control line:
`[[task_outcome:completed]]`, `[[task_outcome:partial]]` or
`[[task_outcome:blocked]]`. The gateway retains a bounded text tail and removes
this line before streaming it to the user. Tool-call bodies do not use it. The
validated reply and immutable `turn.completed` event carry optional
`taskOutcome`; missing older declarations become `unknown`. A completed turn
still means the reply finished. A model-reported task outcome is not verified
business success, official SWE grading or permission to repeat external writes.
Historical context retains this distinction. No database migration or existing
event rewriting is required.

## Acceptance

Use a few bounded actual account/model/tool/storage scenarios: a feasible
sequential read, an intentionally limited partial read, and cancellation while
the real provider request is pending. Record exact revisions, actual events,
operation settlement and available cost. Static source/type/build checks do not
establish timeout or model behavior. If a deadline is not triggered by the real
sample, report it as unexercised. No mocks, replay suites or automatic retries.
