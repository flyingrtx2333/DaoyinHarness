import { createPlatformCloudServer } from "./platform-adapter.js";
import { PostgresCloudRepository } from "./postgres-repository.js";

const databaseUrl = process.env.DAOYIN_CLOUD_POSTGRES_URL ?? "";
const port = Number(process.env.DAOYIN_CLOUD_PORT ?? "4700");
const appServiceToken = process.env.DAOYIN_CLOUD_APP_SERVICE_TOKEN;
try {
  const url = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("unsupported protocol");
} catch {
  throw new Error("Set DAOYIN_CLOUD_POSTGRES_URL to a PostgreSQL connection URL and DAOYIN_CLOUD_PORT to a valid port.");
}
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("Set DAOYIN_CLOUD_POSTGRES_URL to a PostgreSQL connection URL and DAOYIN_CLOUD_PORT to a valid port.");
}
const repository = await PostgresCloudRepository.open(databaseUrl);
let app: ReturnType<typeof createPlatformCloudServer> | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let closing: Promise<void> | undefined;

function close(): Promise<void> {
  if (closing !== undefined) return closing;
  if (heartbeat !== undefined) clearInterval(heartbeat);
  closing = (async () => {
    try { await app?.close(); }
    finally {
      try { await repository.releaseRuntimeLease(); }
      finally { await repository.close(); }
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
  app = createPlatformCloudServer({ repository,
    platformUrl: process.env.DAOYIN_CLOUD_PLATFORM_URL ?? "",
    serviceToken: process.env.DAOYIN_CLOUD_SERVICE_TOKEN ?? "",
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
