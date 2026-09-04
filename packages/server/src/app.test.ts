import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ModelClient } from "@daoyin/harness-agent-core";
import type { McpClientFactory } from "@daoyin/harness-mcp";
import type { RuntimeBootstrap, SessionEventsResponse } from "@daoyin/harness-protocol";
import { createApp } from "./app.js";

let app: FastifyInstance | undefined;
const cleanupDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanupDirectories.push(directory);
  return directory;
}

async function browserExecutableFixture(): Promise<string> {
  const directory = await temporaryDirectory("daoyin-server-browser-executable-");
  const executable = join(directory, "browser-fixture");
  await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(executable, 0o700);
  return executable;
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

  it("mounts the browser capability only when a supported executable is discovered", async () => {
    const dataDir = await temporaryDirectory("daoyin-server-browser-data-");
    const workspaceRoot = await temporaryDirectory("daoyin-server-browser-workspace-");
    const browserExecutablePath = await browserExecutableFixture();
    app = await createApp({
      port: 4677,
      version: "0.1.0",
      startedAt: new Date().toISOString(),
      dataDir,
      workspaceRoot,
      browserExecutablePath,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      headers: { host: "127.0.0.1:4677" },
    });
    const bootstrap = response.json<RuntimeBootstrap>();
    expect(bootstrap.health.capabilities.browser).toBe("ready");
    expect(bootstrap.tools.filter((tool) => tool.category === "browser").map((tool) => tool.name)).toEqual([
      "browser_open",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_back",
      "browser_close",
    ]);
  });

  it("does not advertise browser tools when the configured browser executable is unavailable", async () => {
    const dataDir = await temporaryDirectory("daoyin-server-no-browser-data-");
    const workspaceRoot = await temporaryDirectory("daoyin-server-no-browser-workspace-");
    app = await createApp({
      port: 4677,
      version: "0.1.0",
      startedAt: new Date().toISOString(),
      dataDir,
      workspaceRoot,
      browserExecutablePath: join(workspaceRoot, "missing-browser"),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      headers: { host: "127.0.0.1:4677" },
    });
    const bootstrap = response.json<RuntimeBootstrap>();
    expect(bootstrap.health.capabilities.browser).toBe("unavailable");
    expect(bootstrap.tools.some((tool) => tool.category === "browser")).toBe(false);
  });

  it("mounts connected MCP tools and exposes server status in bootstrap", async () => {
    const dataDir = await temporaryDirectory("daoyin-server-mcp-data-");
    const workspaceRoot = await temporaryDirectory("daoyin-server-mcp-workspace-");
    const mcpClientFactory: McpClientFactory = () => ({
      async connect() {},
      async listTools() {
        return [{
          name: "lookup",
          description: "Look up a record.",
          inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
          annotations: { readOnlyHint: true },
        }];
      },
      async callTool() {
        return { content: [{ type: "text", text: "done" }] };
      },
      serverInfo() {
        return { name: "Test MCP", version: "2.0.0" };
      },
      async close() {},
    });
    app = await createApp({
      port: 4677,
      version: "0.1.0",
      startedAt: new Date().toISOString(),
      dataDir,
      workspaceRoot,
      mcpServers: [{ id: "demo", url: "https://mcp.example.test/mcp" }],
      mcpClientFactory,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      headers: { host: "127.0.0.1:4677" },
    });
    const bootstrap = response.json<RuntimeBootstrap>();
    expect(bootstrap.health.capabilities.mcp).toBe("ready");
    expect(bootstrap.mcpServers).toEqual([
      expect.objectContaining({ id: "demo", status: "connected", serverName: "Test MCP", toolCount: 1 }),
    ]);
    expect(bootstrap.tools.filter((tool) => tool.name.startsWith("mcp_"))).toEqual([
      expect.objectContaining({ category: "extension", name: expect.stringMatching(/^mcp_demo_lookup_[a-f0-9]{12}$/u), mutating: false }),
    ]);
  });

  it("persists visible goals and auditable child-agent runs through the parent Agent loop", async () => {
    const dataDir = await temporaryDirectory("daoyin-server-orchestration-data-");
    const workspaceRoot = await temporaryDirectory("daoyin-server-orchestration-workspace-");
    let parentStep = 0;
    const model: ModelClient = {
      async complete(request) {
        const system = request.messages[0];
        if (system?.role === "system" && system.content.includes("bounded child Agent")) {
          const childToolNames = request.tools.map((tool) => tool.name);
          expect(childToolNames).not.toContain("delegate_agent");
          expect(childToolNames).not.toContain("workflow_run");
          expect(childToolNames).not.toContain("run_package_script");
          expect(childToolNames).not.toContain("memory_remember");
          return { kind: "assistant", content: "Child subtask completed with evidence." };
        }
        parentStep += 1;
        if (parentStep === 1) {
          return {
            kind: "tool_calls",
            calls: [{
              id: "call_goal_create",
              name: "goal_create",
              input: { title: "Finish orchestration", steps: ["Create visible goal", "Delegate bounded child work"] },
            }],
          };
        }
        if (parentStep === 2) {
          return {
            kind: "tool_calls",
            calls: [{ id: "call_delegate", name: "delegate_agent", input: { instruction: "Inspect the delegated orchestration subtask only." } }],
          };
        }
        return { kind: "assistant", content: "Parent completed after verified child evidence." };
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

    const bootstrapResponse = await app.inject({ method: "GET", url: "/api/v1/bootstrap", headers: { host: "127.0.0.1:4677" } });
    const bootstrap = bootstrapResponse.json<RuntimeBootstrap>();
    const setCookie = bootstrapResponse.headers["set-cookie"];
    const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(bootstrap.health.capabilities.orchestration).toBe("ready");
    expect(bootstrap.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "goal_create",
      "goal_list",
      "goal_update",
      "workflow_create",
      "workflow_list",
      "workflow_run",
      "delegate_agent",
    ]));

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: {
        host: "127.0.0.1:4677",
        cookie: cookie ?? "",
        "x-daoyin-csrf": bootstrap.csrfToken,
        "content-type": "application/json",
      },
      payload: { title: "Orchestration test" },
    });
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
      payload: { message: "Create a visible goal and delegate one bounded subtask." },
    });
    expect(turnResponse.statusCode).toBe(202);

    for (let attempt = 0; attempt < 80; attempt += 1) {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/events?after=0`,
        headers: { host: "127.0.0.1:4677" },
      });
      if (response.json<SessionEventsResponse>().events.some((event) => event.type === "turn.completed")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const orchestrationResponse = await app.inject({
      method: "GET",
      url: `/api/v1/orchestration?sessionId=${encodeURIComponent(sessionId)}`,
      headers: { host: "127.0.0.1:4677" },
    });
    expect(orchestrationResponse.statusCode).toBe(200);
    const orchestration = orchestrationResponse.json<import("@daoyin/harness-protocol").OrchestrationSnapshot>();
    expect(orchestration.goals).toEqual([
      expect.objectContaining({ title: "Finish orchestration", status: "active", revision: 1 }),
    ]);
    expect(orchestration.childRuns).toEqual([
      expect.objectContaining({
        parentSessionId: sessionId,
        status: "completed",
        finalText: "Child subtask completed with evidence.",
      }),
    ]);
    expect(orchestration.childRuns[0]?.childSessionId).not.toBe(sessionId);
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

  it("pushes live turn events over WebSocket with persisted event sequences", async () => {
    const dataDir = await temporaryDirectory("daoyin-server-ws-data-");
    const workspaceRoot = await temporaryDirectory("daoyin-server-ws-workspace-");
    const model: ModelClient = {
      async complete() {
        return { kind: "assistant", content: "streamed response" };
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
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: {
        host: "127.0.0.1:4677",
        cookie: cookie ?? "",
        "x-daoyin-csrf": bootstrap.csrfToken,
        "content-type": "application/json",
      },
      payload: { title: "WebSocket test" },
    });
    const sessionId = createResponse.json<{ session: { id: string } }>().session.id;
    const socket = await app.injectWS(`/api/v1/sessions/${sessionId}/events/ws?after=0`, {
      headers: {
        host: "127.0.0.1:4677",
        origin: "http://127.0.0.1:4677",
        cookie: cookie ?? "",
      },
    });
    const streamed: Array<{ type?: string; event?: { type?: string; eventSeq?: number }; session?: { activeTurnId?: string | null } }> = [];
    const completed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for WebSocket terminal event.")), 2_000);
      socket.on("message", (data: unknown) => {
        const message = JSON.parse(String(data)) as { type?: string; event?: { type?: string; eventSeq?: number }; session?: { activeTurnId?: string | null } };
        streamed.push(message);
        if (message.type === "event" && message.event?.type === "turn.completed") {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    const turnResponse = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/turns`,
      headers: {
        host: "127.0.0.1:4677",
        cookie: cookie ?? "",
        "x-daoyin-csrf": bootstrap.csrfToken,
        "content-type": "application/json",
      },
      payload: { message: "stream this turn" },
    });
    expect(turnResponse.statusCode).toBe(202);
    await completed;
    socket.close();

    const events = streamed.filter((message) => message.type === "event");
    expect(events.map((message) => message.event?.type)).toEqual(["turn.started", "assistant.delta", "turn.completed"]);
    expect(events.map((message) => message.event?.eventSeq)).toEqual([1, 2, 3]);
    expect(events.at(-1)?.session?.activeTurnId).toBeNull();
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
    expect(bootstrap.health.capabilities.modelGateway).toBe("ready");
    expect(bootstrap.health.capabilities.authentication).toBe("planned");

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
