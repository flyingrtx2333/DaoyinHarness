import { setTimeout as delay } from "node:timers/promises";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutionIdentity } from "@daoyin/harness-contracts";
import type { AgentEvent } from "@daoyin/harness-protocol";
import type { ModelClient, ModelReply, ModelRequest } from "@daoyin/harness-agent-core";
import type { ToolSuccess } from "@daoyin/harness-tools/registry";
import { createCloudServer, type CloudProfile, type CloudServerOptions, type CloudToolBinding } from "./app.js";
import type { CloudRun } from "./repository.js";
import { SqliteCloudRepository } from "./sqlite-repository.js";

const resources: { app: FastifyInstance; repository: SqliteCloudRepository }[] = [];
function identity(overrides: Partial<ExecutionIdentity> = {}): ExecutionIdentity {
  return {
    actorUserId: "alice", space: { kind: "organization", id: "space-a", tenantId: "tenant-a" },
    appInstallationId: "portal-a", authorizationId: "grant-a", billingAccountId: "wallet-a",
    expiresAt: Date.now() + 60_000, permissions: ["agent.use", "public.read"], allowedTools: ["public_lookup"],
    ...overrides,
  };
}
function binding(name = "public_lookup") {
  const execute = vi.fn(async (): Promise<ToolSuccess> => ({ ok: true, summary: "查到公开资料", evidence: {
    schemaVersion: 1, toolName: name, result: { text: "fixture knowledge" }, artifacts: [], diagnostics: [],
  } }));
  const tool: CloudToolBinding = {
    definition: { name, description: "查询测试知识", inputSchema: { type: "object", additionalProperties: false, properties: {} },
      category: "extension", mutating: false, execute },
    requiredPermissions: ["public.read"], validateInput: (input) => Object.keys(input).length === 0,
    authorizeResource: async () => true,
  };
  return { tool, execute };
}
function fixture(overrides: Partial<Omit<CloudServerOptions, "repository">> = {}) {
  const repository = new SqliteCloudRepository(":memory:");
  const owner = identity();
  const tokens = new Map<string, ExecutionIdentity>([
    ["owner", owner], ["bob", identity({ actorUserId: "bob" })],
    ["tenant-b", identity({ space: { kind: "organization", id: "space-a", tenantId: "tenant-b" } })],
    ["app-b", identity({ appInstallationId: "story-b" })],
    ["expired", identity({ expiresAt: Date.now() - 1 })], ["no-access", identity({ permissions: [] })],
  ]);
  const profile: CloudProfile = { id: "public-portal", version: "1", instructions: "只回答公开资料。", tools: [] };
  const complete = vi.fn<ModelClient["complete"]>(async () => ({ kind: "assistant", content: "测试回复" }));
  const app = createCloudServer({
    repository, authenticate: async (token) => tokens.get(token) ?? null, isAuthorizationActive: async () => true,
    resolveProfile: async () => profile, createModel: async () => ({ complete }), ...overrides,
  });
  resources.push({ app, repository });
  return { app, repository, owner, tokens, profile, complete };
}
const headers = (token = "owner") => ({ authorization: `Bearer ${token}` });
async function createSession(app: FastifyInstance): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/api/v1/cloud/sessions", headers: headers(), payload: { title: "测试会话" } });
  expect(response.statusCode).toBe(201);
  return response.json<{ session: { id: string } }>().session.id;
}
async function submit(app: FastifyInstance, sessionId: string, requestId = "request-1", message = "介绍道引") {
  return app.inject({ method: "POST", url: `/api/v1/cloud/sessions/${sessionId}/runs`, headers: headers(), payload: { requestId, message } });
}
async function terminal(repository: SqliteCloudRepository, owner: ExecutionIdentity, runId: string): Promise<CloudRun> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await repository.getRun(owner, runId);
    if (result.status !== "running") return result;
    await delay(5);
  }
  throw new Error("Fixture run did not reach a terminal state.");
}
afterEach(async () => {
  for (const { app, repository } of resources.splice(0)) {
    await app.close();
    repository.close();
  }
});

describe("cloud HTTP vertical slice (real API/core/SQLite; mocked auth, model and business I/O)", () => {
  it("uses the shared AgentEngine, persists tool evidence and supports cursor replay", async () => {
    const lookup = binding();
    const seen: ModelRequest[] = [];
    const model: ModelClient = { complete: async (request) => {
      seen.push(request);
      return seen.length === 1
        ? { kind: "tool_calls", calls: [{ id: "lookup-1", name: "public_lookup", input: {} }] }
        : { kind: "assistant", content: "根据资料完成回答。" };
    } };
    const current = fixture({ resolveProfile: async () => ({ id: "portal", version: "1", instructions: "查公开资料。", tools: [lookup.tool] }), createModel: async () => model });
    const sessionId = await createSession(current.app);
    const accepted = await submit(current.app, sessionId);
    expect(accepted.statusCode).toBe(202);
    const runId = accepted.json<{ run: CloudRun }>().run.id;
    expect(await terminal(current.repository, current.owner, runId)).toMatchObject({ status: "completed", finalText: "根据资料完成回答。" });
    expect(lookup.execute).toHaveBeenCalledOnce();
    expect(seen[0]?.tools.map((tool) => tool.name)).toEqual(["public_lookup"]);
    expect(seen[1]?.messages.some((message) => message.role === "tool" && message.content.includes("fixture knowledge"))).toBe(true);
    const response = await current.app.inject({ method: "GET", url: `/api/v1/cloud/sessions/${sessionId}/events?after=1`, headers: headers() });
    expect(response.statusCode).toBe(200);
    const events = response.json<{ events: AgentEvent[] }>().events;
    expect(events.map((event) => event.type)).toEqual(["tool.started", "tool.completed", "assistant.delta", "turn.completed"]);
    expect(events[0]?.eventSeq).toBe(2);
    const repeated = await submit(current.app, sessionId);
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json<{ run: CloudRun; reused: boolean }>()).toMatchObject({ run: { id: runId }, reused: true });
    expect(seen).toHaveLength(2);
  });

  it("waits for a persisted video confirmation and only permits the exact confirmed generation input", async () => {
    const input = { modelName: "Seedance", resolution: "720p", durationSeconds: 10, prompt: "雨中追逐",
      aspectRatio: "16:9", target: "new", request_key: "request_video_001" };
    const execute = vi.fn(async (): Promise<ToolSuccess> => ({ ok: true, summary: "视频任务已创建",
      evidence: { schemaVersion: 1, toolName: "story_create_video", result: { video_id: "video-1" }, artifacts: [], diagnostics: [] } }));
    const video: CloudToolBinding = { definition: { name: "story_create_video", description: "创建视频",
      inputSchema: { type: "object" }, category: "extension", mutating: true, execute }, requiredPermissions: ["story.generate"],
      validateInput: (value) => JSON.stringify(value) === JSON.stringify(input), authorizeResource: async () => true };
    let call = 0;
    const current = fixture({ resolveProfile: async () => ({ id: "story-quick", version: "1", instructions: "创建视频前确认。", tools: [video] }),
      createModel: async () => ({ complete: async (request) => {
        call += 1;
        if (call === 1) {
          expect(request.tools.map((tool) => tool.name)).toContain("request_video_confirmation");
          expect(request.systemPrompt.stableText + request.systemPrompt.dynamicText).toContain("生成一段高燃混剪视频");
          expect(request.systemPrompt.stableText + request.systemPrompt.dynamicText).toContain("720p、10 秒、16:9");
          return { kind: "tool_calls", calls: [{ id: "confirm-1", name: "request_video_confirmation",
            input: { operation: "story_create_video", input } }] };
        }
        if (call === 2) return { kind: "tool_calls", calls: [{ id: "create-1", name: "story_create_video", input }] };
        return { kind: "assistant", content: "视频任务已提交。" };
      } }) });
    current.tokens.set("owner", identity({ permissions: ["agent.use", "story.generate"], allowedTools: ["story_create_video"] }));
    const sessionId = await createSession(current.app);
    const accepted = await submit(current.app, sessionId, "video-request", "帮我生成追逐视频");
    const runId = accepted.json<{ run: CloudRun }>().run.id;
    let requested: Extract<AgentEvent, { type: "interaction.requested" }> | undefined;
    for (let attempt = 0; attempt < 100 && requested === undefined; attempt += 1) {
      requested = (await current.repository.readEvents(current.tokens.get("owner")!, sessionId, 0, 100))
        .find((event): event is Extract<AgentEvent, { type: "interaction.requested" }> => event.type === "interaction.requested");
      if (requested === undefined) await delay(5);
    }
    expect(requested).toBeDefined();
    expect(execute).not.toHaveBeenCalled();
    const response = await current.app.inject({ method: "POST",
      url: `/api/v1/cloud/runs/${runId}/interactions/${requested!.payload.interactionId}/respond`, headers: headers(),
      payload: { resolution: "confirmed", input } });
    expect(response.statusCode).toBe(200);
    expect((await terminal(current.repository, current.tokens.get("owner")!, runId)).status).toBe("completed");
    expect(execute).toHaveBeenCalledOnce();
    expect((await current.repository.readEvents(current.tokens.get("owner")!, sessionId, 0, 100)).map((event) => event.type))
      .toEqual(["turn.started", "tool.started", "interaction.requested", "interaction.resolved", "tool.completed",
        "tool.started", "tool.completed", "assistant.delta", "turn.completed"]);
  });

  it("denies a video generation tool call when the model skips user confirmation", async () => {
    const execute = vi.fn(async (): Promise<ToolSuccess> => ({ ok: true, summary: "不应执行",
      evidence: { schemaVersion: 1, toolName: "story_create_video", result: {}, artifacts: [], diagnostics: [] } }));
    const video: CloudToolBinding = { definition: { name: "story_create_video", description: "创建视频",
      inputSchema: { type: "object" }, category: "extension", mutating: true, execute }, requiredPermissions: ["story.generate"],
      validateInput: () => true, authorizeResource: async () => true };
    let call = 0;
    const current = fixture({ resolveProfile: async () => ({ id: "story-quick", version: "1", instructions: "创建视频前确认。", tools: [video] }),
      createModel: async () => ({ complete: async () => ++call === 1
        ? { kind: "tool_calls", calls: [{ id: "create", name: "story_create_video", input: { prompt: "skip" } }] }
        : { kind: "assistant", content: "未提交。" } }) });
    current.tokens.set("owner", identity({ permissions: ["agent.use", "story.generate"], allowedTools: ["story_create_video"] }));
    const sessionId = await createSession(current.app);
    const accepted = await submit(current.app, sessionId, "skip-confirm", "生成视频");
    await terminal(current.repository, current.tokens.get("owner")!, accepted.json<{ run: CloudRun }>().run.id);
    expect(execute).not.toHaveBeenCalled();
  });

  it("requires real adapter authentication and rejects bearer/expiry/origin/entitlement failures", async () => {
    const { app, complete } = fixture();
    for (const token of ["unknown", "expired"]) {
      const response = await app.inject({ method: "GET", url: "/api/v1/cloud/sessions", headers: headers(token) });
      expect(response.statusCode).toBe(401);
    }
    expect((await app.inject({ method: "GET", url: "/api/v1/cloud/sessions" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/v1/cloud/sessions", headers: headers("no-access") })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/v1/cloud/sessions", headers: { ...headers(), origin: "https://untrusted.example" } })).statusCode).toBe(403);
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects identity fields in HTTP bodies instead of silently stripping them", async () => {
    const { app, complete } = fixture();
    expect((await app.inject({ method: "POST", url: "/api/v1/cloud/sessions", headers: headers(), payload: { title: "spoof", tenant_id: "tenant-b" } })).statusCode).toBe(400);
    const sessionId = await createSession(app);
    expect((await app.inject({ method: "POST", url: `/api/v1/cloud/sessions/${sessionId}/runs`, headers: headers(),
      payload: { requestId: "spoof", message: "hello", executionIdentity: identity({ actorUserId: "bob" }) } })).statusCode).toBe(400);
    expect(complete).not.toHaveBeenCalled();
  });

  it.each(["bob", "tenant-b", "app-b"])("does not expose an owner's session/run/events to %s", async (token) => {
    const { app, repository, owner } = fixture();
    const sessionId = await createSession(app);
    const accepted = await submit(app, sessionId);
    const runId = accepted.json<{ run: CloudRun }>().run.id;
    await terminal(repository, owner, runId);
    for (const url of [`/api/v1/cloud/sessions/${sessionId}`, `/api/v1/cloud/sessions/${sessionId}/events`, `/api/v1/cloud/runs/${runId}`]) {
      expect((await app.inject({ method: "GET", url, headers: headers(token) })).statusCode).toBe(404);
    }
    expect((await app.inject({ method: "POST", url: `/api/v1/cloud/runs/${runId}/cancel`, headers: headers(token), payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/v1/cloud/sessions/${sessionId}/runs`, headers: headers(token),
      payload: { requestId: "other", message: "read" } })).statusCode).toBe(404);
  });

  it("returns the original request under full capacity, rejects changed content, and cancels an uncooperative model", async () => {
    let resolveModel: ((reply: ModelReply) => void) | undefined;
    const pending = new Promise<ModelReply>((resolve) => { resolveModel = resolve; });
    const complete = vi.fn(async () => pending);
    const current = fixture({ maxConcurrentRuns: 1, createModel: async () => ({ complete }) });
    const sessionId = await createSession(current.app);
    const accepted = await submit(current.app, sessionId);
    const runId = accepted.json<{ run: CloudRun }>().run.id;
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    const repeated = await submit(current.app, sessionId);
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json<{ run: CloudRun }>().run.id).toBe(runId);
    expect((await submit(current.app, sessionId, "request-1", "changed")).statusCode).toBe(409);
    expect((await submit(current.app, sessionId, "request-2", "new")).statusCode).toBe(429);
    expect((await current.app.inject({ method: "POST", url: `/api/v1/cloud/runs/${runId}/cancel`, headers: headers(), payload: {} })).statusCode).toBe(200);
    expect((await terminal(current.repository, current.owner, runId)).status).toBe("cancelled");
    resolveModel?.({ kind: "assistant", content: "LATE_SUCCESS_MUST_NOT_APPEAR" });
    await delay(10);
    expect(JSON.stringify(await current.repository.readEvents(current.owner, sessionId, 0, 100))).not.toContain("LATE_SUCCESS_MUST_NOT_APPEAR");
    expect(complete).toHaveBeenCalledOnce();
  });

  it("does not execute a hidden tool even if a model guesses its name", async () => {
    const hidden = binding("private_lookup");
    let calls = 0;
    const model: ModelClient = { complete: async (request) => {
      expect(request.tools).toEqual([]);
      calls += 1;
      return calls === 1 ? { kind: "tool_calls", calls: [{ id: "attack", name: "private_lookup", input: {} }] }
        : { kind: "assistant", content: "无权访问。" };
    } };
    const current = fixture({ resolveProfile: async () => ({ id: "portal", version: "1", instructions: "只读。", tools: [hidden.tool] }), createModel: async () => model });
    const sessionId = await createSession(current.app);
    const accepted = await submit(current.app, sessionId);
    await terminal(current.repository, current.owner, accepted.json<{ run: CloudRun }>().run.id);
    expect(hidden.execute).not.toHaveBeenCalled();
    expect(await current.repository.readEvents(current.owner, sessionId, 0, 100)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool.failed", payload: expect.objectContaining({ code: "TOOL_ACCESS_DENIED" }) }),
    ]));
  });

  it("rechecks revocation after model completion before any business tool is invoked", async () => {
    let revoked = false;
    const lookup = binding();
    const current = fixture({ isAuthorizationActive: async () => !revoked,
      resolveProfile: async () => ({ id: "portal", version: "1", instructions: "只读。", tools: [lookup.tool] }),
      createModel: async () => ({ complete: async () => { revoked = true; return { kind: "tool_calls", calls: [{ id: "call", name: "public_lookup", input: {} }] }; } }),
    });
    const sessionId = await createSession(current.app);
    const accepted = await submit(current.app, sessionId);
    expect((await terminal(current.repository, current.owner, accepted.json<{ run: CloudRun }>().run.id)).status).toBe("failed");
    expect(lookup.execute).not.toHaveBeenCalled();
    expect((await current.app.inject({ method: "GET", url: `/api/v1/cloud/sessions/${sessionId}`, headers: headers() })).statusCode).toBe(403);
  });

  it("keeps business resource authorization mandatory after tool-name authorization", async () => {
    const lookup = binding();
    const authorizeResource = vi.fn(async () => false);
    let calls = 0;
    const current = fixture({ resolveProfile: async () => ({ id: "portal", version: "1", instructions: "只读。", tools: [{ ...lookup.tool, authorizeResource }] }),
      createModel: async () => ({ complete: async () => ++calls === 1
        ? { kind: "tool_calls", calls: [{ id: "call", name: "public_lookup", input: {} }] }
        : { kind: "assistant", content: "此资源未获授权。" } }),
    });
    const sessionId = await createSession(current.app);
    const accepted = await submit(current.app, sessionId);
    await terminal(current.repository, current.owner, accepted.json<{ run: CloudRun }>().run.id);
    expect(authorizeResource).toHaveBeenCalledOnce();
    expect(lookup.execute).not.toHaveBeenCalled();
  });

  it("rejects mutating profiles rather than mounting local or paid execution paths", async () => {
    const lookup = binding();
    const { app, complete } = fixture({ resolveProfile: async () => ({ id: "unsafe", version: "1", instructions: "unsafe", tools: [
      { ...lookup.tool, definition: { ...lookup.tool.definition, mutating: true } },
    ] }) });
    const response = await app.inject({ method: "POST", url: "/api/v1/cloud/sessions", headers: headers(), payload: {} });
    expect(response.statusCode).toBe(503);
    expect(complete).not.toHaveBeenCalled();
  });

  it("admits only explicitly reviewed Story mutations with their exact permission", async () => {
    const production = binding("story_create_production");
    const reviewed = { ...production.tool, requiredPermissions: ["story.generate"],
      definition: { ...production.tool.definition, mutating: true } };
    const allowed = fixture({ resolveProfile: async () => ({ id: "daoyin-workbench", version: "1",
      instructions: "按账号权限制作短剧。", tools: [reviewed] }) });
    expect((await allowed.app.inject({ method: "POST", url: "/api/v1/cloud/sessions",
      headers: headers(), payload: {} })).statusCode).toBe(201);

    const denied = fixture({ resolveProfile: async () => ({ id: "daoyin-workbench", version: "1",
      instructions: "按账号权限制作短剧。", tools: [{ ...reviewed, requiredPermissions: ["story.write"] }] }) });
    const response = await denied.app.inject({ method: "POST", url: "/api/v1/cloud/sessions",
      headers: headers(), payload: {} });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "PROFILE_TOOL_INVALID" } });
  });

  it("never persists a raw provider exception", async () => {
    const current = fixture({ createModel: async () => ({ complete: async () => { throw new Error("DO_NOT_PERSIST_PROVIDER_SECRET"); } }) });
    const sessionId = await createSession(current.app);
    const accepted = await submit(current.app, sessionId);
    const result = await terminal(current.repository, current.owner, accepted.json<{ run: CloudRun }>().run.id);
    expect(result.status).toBe("failed");
    expect(result.finalText).toContain("模型服务本次未完成响应");
    expect(result.finalText).not.toContain("授权不可用");
    expect(JSON.stringify(result)).not.toContain("DO_NOT_PERSIST_PROVIDER_SECRET");
    const events = await current.repository.readEvents(current.owner, sessionId, 0, 100);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "turn.failed", payload: expect.objectContaining({ code: "MODEL_PROVIDER_REQUEST_FAILED" }) }),
    ]));
    expect(JSON.stringify(events)).not.toContain("DO_NOT_PERSIST_PROVIDER_SECRET");
  });

  it("allows reading old records but prevents silently replacing a session's profile", async () => {
    let version = "1";
    const current = fixture({ resolveProfile: async () => ({ id: "portal", version, instructions: "公开资料", tools: [] }) });
    const sessionId = await createSession(current.app);
    const accepted = await submit(current.app, sessionId);
    const runId = accepted.json<{ run: CloudRun }>().run.id;
    await terminal(current.repository, current.owner, runId);
    version = "2";
    expect((await submit(current.app, sessionId)).statusCode).toBe(200);
    const changed = await submit(current.app, sessionId, "request-2", "next");
    expect(changed.statusCode).toBe(409);
    expect(changed.json<{ error: { code: string } }>().error.code).toBe("PROFILE_CHANGED");
    expect((await current.app.inject({ method: "GET", url: `/api/v1/cloud/sessions/${sessionId}`, headers: headers() })).statusCode).toBe(200);
  });
});
