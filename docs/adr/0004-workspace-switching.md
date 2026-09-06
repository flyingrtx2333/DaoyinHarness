# ADR 0004: Local workspace selection and isolation

Status: Accepted

The browser can explicitly choose an existing local directory, enter its absolute path, or reopen a recent workspace. Selection is a CSRF-protected local API operation, never an Agent tool. The native folder picker returns a candidate only; opening it is a separate action.

`workspaces.json` in the runtime data directory records the canonical legacy root and up to 20 recent roots. The initial root retains the existing `state/sessions.json` catalog without moving or rewriting transcripts. Other roots use hash-named catalogs under `workspaces/`. Transcripts, memory, orchestration and permission manifests remain in place; existing resource/session scope checks apply. All session routes resolve through the active catalog. Account memory remains account-scoped.

Switching requires no active turns or other in-flight API requests. The server prepares a new workspace, tools, prompt context, browser and MCP runtime before committing the active state. A failed preparation retains the old runtime. Successful switching rotates the CSRF token and workspace revision, closes old event streams and browser/MCP resources, and reloads the initiating UI. Stale tabs cannot mutate the newly selected workspace. Requests carrying an old revision receive a refresh instruction.

The CLI restores the last accessible workspace unless `--workspace` is explicit. Missing recent folders remain visible and opening them reports an error. Invalid paths never create folders. Native Windows selection uses a fixed PowerShell script with no interpolated user input; other platforms retain manual path entry.

Default recursive file enumeration skips dependency, VCS, cache and generated-output directories, plus the repository's forbidden reference-source directory. Explicit safe relative reads retain the existing path boundary. This is enumeration policy, not an OS sandbox.

Validation: Windows unit/API tests cover invalid paths, CSRF, concurrent/active work, stale tabs, session isolation, restart persistence and rollback; local browser acceptance covers opening, switching, recent history and responsive layout. Native dialog behavior is distinguished from injected picker tests.
