import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ModelClient } from "@daoyin/harness-agent-core";
import type { McpClientFactory } from "@daoyin/harness-mcp";
import type { RuntimeBootstrap, SessionEventsResponse, SessionSearchResponse } from "@daoyin/harness-protocol";
import { JsonlSessionStore, JsonSessionCatalog } from "@daoyin/harness-workspace";
import { createApp, type HarnessAuthentication } from "./app.js";

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
  it("starts and completes Daoyin account login through the server-owned OAuth callback", async () => {
    let signedIn = false;
    const authentication: HarnessAuthentication = {
      status: () => signedIn
        ? { status: "signed_in", account: { id: 7, userName: "tester", tenantId: 3 } }
        : { status: "signed_out", account: null },
      beginAuthorization: () => ({ authorizationUrl: "https://www.daoyintech.com/api/oauth/authorize?state=test" }),
      async completeAuthorization(code, state) {
        expect(code).toBe("code-1");
        expect(state).toBe("state-1");
        signedIn = true;
        return { id: 7, userName: "tester", tenantId: 3 };
      },
      async logout() { signedIn = false; },
    };
    app = await createApp({
      port: 4677, version: "0.1.0", startedAt: "2026-09-04T00:00:00.000Z",
      authentication,
      model: { async complete() { return { kind: "assistant", content: "ok" }; } },
    });
    const bootstrapResponse = await app.inject({ method: "GET", url: "/api/v1/bootstrap", headers: { host: "127.0.0.1:4677" } });
    const bootstrap = bootstrapResponse.json<RuntimeBootstrap>();
    const setCookie = bootstrapResponse.headers["set-cookie"];
    const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(bootstrap.authentication.status).toBe("signed_out");
    expect(bootstrap.health.capabilities.authentication).toBe("ready");
    expect(bootstrap.health.capabilities.modelGateway).toBe("unavailable");

    const start = await app.inject({
      method: "POST", url: "/api/v1/auth/login",
      headers: { host: "127.0.0.1:4677", cookie: cookie ?? "", "x-daoyin-csrf": bootstrap.csrfToken },
      payload: {},
    });
    expect(start.statusCode).toBe(200);
    expect(start.json()).toEqual({ authorizationUrl: "https://www.daoyintech.com/api/oauth/authorize?state=test" });

    const callback = await app.inject({
      method: "GET", url: "/api/v1/auth/callback?code=code-1&state=state-1",
      headers: { host: "127.0.0.1:4677" },
    });
    expect(callback.statusCode).toBe(200);
    expect(callback.body).toContain("登录成功");
    const signedInBootstrap = await app.inject({ method: "GET", url: "/api/v1/bootstrap", headers: { host: "127.0.0.1:4677" } });
    expect(signedInBootstrap.json<RuntimeBootstrap>().authentication).toEqual({
      status: "signed_in", account: { id: 7, userName: "tester", tenantId: 3 },
    });
    expect(signedInBootstrap.json<RuntimeBootstrap>().health.capabilities.modelGateway).toBe("ready");
  });

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

  it("forks only at a safe terminal boundary, inherits source dialogue, and searches persisted session evidence", async () => {
    const dataDir = await temporaryDirectory("daoyin-server-fork-data-");
    const workspaceRoot = await temporaryDirectory("daoyin-server-fork-workspace-");
    const modelMessages: string[][] = [];
    const model: ModelClient = {
      async complete(request) {
        modelMessages.push(request.messages.map((message) => message.content));
        return { kind: "assistant", content: modelMessages.length === 1 ? "source immutable marker" : "branch continuation marker" };
      },
    };
    app = await createApp({ port: 4677, version: "0.1.0", startedAt: new Date().toISOString(), dataDir, workspaceRoot, model });
    const bootstrapResponse = await app.inject({ method: "GET", url: "/api/v1/bootstrap", headers: { host: "127.0.0.1:4677" } });
    const bootstrap = bootstrapResponse.json<RuntimeBootstrap>();
    const setCookie = bootstrapResponse.headers["set-cookie"];
    const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const writeHeaders = { host: "127.0.0.1:4677", cookie: cookie ?? "", "x-daoyin-csrf": bootstrap.csrfToken, "content-type": "application/json" };

    const createResponse = await app.inject({ method: "POST", url: "/api/v1/sessions", headers: writeHeaders, payload: { title: "Fork source" } });
    const sourceId = createResponse.json<{ session: { id: string } }>().session.id;
    await app.inject({ method: "POST", url: `/api/v1/sessions/${sourceId}/turns`, headers: writeHeaders, payload: { message: "remember source question" } });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const replay = await app.inject({ method: "GET", url: `/api/v1/sessions/${sourceId}/events?after=0`, headers: { host: "127.0.0.1:4677" } });
      if (replay.json<SessionEventsResponse>().events.some((event) => event.type === "turn.completed")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const searchResponse = await app.inject({ method: "GET", url: "/api/v1/sessions/search?q=immutable%20marker", headers: { host: "127.0.0.1:4677" } });
    expect(searchResponse.statusCode).toBe(200);
    expect(searchResponse.json<SessionSearchResponse>().hits[0]).toMatchObject({ session: { id: sourceId }, matchedText: expect.stringContaining("source immutable marker") });

    const forkResponse = await app.inject({ method: "POST", url: `/api/v1/sessions/${sourceId}/forks`, headers: writeHeaders, payload: {} });
    expect(forkResponse.statusCode).toBe(201);
    const fork = forkResponse.json<import("@daoyin/harness-protocol").ForkSessionResponse>();
    expect(fork.sourceEventSeq).toBe(3);
    expect(fork.session.forkedFrom).toEqual({ sourceSessionId: sourceId, sourceEventSeq: 3 });

    await app.inject({ method: "POST", url: `/api/v1/sessions/${fork.session.id}/turns`, headers: writeHeaders, payload: { message: "continue from inherited context" } });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const replay = await app.inject({ method: "GET", url: `/api/v1/sessions/${fork.session.id}/events?after=0`, headers: { host: "127.0.0.1:4677" } });
      if (replay.json<SessionEventsResponse>().events.some((event) => event.type === "turn.completed")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(modelMessages[1]).toEqual(expect.arrayContaining(["remember source question", "source immutable marker", "continue from inherited context"]));
    const branchReplay = await app.inject({ method: "GET", url: `/api/v1/sessions/${fork.session.id}/events?after=0`, headers: { host: "127.0.0.1:4677" } });
    expect(branchReplay.json<SessionEventsResponse>().events.map((event) => event.eventSeq)).toEqual([1, 2, 3]);
    const sourceReplay = await app.inject({ method: "GET", url: `/api/v1/sessions/${sourceId}/events?after=0`, headers: { host: "127.0.0.1:4677" } });
    expect(sourceReplay.json<SessionEventsResponse>().events.map((event) => event.eventSeq)).toEqual([1, 2, 3]);
  });

  it("continues sessions through fork ancestries deeper than eight levels", async () => {
    const dataDir = await temporaryDirectory("daoyin-server-deep-fork-data-");
    const workspaceRoot = await temporaryDirectory("daoyin-server-deep-fork-workspace-");
    const modelMessages: string[][] = [];
    const model: ModelClient = {
      async complete(request) {
        modelMessages.push(request.messages.map((message) => message.content));
        return { kind: "assistant", content: modelMessages.length === 1 ? "root answer" : "deep branch answer" };
      },
    };
    app = await createApp({ port: 4677, version: "0.1.0", startedAt: new Date().toISOString(), dataDir, workspaceRoot, model });
    const bootstrapResponse = await app.inject({ method: "GET", url: "/api/v1/bootstrap", headers: { host: "127.0.0.1:4677" } });
    const bootstrap = bootstrapResponse.json<RuntimeBootstrap>();
    const setCookie = bootstrapResponse.headers["set-cookie"];
    const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const writeHeaders = { host: "127.0.0.1:4677", cookie: cookie ?? "", "x-daoyin-csrf": bootstrap.csrfToken, "content-type": "application/json" };

    const createResponse = await app.inject({ method: "POST", url: "/api/v1/sessions", headers: writeHeaders, payload: { title: "Deep fork root" } });
    const rootId = createResponse.json<{ session: { id: string } }>().session.id;
    await app.inject({ method: "POST", url: `/api/v1/sessions/${rootId}/turns`, headers: writeHeaders, payload: { message: "root question" } });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const replay = await app.inject({ method: "GET", url: `/api/v1/sessions/${rootId}/events?after=0`, headers: { host: "127.0.0.1:4677" } });
      if (replay.json<SessionEventsResponse>().events.some((event) => event.type === "turn.completed")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    let deepestSessionId = rootId;
    for (let depth = 0; depth < 12; depth += 1) {
      const forkResponse = await app.inject({ method: "POST", url: `/api/v1/sessions/${deepestSessionId}/forks`, headers: writeHeaders, payload: {} });
      expect(forkResponse.statusCode).toBe(201);
      deepestSessionId = forkResponse.json<import("@daoyin/harness-protocol").ForkSessionResponse>().session.id;
    }

    const deepTurnResponse = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${deepestSessionId}/turns`,
      headers: writeHeaders,
      payload: { message: "continue after many forks" },
    });
    expect(deepTurnResponse.statusCode).toBe(202);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const replay = await app.inject({ method: "GET", url: `/api/v1/sessions/${deepestSessionId}/events?after=0`, headers: { host: "127.0.0.1:4677" } });
      if (replay.json<SessionEventsResponse>().events.some((event) => event.type === "turn.completed")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(modelMessages[1]).toEqual(expect.arrayContaining(["root question", "root answer", "continue after many forks"]));
  });

  it("reconciles a crash-stale active turn by appending an interrupted event without erasing tool evidence", async () => {
    const dataDir = await temporaryDirectory("daoyin-server-resume-data-");
    const workspaceRoot = await temporaryDirectory("daoyin-server-resume-workspace-");
    const catalog = new JsonSessionCatalog(join(dataDir, "state"));
    const events = new JsonlSessionStore(join(dataDir, "transcripts"));
    const session = await catalog.create("Crash recovery");
    const turnId = "turn_crashed";
    // Seed a prior run in this actual workspace; a foreign scope must remain rejected.
    const scopeId = `resource_${createHash("sha256").update(await realpath(workspaceRoot)).digest("hex").slice(0, 24)}`;
    await events.append({ type: "turn.started", accountId: "local", scopeId, sessionId: session.id, turnId, payload: { status: "running", userMessageId: "msg_crashed", userMessage: "perform crash-prone work" } });
    await events.append({ type: "tool.started", accountId: "local", scopeId, sessionId: session.id, turnId, payload: { toolCallId: "call_read", toolName: "read_file", displayText: "reading evidence", input: { path: "evidence.txt" } } });
    await events.append({ type: "tool.completed", accountId: "local", scopeId, sessionId: session.id, turnId, payload: { toolCallId: "call_read", toolName: "read_file", summary: "persisted evidence survives", evidence: { schemaVersion: 1, toolName: "read_file", result: { text: "safe" }, artifacts: [], diagnostics: [] } } });
    await catalog.update(session.id, { activeTurnId: turnId, lastEventSeq: 3, updatedAt: new Date().toISOString() });

    let recoveryPrompt = "";
    const model: ModelClient = { async complete(request) { recoveryPrompt = request.messages[0]?.content ?? ""; return { kind: "assistant", content: "recovered continuation" }; } };
    app = await createApp({ port: 4677, version: "0.1.0", startedAt: new Date().toISOString(), dataDir, workspaceRoot, model });
    const bootstrapResponse = await app.inject({ method: "GET", url: "/api/v1/bootstrap", headers: { host: "127.0.0.1:4677" } });
    const bootstrap = bootstrapResponse.json<RuntimeBootstrap>();
    const setCookie = bootstrapResponse.headers["set-cookie"];
    const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const writeHeaders = { host: "127.0.0.1:4677", cookie: cookie ?? "", "x-daoyin-csrf": bootstrap.csrfToken, "content-type": "application/json" };

    const resumeResponse = await app.inject({ method: "POST", url: `/api/v1/sessions/${session.id}/resume`, headers: writeHeaders, payload: {} });
    expect(resumeResponse.statusCode).toBe(200);
    expect(resumeResponse.json<import("@daoyin/harness-protocol").ResumeSessionResponse>()).toMatchObject({ interruptedTurnId: turnId, interruptionEventSeq: 4, session: { activeTurnId: null, lastEventSeq: 4 } });
    const recoveredReplay = await app.inject({ method: "GET", url: `/api/v1/sessions/${session.id}/events?after=0`, headers: { host: "127.0.0.1:4677" } });
    expect(recoveredReplay.json<SessionEventsResponse>().events.map((event) => event.type)).toEqual(["turn.started", "tool.started", "tool.completed", "turn.interrupted"]);

    const continueResponse = await app.inject({ method: "POST", url: `/api/v1/sessions/${session.id}/turns`, headers: writeHeaders, payload: { message: "continue safely" } });
    expect(continueResponse.statusCode, continueResponse.body).toBe(202);
    let continuationEvents: SessionEventsResponse["events"] = [];
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const replay = await app.inject({ method: "GET", url: `/api/v1/sessions/${session.id}/events?after=4`, headers: { host: "127.0.0.1:4677" } });
      continuationEvents = replay.json<SessionEventsResponse>().events;
      if (continuationEvents.some((event) => event.type === "turn.completed" || event.type === "turn.failed")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(continuationEvents, JSON.stringify(continuationEvents)).toEqual(expect.arrayContaining([expect.objectContaining({ type: "turn.completed" })]));
    expect(recoveryPrompt).toContain("Earlier turns were interrupted");
    expect(recoveryPrompt).toContain("persisted evidence survives");
  });
});
