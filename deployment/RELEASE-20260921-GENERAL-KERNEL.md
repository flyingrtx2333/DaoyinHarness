# General execution kernel cloud acceptance record

- Date: 2026-09-21 (Asia/Shanghai)
- Resource-service source and active release: `05342aacc268d81c2bad6116f3b3864e8ef09fa5`
- Authoritative checkout: `/root/DaoyinHarness` on `main`
- Runtime: `harness-runsc`; public network: controlled egress
- Validation policy: small real-model and real-tool samples only; no mock model, Vitest or replay suite was run.

## Implemented and observed

- The generic resource, workspace, immutable snapshot, artifact, process and deployment contracts are active on the cloud resource service.
- Python real-model run installed dependencies, changed files and passed 2 real pytest cases; snapshot `snp_0c8de946fedee0840ed499a4` has digest `sha256:0232909e9ed2c54719a5f2bf472e30ccd707945844f1e915281dac0993b4b588`.
- Node real-model run started a background process, read incremental logs and stopped it.
- Go real-model run compiled and executed successfully and produced artifact `art_22a1ff530665439ed9cf2c80` with blob `sha256:fc4ce983c93a40e2ddac7767d267455fdd1b1cde3e6f8064745affe251ac0253`.
- One session attached two workspaces, read both and exercised PTY input/output. A second PTY that expired without a later user read exposed a stale database state; active reconciliation now persisted it as `timed_out` and appended `process.reconciled`.
- Every workspace now receives an internal network shared only with the trusted egress proxy. Three existing deployments were migrated and restarted one at a time. The legacy shared network now contains only the proxy.
- A real npm Registry query returned TypeScript `7.0.2`. The audit row records `registry.npmjs.org:443`, `CONNECT`, `allowed` and byte counts.
- Requests to `169.254.169.254:443` and `10.0.0.1:443` returned proxy `403` and produced `denied` audit rows. A direct TCP attempt between two deployment workspaces was refused.
- A foreground process exceeding its one-second deadline returned `PROCESS_TIMEOUT` with HTTP 408. A process exceeding its 1,024-byte output budget returned `PROCESS_OUTPUT_LIMIT` with HTTP 422. Both paths left no container carrying the temporary workspace label.
- A real background Node process appeared as a running gVisor container, then `process_stop` returned `cancelled` and removed it. A 128 MiB memory limit terminated a 512 MiB allocation with exit code 137, and a 128 MiB workspace volume rejected further writes with `ENOSPC` after 112 MiB of test data.
- A CPU-bound process configured for 0.1 CPU reported `NanoCpus=100000000` and an observed 9.79% CPU sample. Its container also reported the configured 256 MiB memory and 128 PID limits.
- A Node runtime configured with only 16 PIDs could not start under gVisor. The executor now returns `PROCESS_START_FAILED` with an actionable runtime/limit message and removes the failed container instead of exposing a raw Docker 125 result.
- The three existing managed domains returned HTTP 200 before and after migration. All four resource services were active and the resource readiness control returned success.

## Release recovery exercised

The first rollout exposed that the executor rejected global process reconciliation before dispatch. The resource service was immediately pointed back to the previous exact release, restored, then the ordering fix was committed and deployed. Later egress checks found and fixed gVisor live-network migration, proxy host mapping and Unix-socket group access. No failed candidate replaced a published route.

## Not yet accepted

- Cross-account and cross-space denial with a second authenticated platform session.
- DNS rebinding and platform-specific internal hostname cases beyond direct private/link-local addresses.
- A runtime-independent PID-limit acceptance signal. Very low PID limits are enforced, but current gVisor failures do not distinguish PID exhaustion from other startup-resource failures; the usable minimum also differs by runtime image.
- Independent operator cryptographic verification for signed runtime images.
- Accurate final HTTP method visibility inside encrypted CONNECT tunnels; audit currently records `CONNECT`.
- A Rust sample in addition to the completed Go sample.
- Three to five SWE-bench Verified tasks with official grader results.
- Full existing-project database/upload/domain migration rollback drill and the seven-day legacy-table contraction.

These remaining items are release gates, not inferred successes from readiness, static checks or the passing small sample.
