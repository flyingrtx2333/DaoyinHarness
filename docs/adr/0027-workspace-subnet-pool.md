# ADR-0027: Dedicated workspace subnet allocation

- Date: 2026-10-08
- Status: Source decision; deployment and actual execution validation pending.

## Evidence

An authenticated cloud CSV task on revision `be1c93e5fdf26f65c39feaf88f01443b2d1fcf26` wrote its input and program, but four model-requested process operations failed. Resource audit recorded `EGRESS_UNAVAILABLE`; the Agent was cancelled and its immutable events retained. Read-only production inspection found its expected network absent. Existing networks occupy all 15 built-in `172.17` through `172.31` `/16` blocks and all 16 `192.168` `/20` blocks; Docker reported no custom default address pool. `ensureWorkspaceEgress` discarded the network-creation result, masking a creation failure as an isolation failure. No diagnostic network was created on the server.

## Decision

Support optional operator configuration `HARNESS_WORKSPACE_SUBNET_POOL`, a canonical RFC1918 IPv4 `/16`. Only newly created workspaces allocate explicit `/24` subnets from it. Start at a workspace-hash-derived slot and skip overlapping Docker network ranges, including supernets and smaller subnets. Docker remains the final allocation authority; bounded refresh handles a concurrent allocation collision. Inventory failures stop allocation. A failed creation is successful only if a subsequent inspection proves a correctly isolated network owned by that workspace.

Keep `--internal`, existing ownership labels, the isolated workspace network and the authenticated egress proxy. Existing valid networks remain unchanged. Do not modify the Docker daemon's global pools, delete networks, renumber workspaces or relax isolation. Creation, inventory and pool-exhaustion errors have bounded public messages and never return raw Docker stderr.

The cloud resource adapter returns only these allowlisted network errors as safe, non-retryable tool failures instead of losing the failing stage in a generic business error. After such a failure, further `process_run` and `process_start` calls for the same workspace in that run are rejected without contacting the executor. Read-only evidence and process cancellation remain available; a subsequent run can retry after the environment is repaired. No raw remote exception text enters the model context.

Before choosing a pool, the operator must inspect Docker subnets and host/VPN routes for overlap. On this inspection, `10.253.0.0/16` had no overlap with the reported Docker subnets or main IPv4 routes; this is an observation, not a permanent reservation. A `/16` provides 256 `/24` workspace networks, not unlimited capacity. Network reclamation is outside this change.

## Deployment and acceptance

Deployment requires explicit owner authorization. Build exact pushed Git objects on the production checkout; update the resource executor and deployer that include this shared module, preserve other configuration, and set only the chosen pool. No Docker daemon or main-platform restart is required. The shared AgentEngine candidate has a separate runtime release and revision requirement.

After deployment, use the ordinary authenticated cloud path to inspect the new network's subnet, Internal flag, ownership and proxy attachment, execute a bounded actual workspace command, then repeat the CSV task with the real model. Persist the actual tool/process output and resulting artifact. Until those observations exist, this is an unvalidated source fix. Do not run mock-network or fake-model suites.

Docker documents [explicit subnet allocation and its built-in default pools](https://docs.docker.com/engine/network/#subnet-allocation).
