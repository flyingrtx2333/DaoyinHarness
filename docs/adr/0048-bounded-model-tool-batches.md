# ADR-0048: Align bounded model tool batches across the gateway

Status: accepted, 2026-10-11

## Evidence

The Agent kernel accepts up to sixteen calls per response. The platform stream
assembler and post-response validator, and the cloud adapter, still reject more
than four. Actual continuation runs lost two responses after four calls had been
assembled, with a provider `ValueError`. This transport restriction conflicts
with guidance to batch independent observations and consumes shared allowance
without executing the batch.

## Decision

The Harness protocol defines a maximum of sixteen calls per model response,
32,000 JSON characters per call, and 48,000 aggregate argument characters.
The kernel and cloud adapter reuse these constants. The trusted platform
Harness path mirrors the same contract in its streaming and synchronous
validation. Other platform applications retain their existing four-call limit.
Limits are supplied by trusted application code, never provider output or a
browser. The Harness model receives the batch bounds as trusted instructions.

Validate the complete response before dispatch; do not truncate a batch or
execute a valid prefix. Stream rejection records a safe failure code without
logging arguments. Call limits do not create concurrency or permission:
existing per-tool authorization, serialized mutation, root tool budget and
uncertain-operation rules remain authoritative. Paid requests are not refunded
or automatically replayed after parser rejection.

## Validation

Use syntax/type/packaging checks, then affected real authenticated continuation
and fixed SWE cases within the existing 100-request / CNY 5 ledger. Retain all
earlier failed runs and unknown cost reservations. No fabricated responses or
legacy test suites, and no issue-specific execution rules.
