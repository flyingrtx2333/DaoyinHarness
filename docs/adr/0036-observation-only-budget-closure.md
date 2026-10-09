# ADR-0036: Observation-only context for bounded turn closure

- Date: 2026-10-09
- Status: Implementation and real-model validation reported separately.

## Evidence

Three real cloud tasks reached the twelve-request shared budget. All final
requests offered no tools. The provider returned ordinary text resembling the
adapter's assistant-role tool-history records, including new operations that
never ran, and omitted the task-outcome declaration. A finished turn was not a
finished task. This is a general closure problem, not a benchmark-specific rule.
A subsequent ordinary file task succeeded, but a bounded file task still returned
unevaluated tool markup after the observation projection. System instructions
alone did not reliably switch that request from execution to result reporting.

## Decision

The shared Engine owns a derived observation-only context for its last reserved
request. Validate complete tool request/result groups first, then represent each
batch as a user-role evidence record with request identity, tool name, original
arguments and the returned observation. Do not offer assistant-role executable
call examples. Planning commentary is labelled unverified, not execution proof.
Tool contents remain untrusted data; a returned observation, including exit
codes and errors, is not proof of success. Preserve omission and truncation facts.

Apply message/character limits to this final representation inside the existing
context composer, including confirmed context-rejection recovery. Do not change
the canonical transcript, historical user/assistant dialogue, ordinary tool
requests, permissions, cancellation or unknown-result replay guards. The
gateway's legacy projection remains for older clients; new Engine closures no
longer send protocol tool messages to it.

Closure instructions ask for the user's requested deliverable, actual completed
work, verification and unfinished work. Proposed operations must not appear as
executed receipts. Put a derived runtime phase-switch request after all retained
observations, including the result declaration contract, so the last input asks
for a result report rather than continuation from tool data. Count this request
in the same message/character limits and context-rejection recovery; it adds no
model calls, tool access or user transcript event. Retain the existing cloud
outcome declaration; missing reports
remain unknown and self-reported completed still requires independent evidence.
Do not infer task success from prose or manufacture a completed declaration.

Keep the shared call, tool, time and cost limits. Reuse observed information and
combine independent safe reads when useful; do not force sequential tool calls
or repeat failed preparation merely to consume the allowance. Workspace runtime
and dependency requirements remain capability-owned. No dataset IDs, expected
patches, benchmark dependency lists or privileged environment setup enter the
shared Engine.

For a single attached workspace, reuse the existing authenticated inspection
capability when allowed to include a bounded runtime-manifest fact list in the
workspace context. Only fixed state/runtime IDs, image digests, network enum and
numeric resource limits may enter the trusted prompt. Never include environment,
secret references, resource titles, source URLs or Dockerfile text. A manifest
does not prove installed software or dependencies; inspect actual versions only
when required by the task. Multiple attachments still require target selection,
and absence of inspection permission adds no access or new consent flow.

## Validation

Use a few actual cloud model/tool/storage tasks across file transformations and
partial or blocked work. Check the actual output artifact and persisted final
request, including bounds, tool receipts and outcome. Never execute final text
as a tool, replay unknown writes or replace model validation with mocks. Official
SWE grading, if rerun, is separate evidence and not the product contract.
