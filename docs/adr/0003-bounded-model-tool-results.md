# 0003: Bound derived tool results sent to the model

Status: Accepted

## Context

The deployed gateway rejects message content longer than 100,000 characters. A real `list_files` result containing 2,000 paths serialized to 129,704 characters, so the Agent failed on the model request after a successful local tool execution.

## Decision

Keep the canonical `tool.completed` evidence unchanged. At the Agent-to-model boundary, derive a valid JSON view capped at 24,000 UTF-16 code units per tool result. Normal-sized results retain their existing shape and exact serialization. Oversized views retain success/failure status and concise summaries, include an explicit `modelContext.truncated` notice and original serialized size, and contain a bounded structured preview. Array previews contain only complete entries; string previews mark their truncation and never split a surrogate pair. The model must narrow the directory or search query rather than assume a preview is a complete result.

The gateway adapter also rejects any message exceeding the verified 100,000-character limit before authentication/network work. It does not silently truncate user messages or system instructions. HTTP 422 receives a safe format-validation or length-limit explanation without echoing validation `input` or arbitrary server text.

## Consequences

- Full tool facts remain in append-only transcripts; model context is derived and disposable.
- This fixes individual oversized messages, not aggregate context-window budgeting or pagination beyond the workspace's existing enumeration limit.
- A generic preview may omit later fields or array entries. Explicit metadata prevents interpreting absence as a negative finding.
- Tests must reproduce the second model request after a large successful tool result, prove the persisted evidence is complete, and verify safe handling of validation responses.

## Verification

Run the standard Windows typecheck, lint, test and build commands. For an explicitly authorized billable acceptance check, set `DAOYIN_HARNESS_RUN_REAL_MODEL=1` in Windows PowerShell and run `node scripts/verify-large-tool-result.mjs`. It requires an existing, unexpired local Daoyin login and a workspace whose list output exceeds 100,000 characters. Only `list_files` is mounted; verification does not read file contents or alter user sessions. Its separate evidence transcript and HTTP status/length report are saved under `evidence/gateway-large-tool-result/`.
