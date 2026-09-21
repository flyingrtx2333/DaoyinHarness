import { createPlatformCloudServer } from "./platform-adapter.js";
import { createConfiguredMemoryRetriever } from "./memory-retrieval-config.js";
import { PostgresCloudRepository } from "./postgres-repository.js";
import { loadRuntimeBuild } from "./runtime-health.js";
import { configuredTelemetry, disabledTelemetry, type Telemetry } from "./observability.js";

const databaseUrl = process.env.DAOYIN_CLOUD_POSTGRES_URL ?? "";
const port = Number(process.env.DAOYIN_CLOUD_PORT ?? "4700");
const platformUrl = process.env.DAOYIN_CLOUD_PLATFORM_URL ?? "";
const appServiceToken = process.env.DAOYIN_CLOUD_APP_SERVICE_TOKEN;
const vectorMinScoreRaw = process.env.DAOYIN_MEMORY_VECTOR_MIN_SCORE;
const capabilityRouterMode = process.env.DAOYIN_CAPABILITY_ROUTER_MODE ?? "off";
const generalResourcesMode = process.env.HARNESS_GENERAL_RESOURCES_MODE ?? process.env.DAOYIN_GENERAL_RESOURCES_MODE ?? "off";
const vectorMinScore = vectorMinScoreRaw === undefined ? undefined : Number(vectorMinScoreRaw);
try {
  const url = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("unsupported protocol");
} catch {
  throw new Error("Set DAOYIN_CLOUD_POSTGRES_URL to a PostgreSQL connection URL and DAOYIN_CLOUD_PORT to a valid port.");
}
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("Set DAOYIN_CLOUD_POSTGRES_URL to a PostgreSQL connection URL and DAOYIN_CLOUD_PORT to a valid port.");
}
if (vectorMinScore !== undefined && (!Number.isFinite(vectorMinScore) || vectorMinScore < -1 || vectorMinScore > 1)) {
  throw new Error("DAOYIN_MEMORY_VECTOR_MIN_SCORE must be between -1 and 1.");
}
if (!["off", "shadow", "enforce"].includes(capabilityRouterMode)) {
  throw new Error("DAOYIN_CAPABILITY_ROUTER_MODE must be off, shadow or enforce.");
}
if (!["off", "shadow", "enforce"].includes(generalResourcesMode)) {
  throw new Error("HARNESS_GENERAL_RESOURCES_MODE must be off, shadow or enforce.");
}

// 2. 初始化 PostgreSQL 仓储与检索器工厂
const repository = await PostgresCloudRepository.open(databaseUrl, {
  memoryRetrieverFactory: (pool) => createConfiguredMemoryRetriever(pool, {
    platformUrl, ...(appServiceToken === undefined ? {} : { appServiceToken }),
    ...(vectorMinScore === undefined ? {} : { vectorMinScore }),
  }),
});
let app: ReturnType<typeof createPlatformCloudServer> | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let closing: Promise<void> | undefined;
let telemetry: Telemetry = disabledTelemetry;

function close(): Promise<void> {
  if (closing !== undefined) return closing;
  if (heartbeat !== undefined) clearInterval(heartbeat);
  closing = (async () => {
    try { await app?.close(); }
    finally {
      try { await telemetry.shutdown(); }
      finally {
        try { await repository.releaseRuntimeLease(); }
        finally { await repository.close(); }
      }
    }
  })();
  return closing;
}

function shutdown(failed = false): void {
  if (failed) process.exitCode = 1;
  void close().catch(() => {
    process.exitCode = 1;
    process.stderr.write("Cloud runtime shutdown failed; retained records need inspection.\n");
  });
}

try {
  // Validate platform config before acquiring ownership or touching prior task states.
  const buildInfo = await loadRuntimeBuild(new URL("./release.json", import.meta.url));
  telemetry = configuredTelemetry(process.env, buildInfo.revision ?? "unknown");
  app = createPlatformCloudServer({ repository,
    buildInfo, telemetry,
    platformUrl,
    serviceToken: process.env.DAOYIN_CLOUD_SERVICE_TOKEN ?? "",
    capabilityRouterMode: capabilityRouterMode as "off" | "shadow" | "enforce",
    generalResourcesMode: generalResourcesMode as "off" | "shadow" | "enforce",
    ...(appServiceToken ? { appServiceToken } : {}),
  });
  // Startup never creates or changes production schema. Run postgres-migrate first.
  await repository.verifySchema();
  const lease = await repository.acquireRuntimeLease({ durationMs: 30_000, recoverInterrupted: true });
  heartbeat = setInterval(() => {
    void repository.renewRuntimeLease().then((owned) => {
      if (!owned) {
        process.stderr.write("Cloud runtime lost its execution lease; stopping without replay.\n");
        shutdown(true);
      }
    }).catch(() => shutdown(true));
  }, 10_000);
  heartbeat.unref();
  process.once("SIGINT", () => shutdown());
  process.once("SIGTERM", () => shutdown());
  await app.listen({ host: "127.0.0.1", port });
  process.stdout.write(`Shared Agent pilot listening on 127.0.0.1:${String(port)}; interrupted prior runs: ${String(lease.recoveredRuns)}\n`);
} catch {
  await close();
  throw new Error("Cloud runtime could not start; check the explicit port, PostgreSQL schema, execution lease and platform configuration.");
}
