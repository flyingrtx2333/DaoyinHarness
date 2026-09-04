import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunningHarness } from "./runtime.js";
import { startHarness } from "./runtime.js";

const cleanupDirectories: string[] = [];
const cleanupServers: Server[] = [];
const runningHarnesses: RunningHarness[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "daoyin-harness-test-"));
  cleanupDirectories.push(directory);
  return directory;
}

async function occupyAvailablePort(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  cleanupServers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP address.");
  }
  return { server, port: address.port };
}

afterEach(async () => {
  await Promise.all(runningHarnesses.splice(0).map(async (running) => running.app.close()));
  await Promise.all(cleanupServers.splice(0).map(async (server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(cleanupDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

describe("runtime startup", () => {
  it("starts on one of the documented default loopback ports", async () => {
    const dataDir = await temporaryDirectory();
    const running = await startHarness(
      { openBrowser: false, dataDir, workspaceRoot: dataDir, sandboxMode: "auto", logLevel: "silent", help: false, version: false },
      "0.1.0-test",
      join(dataDir, "missing-public"),
    );
    runningHarnesses.push(running);

    expect(running.port).toBeGreaterThanOrEqual(4677);
    expect(running.port).toBeLessThanOrEqual(4699);
    expect(running.url).toBe(`http://127.0.0.1:${String(running.port)}`);

    const response = await fetch(`${running.url}/api/v1/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ready",
      version: "0.1.0-test",
      runtime: { port: running.port },
    });
  });

  it("returns a stable error instead of scanning when an explicit port is occupied", async () => {
    const dataDir = await temporaryDirectory();
    const occupied = await occupyAvailablePort();

    await expect(
      startHarness(
        { port: occupied.port, openBrowser: false, dataDir, workspaceRoot: dataDir, sandboxMode: "auto", logLevel: "silent", help: false, version: false },
        "0.1.0-test",
        join(dataDir, "missing-public"),
      ),
    ).rejects.toMatchObject({
      code: "PORT_IN_USE",
      message: `指定端口 ${String(occupied.port)} 已被占用。`,
    });
  });
});
