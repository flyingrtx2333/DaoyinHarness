import { describe, expect, it, vi } from "vitest";
import type { ExecutionIdentity } from "@daoyin/harness-contracts";
import type { ModelClient } from "@daoyin/harness-agent-core";
import { createCloudServer, type CloudServerOptions } from "./app.js";
import { SqliteCloudRepository } from "./sqlite-repository.js";
import type { DurableMemory } from "./memory-policy.js";
import type { CloudRun } from "./repository.js";

// Real Fastify + AgentEngine + SQLite, mocked authentication/platform/model only.
function setup(extra: Partial<CloudServerOptions> = {}) {
  const repository = new SqliteCloudRepository(":memory:");
  const actor: ExecutionIdentity = { actorUserId: "alice", space: { kind: "personal", id: "personal-alice", ownerUserId: "alice" },
    appInstallationId: "story", authorizationId: "grant-alice", billingAccountId: "payer", expiresAt: Date.now() + 120_000,
    permissions: ["agent.use", "memory.read", "memory.write", "memory.share"], allowedTools: [] };
  const complete = vi.fn<ModelClient["complete"]>(async () => ({ kind: "assistant", content: "收到。" }));
  const app = createCloudServer({ repository,
    authenticate: async (bearer) => bearer === "alice" ? actor : bearer === "visitor" ? {
      ...actor, space: { kind: "public", id: "public", audience: "company-public" },
    } : bearer === "no-memory" ? { ...actor, permissions: ["agent.use"] } : null,
    isAuthorizationActive: async () => true,
    resolveProfile: async () => ({ id: "test", version: "1", instructions: "Use confirmed reference data carefully.", tools: [] }),
    createModel: async () => ({ complete }), ...extra });
  return { app, actor, repository, complete, headers: { authorization: "Bearer alice" } };
}
const body = { requestId: "remember", key: "video.style", scope: "personal", kind: "preference", content: "视频用国风，竖屏。", keywords: ["视频", "风格", "竖屏"] };
const base = "/api/v1/cloud/memories";

describe("authenticated memory management and engine integration", () => {
  it("rejects anonymous/public access and forged ownership fields", async () => {
    const f = setup();
    try {
      expect((await f.app.inject({ method: "GET", url: base })).statusCode).toBe(401);
      expect((await f.app.inject({ method: "GET", url: base, headers: { authorization: "Bearer visitor" } })).statusCode).toBe(403);
      const spoofed = await f.app.inject({ method: "POST", url: base, headers: f.headers, payload: { ...body, actorUserId: "bob" } });
      expect(spoofed.statusCode).toBe(400);
      expect(f.repository.memory.list(f.actor).items).toEqual([]);
      expect(f.complete).not.toHaveBeenCalled();
    } finally { await f.app.close(); f.repository.close(); }
  });

  it("reports only capability flags to the BFF without exposing memory content", async () => {
    const f = setup();
    try {
      const available = await f.app.inject({ method: "GET", url: `${base}/capabilities`, headers: f.headers });
      expect(available.statusCode).toBe(200);
      expect(available.json()).toEqual({ enabled: true, canRead: true, canWrite: true, canShare: false,
        sharingTargetCheckAvailable: false, scopes: ["application", "personal"] });
      const restricted = await f.app.inject({ method: "GET", url: `${base}/capabilities`, headers: { authorization: "Bearer no-memory" } });
      expect(restricted.statusCode).toBe(200);
      expect(restricted.json()).toMatchObject({ enabled: true, canRead: false, canWrite: false, canShare: false, scopes: [] });
      const visitor = await f.app.inject({ method: "GET", url: `${base}/capabilities`, headers: { authorization: "Bearer visitor" } });
      expect(visitor.statusCode).toBe(200);
      expect(visitor.json()).toMatchObject({ enabled: false, canRead: false, canWrite: false, canShare: false, scopes: [] });
      expect(available.body).not.toContain(body.content);
      expect(f.complete).not.toHaveBeenCalled();
    } finally { await f.app.close(); f.repository.close(); }
  });

  it("creates a candidate, confirms it, and auto-recalls it in the shared engine with reference receipts", async () => {
    const f = setup();
    try {
      const proposed = await f.app.inject({ method: "POST", url: base, headers: f.headers, payload: body });
      expect(proposed.statusCode).toBe(201);
      const candidate = proposed.json<{ memory: DurableMemory; requiresConfirmation: boolean }>();
      expect(candidate.requiresConfirmation).toBe(true);
      const candidateRead = await f.app.inject({ method: "GET", url: `${base}/${candidate.memory.id}`, headers: f.headers });
      expect(candidateRead.statusCode).toBe(200);
      expect(candidateRead.json<{ memory: DurableMemory }>().memory.state).toBe("pending");
      const absent = await f.app.inject({ method: "POST", url: `${base}/search`, headers: f.headers, payload: { query: "视频" } });
      expect(absent.json<{ hits: unknown[] }>().hits).toEqual([]);
      const confirmed = await f.app.inject({ method: "POST", url: `${base}/${candidate.memory.id}/confirm`, headers: f.headers, payload: { revision: candidate.memory.revision } });
      expect(confirmed.statusCode).toBe(200);
      f.complete.mockImplementation(async (request) => {
        expect(request.systemPrompt.dynamicText).toContain(body.content);
        expect(request.systemPrompt.dynamicText).toContain("UNTRUSTED_CONFIRMED_MEMORIES");
        expect(request.tools).toEqual([]); // No model-facing confirmation, sharing or forgetting tool.
        return { kind: "assistant", content: "已按你的偏好准备。" };
      });
      const created = await f.app.inject({ method: "POST", url: "/api/v1/cloud/sessions", headers: f.headers, payload: {} });
      const sessionId = created.json<{ session: { id: string } }>().session.id;
      const submitted = await f.app.inject({ method: "POST", url: `/api/v1/cloud/sessions/${sessionId}/runs`, headers: f.headers, payload: { requestId: "run", message: "视频风格" } });
      expect(submitted.statusCode).toBe(202);
      const run = submitted.json<{ run: CloudRun }>().run;
      await vi.waitFor(async () => expect((await f.repository.getRun(f.actor, run.id)).status).toBe("completed"));
      const refs = await f.app.inject({ method: "GET", url: `/api/v1/cloud/runs/${run.id}/memories`, headers: f.headers });
      expect(refs.statusCode).toBe(200);
      expect(refs.json<{ references: unknown[] }>().references).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: candidate.memory.id, revision: 2, available: true }),
      ]));
      expect(refs.body).not.toContain(body.content);
      const audit = await f.app.inject({ method: "GET", url: `${base}/${candidate.memory.id}/audit`, headers: f.headers });
      expect(audit.statusCode).toBe(200);
      expect(audit.json<{ items: { action: string }[] }>().items.map((item) => item.action)).toEqual(expect.arrayContaining(["proposed", "confirmed"]));
      expect(audit.body).not.toContain(body.content);
      const deniedRefs = await f.app.inject({ method: "GET", url: `/api/v1/cloud/runs/${run.id}/memories`, headers: { authorization: "Bearer no-memory" } });
      expect(deniedRefs.statusCode).toBe(403);
    } finally { await f.app.close(); f.repository.close(); }
  });

  it("does not share until a platform-owned target installation check exists", async () => {
    const f = setup();
    try {
      const candidate = f.repository.memory.propose(f.actor, { ...body, scope: "personal", kind: "preference" });
      const record = f.repository.memory.confirm(f.actor, candidate.id, candidate.revision);
      const response = await f.app.inject({ method: "POST", url: `${base}/${record.id}/shares`, headers: f.headers,
        payload: { revision: record.revision, targetAppId: "youji", expiresAt: Date.now() + 60_000 } });
      expect(response.statusCode).toBe(503);
      expect(f.repository.memory.shares(f.actor, record.id)).toEqual([]);
    } finally { await f.app.close(); f.repository.close(); }
  });

  it("validates the target before sharing, and makes revocation persistent", async () => {
    const checker = vi.fn(async (_identity: ExecutionIdentity, target: string) => target === "youji");
    const f = setup({ authorizeMemoryShare: checker });
    try {
      const candidate = f.repository.memory.propose(f.actor, { ...body, scope: "personal", kind: "preference" });
      const record = f.repository.memory.confirm(f.actor, candidate.id, candidate.revision);
      const payload = { revision: record.revision, targetAppId: "youji", expiresAt: Date.now() + 60_000 };
      expect((await f.app.inject({ method: "POST", url: `${base}/${record.id}/shares`, headers: f.headers, payload: { ...payload, targetAppId: "foreign" } })).statusCode).toBe(403);
      const shared = await f.app.inject({ method: "POST", url: `${base}/${record.id}/shares`, headers: f.headers, payload });
      expect(shared.statusCode).toBe(200);
      const shareId = shared.json<{ share: { id: string } }>().share.id;
      expect(checker).toHaveBeenCalledTimes(2);
      expect((await f.app.inject({ method: "POST", url: `${base}/shares/${shareId}/revoke`, headers: f.headers, payload: {} })).statusCode).toBe(200);
      expect(f.repository.memory.shares(f.actor, record.id)[0]?.revoked).toBe(true);
      expect(f.complete).not.toHaveBeenCalled();
    } finally { await f.app.close(); f.repository.close(); }
  });
});
