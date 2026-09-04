import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ModelClient } from "@daoyin/harness-agent-core";
import type { RuntimeBootstrap, SessionEventsResponse } from "@daoyin/harness-protocol";
import { createApp } from "./app.js";

let app: FastifyInstance | undefined;
const cleanupDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanupDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  await Promise.all(cleanupDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

describe("local server security boundary", () => {
  it("returns explicit P1 readiness from the loopback health endpoint", async () => {
    app = await createApp({ port: 4677, version: "0.1.0", startedAt: "2026-09-02T00:00:00.000Z" });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { host: "127.0.0.1:4677" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ready",
      apiVersion: "v1",
      capabilities: {
        process: "planned",
        database: "planned",
        workspace: "planned",
        authentication: "planned",
      },
    });
  });

  it("rejects a non-loopback Host", async () => {
    app = await createApp({ port: 4677, version: "0.1.0", startedAt: new Date().toISOString() });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { host: "attacker.example" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_HOST" } });
  });

  it("rejects the right address with the wrong selected port", async () => {
    app = await createApp({ port: 4677, version: "0.1.0", startedAt: new Date().toISOString() });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { host: "127.0.0.1:4688" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_HOST" } });
  });

  it("rejects a cross-origin browser request", async () => {
    app = await createApp({ port: 4677, version: "0.1.0", startedAt: new Date().toISOString() });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { host: "127.0.0.1:4677", origin: "https://attacker.example" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_ORIGIN" } });
  });

  it("sets restrictive browser response headers", async () => {
    app = await createApp({ port: 4677, version: "0.1.0", startedAt: new Date().toISOString() });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { host: "127.0.0.1:4677" },
    });

    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("rejects state changes without the bootstrap cookie and CSRF token", async () => {
    const dataDir = await temporaryDirectory("daoyin-server-data-");
    const workspaceRoot = await temporaryDirectory("daoyin-server-workspace-");
    app = await createApp({ port: 4677, version: "0.1.0", startedAt: new Date().toISOString(), dataDir, workspaceRoot });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { host: "127.0.0.1:4677", "content-type": "application/json" },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "CSRF_REJECTED" } });
  });

  it("persists a session, executes a workspace tool, and replays the turn by event sequence", async () => {
    const dataDir = await temporaryDirectory("daoyin-server-data-");
    const workspaceRoot = await temporaryDirectory("daoyin-server-workspace-");
    let modelStep = 0;
    const model: ModelClient = {
      async complete() {
        modelStep += 1;
        if (modelStep === 1) {
          return {
            kind: "tool_calls",
            calls: [{ id: "call_write", name: "write_file", input: { path: "hello.txt", content: "DaoyinHarness works.\n" } }],
          };
        }
        return { kind: "assistant", content: "文件已写入并完成。" };
      },
    };
    app = await createApp({
      port: 4677,
      version: "0.1.0",
      startedAt: new Date().toISOString(),
      dataDir,
      workspaceRoot,
      model,
    });

    const bootstrapResponse = await app.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      headers: { host: "127.0.0.1:4677" },
    });
    const bootstrap = bootstrapResponse.json<RuntimeBootstrap>();
    const setCookie = bootstrapResponse.headers["set-cookie"];
    const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookie).toContain("HttpOnly");
    expect(bootstrap.workspace).toMatchObject({ root: workspaceRoot, fileCount: 0 });

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: {
        host: "127.0.0.1:4677",
        cookie: cookie ?? "",
        "x-daoyin-csrf": bootstrap.csrfToken,
        "content-type": "application/json",
      },
      payload: { title: "测试会话" },
    });
    expect(createResponse.statusCode).toBe(201);
    const sessionId = createResponse.json<{ session: { id: string } }>().session.id;

    const turnResponse = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/turns`,
      headers: {
        host: "127.0.0.1:4677",
        cookie: cookie ?? "",
        "x-daoyin-csrf": bootstrap.csrfToken,
        "content-type": "application/json",
      },
      payload: { message: "创建 hello.txt" },
    });
    expect(turnResponse.statusCode).toBe(202);

    let replay: SessionEventsResponse | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const eventsResponse = await app.inject({
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/events?after=0`,
        headers: { host: "127.0.0.1:4677" },
      });
      replay = eventsResponse.json<SessionEventsResponse>();
      if (replay.events.some((event) => event.type === "turn.completed")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(replay?.events.map((event) => event.type)).toEqual([
      "turn.started",
      "tool.started",
      "tool.completed",
      "assistant.delta",
      "turn.completed",
    ]);
    expect(replay?.events.map((event) => event.eventSeq)).toEqual([1, 2, 3, 4, 5]);
    await expect(readFile(join(workspaceRoot, "hello.txt"), "utf8")).resolves.toBe("DaoyinHarness works.\n");

    const incrementalResponse = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/events?after=3`,
      headers: { host: "127.0.0.1:4677" },
    });
    expect(incrementalResponse.json<SessionEventsResponse>().events.map((event) => event.eventSeq)).toEqual([4, 5]);
  });
});
