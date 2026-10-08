# ADR-0031: Bounded time for long cloud turns and complete process receipts

- Date: 2026-10-08
- Status: Decision recorded; implementation and real-model acceptance reported separately.

## Evidence

The actual `159f1de` SWE run patched source and started focused process work, but
the deployed default 120-second active-turn deadline cancelled it before it could
finish. A later ordinary `git add -N` completed successfully after an uncertain
HTTP response. Its immutable audit had the actual result digest, 139-byte length
and exit code, but no result artifact because stdout and stderr were empty. The
driver correctly refused to invent the missing response or repeat the write.

## Decision

Use a five-minute default active-turn deadline, retaining the existing maximum of
ten minutes and the existing 12-call shared model allowance. Operators may set
`DAOYIN_CLOUD_RUN_TIMEOUT_MS` to an explicitly validated value between one second
and ten minutes. The clock still pauses only for existing user-interaction waits;
request, process, output and concurrency limits remain independent. Cancellation
continues to stop future work and retain completed facts, without automatic retry.

For every completed synchronous `process_run`, persist the complete controlled
JSON result as an immutable artifact before its completion audit, even when its
text streams are empty. Empty streams do not remove exit status, sandbox and
timeout facts. `process_read` retains its existing nonempty-output policy to avoid
creating artifacts for empty polling reads. Recovery checks the actual artifact
bytes, digest, size and scope; it never guesses a result from a missing artifact.

## Acceptance

Retain the original cancelled turn and failed export. Use only a bounded real
model task through ordinary account/tool/storage paths for fresh acceptance;
source/type/build review is packaging evidence. Do not replay the original write
or replace a failed result with a successful assertion. Provider/model compliance
with tool-free closing requests is a separate observed limitation.
