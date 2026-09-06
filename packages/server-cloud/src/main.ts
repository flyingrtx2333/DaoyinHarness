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
const app = createPlatformCloudServer({ repository,
  platformUrl: process.env.DAOYIN_CLOUD_PLATFORM_URL ?? "",
  serviceToken: process.env.DAOYIN_CLOUD_SERVICE_TOKEN ?? "",
  ...(appServiceToken ? { appServiceToken } : {}),
});
let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await app.close();
  repository.close();
}
process.once("SIGINT", () => { void close(); });
process.once("SIGTERM", () => { void close(); });
try {
  await app.listen({ host: "127.0.0.1", port });
  process.stdout.write(`Shared Agent pilot listening on 127.0.0.1:${String(port)}\n`);
} catch {
  await close();
  throw new Error("Cloud pilot could not start; check the explicit port and platform configuration.");
}
