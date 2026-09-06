import { isAbsolute } from "node:path";
import { createPlatformCloudServer } from "./platform-adapter.js";
import { SqliteCloudRepository } from "./sqlite-repository.js";

const databasePath = process.env.DAOYIN_CLOUD_DATABASE ?? "";
const port = Number(process.env.DAOYIN_CLOUD_PORT ?? "4700");
const appServiceToken = process.env.DAOYIN_CLOUD_APP_SERVICE_TOKEN;
if (!isAbsolute(databasePath) || !Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("Set an absolute DAOYIN_CLOUD_DATABASE path and a valid DAOYIN_CLOUD_PORT.");
}
const repository = new SqliteCloudRepository(databasePath);
let app: ReturnType<typeof createPlatformCloudServer> | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let closing: Promise<void> | undefined;

function close(): Promise<void> {
  if (closing !== undefined) return closing;
  if (heartbeat !== undefined) clearInterval(heartbeat);
  closing = (async () => {
    try { await app?.close(); }
    finally {
      try { repository.releaseRuntimeLease(); }
      finally { repository.close(); }
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
  const lease = repository.acquireRuntimeLease({ durationMs: 30_000, recoverInterrupted: true });
  heartbeat = setInterval(() => {
    try {
      if (!repository.renewRuntimeLease()) {
        process.stderr.write("Cloud runtime lost its execution lease; stopping without replay.\n");
        shutdown(true);
      }
    } catch { shutdown(true); }
  }, 10_000);
  heartbeat.unref();
  process.once("SIGINT", () => shutdown());
  process.once("SIGTERM", () => shutdown());
  await app.listen({ host: "127.0.0.1", port });
  process.stdout.write(`Shared Agent pilot listening on 127.0.0.1:${String(port)}; interrupted prior runs: ${String(lease.recoveredRuns)}\n`);
} catch {
  await close();
  throw new Error("Cloud pilot could not start; check the explicit port, execution lease and platform configuration.");
}
