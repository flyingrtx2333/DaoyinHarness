import { mkdir } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import open from "open";
import {
  DaoyinGatewayModelClient,
  DaoyinOAuthSession,
  WindowsDpapiCredentialStore,
  createDevelopmentGatewayModelFromEnvironment,
} from "@daoyin/harness-cloud";
import { resolveMcpEnvironmentConfig } from "@daoyin/harness-mcp";
import { createApp } from "@daoyin/harness-server";
import { DEFAULT_PORT, LAST_SCANNED_PORT, type CliOptions } from "./args.js";

export interface RunningHarness {
  app: FastifyInstance;
  port: number;
  url: string;
}

function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}

export async function startHarness(
  options: CliOptions,
  version: string,
  publicDir: string,
): Promise<RunningHarness> {
  await mkdir(options.dataDir, { recursive: true });
  const mcpServers = options.mcpServers.map((server) => resolveMcpEnvironmentConfig(server, process.env));
  const ports = options.port === undefined
    ? Array.from({ length: LAST_SCANNED_PORT - DEFAULT_PORT + 1 }, (_, index) => DEFAULT_PORT + index)
    : [options.port];

  for (const port of ports) {
    const authentication = new DaoyinOAuthSession({
      platformUrl: process.env.DAOYIN_PLATFORM_URL?.trim() || "https://www.daoyintech.com",
      port,
      credentialStore: new WindowsDpapiCredentialStore(options.dataDir),
    });
    await authentication.initialize();
    const developmentModel = createDevelopmentGatewayModelFromEnvironment(process.env, version);
    const model = developmentModel ?? new DaoyinGatewayModelClient({
      endpoint: authentication.gatewayEndpoint,
      credentialProvider: authentication,
      clientVersion: version,
    });
    const app = await createApp({
      port,
      version,
      startedAt: new Date().toISOString(),
      publicDir,
      dataDir: options.dataDir,
      workspaceRoot: options.workspaceRoot,
      restoreLastWorkspace: options.restoreLastWorkspace ?? false,
      sandboxMode: options.sandboxMode,
      authentication,
      ...(mcpServers.length === 0 ? {} : { mcpServers }),
      model,
      logger: options.logLevel === "silent" ? false : { level: options.logLevel },
    });

    try {
      await app.listen({ host: "127.0.0.1", port });
      const url = `http://127.0.0.1:${port}`;
      if (options.openBrowser) {
        await open(url);
      }
      return { app, port, url };
    } catch (error) {
      await app.close();
      if (isAddressInUse(error) && options.port !== undefined) {
        const occupied = new Error(`指定端口 ${String(port)} 已被占用。`);
        Object.assign(occupied, { code: "PORT_IN_USE" });
        throw occupied;
      }
      if (!isAddressInUse(error)) {
        throw error;
      }
    }
  }

  const error = new Error(`默认端口 ${DEFAULT_PORT} 至 ${LAST_SCANNED_PORT} 均已被占用。`);
  Object.assign(error, { code: "PORT_RANGE_EXHAUSTED" });
  throw error;
}
