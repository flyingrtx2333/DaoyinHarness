# ADR-0030: One model budget for routing and task execution

- Date: 2026-10-08
- Status: Implemented in source; real-model acceptance and deployment reported separately.

## Evidence

The first two actual SWE tasks reached ten successful Agent model responses, then
failed on the next response. The first run had twelve completed platform model
operations: the two capability routing operations consumed the platform's same
per-run allowance of twelve. The platform returned `MODEL_RUN_LIMIT` internally,
but its streaming wrapper emitted only `MODEL_OPERATION_FAILED`; Harness therefore
recorded `PLATFORM_BRIDGE_UNAVAILABLE`. This is a budget mismatch, not evidence of
a network outage or a context rejection. The original failed runs remain evidence.

## Decision

Cloud capability retrieve/analyze attempts, task requests, context condensation,
context-rejection recovery and child Agent requests share one root-run counter.
Admission checks and increments execute synchronously before any gateway attempt.
A reserved slot is never refunded after cancellation, timeout, persistence failure
or an uncertain result. Concurrent semantic calls cannot reuse an occupied slot.
This conservative budget can count a reservation that did not reach the gateway;
it must never undercount an attempt that may have reached it.

Semantic routing may consume capacity only while retaining at least one request
for the main Agent. A budget smaller than three skips both semantic stages and
uses the existing authorized lexical/safe-readonly selection. Failed semantic
attempts retain their charges and use that same fallback, without retrying them.

Routing emits distinct `capability.model.requested` and
`capability.model.responded` events with root-run scope, shared call index,
operation kind, bounded candidate metadata, outcome and latency. These are routing
operations, not fabricated Agent replies. They can precede `turn.started` because
the existing route is prepared before Engine initialization. Agent model events
retain their existing meaning. Evaluation accounting includes both request types.

After routing the Engine receives the remaining request allowance. A trusted
dynamic callback also accounts for capacity consumed by children or condensation.
The last available task request exposes no tools and asks for a factual closing
answer. Condensation reserves capacity for actual task work; children retain the
parent's final request. Model context includes a trusted remaining-request notice.
Local callers without a shared callback keep the existing Engine behavior.

The platform's twelve-operation limit is unchanged. Unknown streaming error codes
are not guessed from messages and do not permit automatic recovery or retries.

## Acceptance

Use the authenticated actual Gateway and immutable cloud events for the next
small sample. Record routing and Agent attempts separately and their shared total;
retain failures and unknown provider totals honestly. Re-run only the three real
SWE cases, then grade their actual exported patches with the official harness.
Cancellation and low-budget fallback require actual evidence before claiming
behavioral acceptance. Source/type/lint checks are static evidence only; no fake
models, replay tests or deterministic regression suites are introduced or run.
