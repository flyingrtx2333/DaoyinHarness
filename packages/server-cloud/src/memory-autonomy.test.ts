import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ExecutionIdentity } from "@daoyin/harness-contracts";
import type { ModelClient } from "@daoyin/harness-agent-core";
import { createCloudServer, type CloudServerOptions } from "./app.js";
import { SqliteCloudRepository } from "./sqlite-repository.js";
import type { CloudRun } from "./repository.js";
import type { MemoryProposal } from "./memory-policy.js";
import { MEMORY_TOOL_NAMES } from "./memory-agent-policy.js";
import { validateMemoryToolInput } from "./memory-tools.js";

// Real HTTP injection, engine, tool registry and temporary SQLite; only identity/model/business responses are mocked.
function fixture(options: { database?: string; actor?: Partial<ExecutionIdentity>; extra?: Partial<CloudServerOptions> } = {}) {
  const repository = new SqliteCloudRepository(options.database ?? ":memory:");
  const actor: ExecutionIdentity = { actorUserId: "alice", space: { kind: "personal", id: "personal-alice", ownerUserId: "alice" },
    appInstallationId: "harness", authorizationId: "grant-alice", billingAccountId: "payer", expiresAt: Date.now() + 120_000,
    permissions: ["agent.use", "data.read", "memory.read", "memory.write"], allowedTools: ["data_probe", ...MEMORY_TOOL_NAMES], ...options.actor };
  const complete = vi.fn<ModelClient["complete"]>(async () => ({ kind: "assistant", content: "处理完成。" }));
  const business = vi.fn(async () => ({ ok: true as const, summary: "业务读取完成", evidence: {
    schemaVersion: 1 as const, toolName: "data_probe", result: { finding: "validated_project_rule_zeta" }, artifacts: [], diagnostics: [],
  } }));
  const app = createCloudServer({ repository, authenticate: async (bearer) => bearer === "alice" ? actor
    : bearer === "public" ? { ...actor, space: { kind: "public", id: "public", audience: "public" } } : null,
  isAuthorizationActive: async () => true,
  resolveProfile: async () => ({ id: "test-autonomy", version: "1", instructions: "使用当前提供的工具完成用户任务。", tools: [{
    definition: { name: "data_probe", description: "Read business data", category: "extension", mutating: false,
      inputSchema: { type: "object", additionalProperties: false }, execute: business },
    requiredPermissions: ["data.read"], validateInput: (input) => Object.keys(input).length === 0, authorizeResource: async () => true,
  }] }), createModel: async () => ({ complete }), ...options.extra });
  const headers = { authorization: "Bearer alice" };
  const session = async (bearer = "alice") => {
    const response = await app.inject({ method: "POST", url: "/api/v1/cloud/sessions", headers: { authorization: `Bearer ${bearer}` }, payload: {} });
    expect(response.statusCode).toBe(201);
    return response.json<{ session: { id: string } }>().session.id;
  };
  const run = async (sessionId: string, message: string, requestId: string = randomUUID(), bearer = "alice") => {
    const response = await app.inject({ method: "POST", url: `/api/v1/cloud/sessions/${sessionId}/runs`, headers: { authorization: `Bearer ${bearer}` }, payload: { requestId, message } });
    expect([200, 202]).toContain(response.statusCode);
    const accepted = response.json<{ run: CloudRun }>().run;
    const identity = bearer === "alice" ? actor : { ...actor, space: { kind: "public" as const, id: "public", audience: "public" } };
    await vi.waitFor(async () => expect(["completed", "failed", "cancelled", "interrupted"]).toContain((await repository.getRun(identity, accepted.id)).status));
    return await repository.getRun(identity, accepted.id);
  };
  const seed = (key: string, content: string, extra: Partial<MemoryProposal> = {}) => {
    const proposal = repository.memory.propose(actor, { requestId: randomUUID(), key, content, scope: "personal", kind: "preference", ...extra });
    return repository.memory.confirm(actor, proposal.id, proposal.revision);
  };
  return { repository, actor, complete, business, app, headers, session, run, seed,
    close: async () => { await app.close(); repository.close(); } };
}
const remember = (content = "以后回答简洁一点") => ({ key: "profile.response.style", scope: "personal", kind: "preference", content,
  basis: "user_statement", excerpt: content });

 describe("autonomous cloud memory", () => {
  it("saves without human confirmation, keeps provenance, and recalls defaults in an unrelated new session", async () => {
    const f = fixture();
    try {
      f.complete.mockResolvedValueOnce({ kind: "tool_calls", calls: [{ id: "save", name: "memory_remember", input: remember() }] });
      const first = await f.run(await f.session(), "以后回答简洁一点");
      expect(first.status, JSON.stringify(await f.repository.readEvents(f.actor, first.sessionId, 0, 200))).toBe("completed");
      const record = f.repository.memory.list(f.actor).items[0]!;
      expect(record).toMatchObject({ state: "active", revision: 1, source: { kind: "agent", basis: "user_statement" } });
      expect(record.source.excerpt).toBeUndefined();
      expect(record.source.excerptHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(f.repository.memory.audit(f.actor, record.id).items.map((item) => item.action)).toContain("agent_saved");
      expect(f.repository.memory.audit(f.actor, record.id).items.map((item) => item.action)).not.toContain("confirmed");
      f.complete.mockImplementationOnce(async (request) => {
        expect(request.systemPrompt.dynamicText).toContain(record.content);
        expect(request.systemPrompt.dynamicText).toContain("未经用户逐条确认");
        expect(request.systemPrompt.dynamicText).toContain("default_preference");
        return { kind: "assistant", content: "索引用于加快查找。" };
      });
      expect((await f.run(await f.session(), "解释数据库索引")).status).toBe("completed");
    } finally { await f.close(); }
  });

  it("refreshes after an update, removes old in-turn text and defers the remaining batch", async () => {
    const f = fixture();
    try {
      const old = f.seed("profile.response.style", "OLD_ONLY_PAYLOAD 默认展开回答");
      f.complete.mockResolvedValueOnce({ kind: "tool_calls", content: "我正在使用 OLD_ONLY_PAYLOAD。", calls: [
        { id: "update", name: "memory_update", input: { memoryId: old.id, revision: old.revision, content: "以后回答简洁一点", basis: "user_statement", excerpt: "以后回答简洁一点" } },
        { id: "stale_batch", name: "data_probe", input: {} },
      ] });
      f.complete.mockImplementationOnce(async (request) => {
        expect(f.business).not.toHaveBeenCalled();
        expect(JSON.stringify(request.messages)).not.toContain("OLD_ONLY_PAYLOAD");
        expect(JSON.stringify(request.messages)).toContain("stale_batch");
        expect(request.systemPrompt.dynamicText).toContain("以后回答简洁一点");
        return { kind: "tool_calls", calls: [{ id: "fresh_probe", name: "data_probe", input: {} }] };
      });
      const run = await f.run(await f.session(), "以后回答简洁一点，并继续查询业务");
      expect(run.status).toBe("completed");
      expect(f.business).toHaveBeenCalledTimes(1);
      expect(f.repository.memory.get(f.actor, old.id).state).toBe("superseded");
      const events = await f.repository.readEvents(f.actor, run.sessionId, 0, 200);
      expect(events.some((event) => event.type === "tool.failed" && event.payload.code === "TOOL_DEFERRED_MEMORY_REFRESH")).toBe(true);
      expect(f.repository.memory.references(f.actor, run.sessionId, run.id)).toEqual(expect.arrayContaining([expect.objectContaining({ id: old.id, available: false })]));
    } finally { await f.close(); }
  });

  it("forgets an auto-recalled record and continues business work without old payloads", async () => {
    const f = fixture();
    try {
      const old = f.seed("profile.response.style", "FORGOTTEN_ONLY_PAYLOAD 偏好");
      f.complete.mockResolvedValueOnce({ kind: "tool_calls", calls: [{ id: "forget", name: "memory_forget", input: {
        memoryId: old.id, revision: old.revision, basis: "user_statement", excerpt: "忘记我的回答风格",
      } }] });
      f.complete.mockImplementationOnce(async (request) => {
        expect(JSON.stringify(request.messages)).not.toContain("FORGOTTEN_ONLY_PAYLOAD");
        return { kind: "tool_calls", calls: [{ id: "probe", name: "data_probe", input: {} }] };
      });
      expect((await f.run(await f.session(), "忘记我的回答风格，然后查询业务")).status).toBe("completed");
      expect(f.business).toHaveBeenCalledTimes(1);
      expect(f.repository.memory.get(f.actor, old.id)).toMatchObject({ state: "forgotten", content: "", keywords: [] });
      expect(f.repository.memory.search(f.actor, "FORGOTTEN_ONLY_PAYLOAD")).toEqual([]);
    } finally { await f.close(); }
  });

  it("can create, update and forget a chain in the same run without treating its own writes as external revocation", async () => {
    const f = fixture();
    try {
      f.complete.mockResolvedValueOnce({ kind: "tool_calls", calls: [{ id: "create", name: "memory_remember", input: remember("回答简洁") }] });
      f.complete.mockImplementationOnce(async () => {
        const item = f.repository.memory.list(f.actor).items.find((record) => record.state === "active")!;
        return { kind: "tool_calls", calls: [{ id: "update", name: "memory_update", input: { memoryId: item.id, revision: item.revision,
          content: "回答详细", basis: "user_statement", excerpt: "回答详细" } }] };
      });
      f.complete.mockImplementationOnce(async () => {
        const item = f.repository.memory.list(f.actor).items.find((record) => record.state === "active")!;
        return { kind: "tool_calls", calls: [{ id: "forget", name: "memory_forget", input: { memoryId: item.id, revision: item.revision,
          basis: "user_statement", excerpt: "最后忘记" } }] };
      });
      expect((await f.run(await f.session(), "先记住回答简洁，然后改成回答详细，最后忘记这个风格")).status).toBe("completed");
      expect(f.repository.memory.list(f.actor).items.every((record) => record.state === "forgotten")).toBe(true);
    } finally { await f.close(); }
  });

  it("tracks explicit search results and stops if a searched-only memory is externally forgotten", async () => {
    const f = fixture();
    try {
      const item = f.seed("rare.project.rule", "rare_architecture_zeta");
      f.complete.mockImplementationOnce(async (request) => {
        expect(request.systemPrompt.dynamicText).not.toContain(item.content);
        return { kind: "tool_calls", calls: [{ id: "search", name: "memory_search", input: { query: "rare_architecture_zeta" } }] };
      });
      f.complete.mockImplementationOnce(async (request) => {
        expect(JSON.stringify(request.messages)).toContain(item.content);
        f.repository.memory.forget(f.actor, item.id, item.revision);
        return { kind: "tool_calls", calls: [{ id: "unsafe_probe", name: "data_probe", input: {} }] };
      });
      const run = await f.run(await f.session(), "perform check");
      expect(run.status).toBe("failed");
      expect(f.business).not.toHaveBeenCalled();
      expect(f.repository.memory.references(f.actor, run.sessionId, run.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: item.id, available: false, reasons: ["tool_search_or_write"] }),
      ]));
    } finally { await f.close(); }
  });

  it("still stops for an external change after a legitimate own update", async () => {
    const f = fixture();
    try {
      const old = f.seed("profile.response.style", "原风格");
      f.complete.mockResolvedValueOnce({ kind: "tool_calls", calls: [{ id: "update", name: "memory_update", input: {
        memoryId: old.id, revision: old.revision, content: "以后回答简洁一点", basis: "user_statement", excerpt: "以后回答简洁一点",
      } }] });
      f.complete.mockImplementationOnce(async () => {
        const active = f.repository.memory.list(f.actor).items.find((item) => item.state === "active")!;
        f.repository.memory.forget(f.actor, active.id, active.revision);
        return { kind: "tool_calls", calls: [{ id: "unsafe", name: "data_probe", input: {} }] };
      });
      expect((await f.run(await f.session(), "以后回答简洁一点")).status).toBe("failed");
      expect(f.business).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("records verified non-memory tool evidence rather than inventing a user statement", async () => {
    const f = fixture();
    try {
      f.complete.mockResolvedValueOnce({ kind: "tool_calls", calls: [{ id: "probe", name: "data_probe", input: {} }] });
      f.complete.mockResolvedValueOnce({ kind: "tool_calls", calls: [{ id: "save", name: "memory_remember", input: {
        key: "project.verified.rule", scope: "application", kind: "fact", content: "validated_project_rule_zeta",
        basis: "tool_observation", excerpt: "validated_project_rule_zeta",
      } }] });
      expect((await f.run(await f.session(), "检查项目，保留有用的验证结论")).status).toBe("completed");
      expect(f.repository.memory.list(f.actor).items[0]?.source).toMatchObject({ kind: "agent", basis: "tool_observation" });
    } finally { await f.close(); }
  });

  it.each(["wrong-excerpt", "credential", "credential-key", "credential-keywords", "spoof-owner", "stale-revision"])("does not mutate memory for %s", async (scenario) => {
    const f = fixture();
    try {
      const secret = "password" + "=" + ["not", "a", "real", "credential"].join("-");
      const before = scenario === "stale-revision" ? f.seed("profile.response.style", "旧偏好") : undefined;
      const input: Record<string, unknown> = scenario === "credential" ? remember(secret)
        : scenario === "credential-key" ? { ...remember(), key: secret }
        : scenario === "credential-keywords" ? { ...remember(), keywords: [secret] }
        : scenario === "wrong-excerpt" ? { ...remember(), excerpt: "这段原文根本不存在" }
        : scenario === "spoof-owner" ? { ...remember(), actorUserId: "bob" }
        : { memoryId: before!.id, revision: before!.revision + 1, content: "以后回答简洁一点", basis: "user_statement", excerpt: "以后回答简洁一点" };
      f.complete.mockResolvedValueOnce({ kind: "tool_calls", calls: [{ id: "blocked", name: scenario === "stale-revision" ? "memory_update" : "memory_remember", input }] });
      const run = await f.run(await f.session(), scenario === "credential" ? secret : "以后回答简洁一点");
      const records = f.repository.memory.list(f.actor).items;
      expect(records).toHaveLength(before ? 1 : 0);
      if (before) expect(records[0]?.content).toBe(before.content);
      const events = await f.repository.readEvents(f.actor, run.sessionId, 0, 200);
      expect(events.some((event) => event.type === "tool.failed" && event.payload.toolCallId === "blocked")).toBe(true);
    } finally { await f.close(); }
  });

  it("does not resurrect a forgotten key through a new automatic request", async () => {
    const f = fixture();
    try {
      const old = f.seed("profile.response.style", "以后回答简洁一点");
      f.repository.memory.forget(f.actor, old.id, old.revision);
      f.complete.mockResolvedValueOnce({ kind: "tool_calls", calls: [{ id: "restore", name: "memory_remember", input: remember() }] });
      const run = await f.run(await f.session(), "以后回答简洁一点");
      expect(f.repository.memory.search(f.actor, "回答简洁")).toEqual([]);
      expect((await f.repository.readEvents(f.actor, run.sessionId, 0, 200)).some((event) => event.type === "tool.failed" && event.payload.code === "MEMORY_FORGOTTEN")).toBe(true);
    } finally { await f.close(); }
  });

  it("delivery retries reuse the same run without writing twice", async () => {
    const f = fixture();
    try {
      const session = await f.session();
      f.complete.mockResolvedValueOnce({ kind: "tool_calls", calls: [{ id: "save", name: "memory_remember", input: remember() }] });
      const first = await f.run(session, "以后回答简洁一点", "delivery");
      const count = f.complete.mock.calls.length;
      expect((await f.run(session, "以后回答简洁一点", "delivery")).id).toBe(first.id);
      expect(f.complete).toHaveBeenCalledTimes(count);
      expect(f.repository.memory.list(f.actor).items).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("does not offer undelegated tools or write tools to a read-only actor", async () => {
    for (const actor of [{ allowedTools: ["data_probe"] }, { permissions: ["agent.use", "data.read", "memory.read"] }]) {
      const f = fixture({ actor });
      try {
        f.complete.mockImplementationOnce(async (request) => {
          const names = request.tools.map((tool) => tool.name);
          expect(names).not.toContain("memory_remember");
          expect(names).not.toContain("memory_update");
          expect(names).not.toContain("memory_forget");
          return { kind: "assistant", content: "没有可用的记忆写入工具。" };
        });
        expect((await f.run(await f.session(), "以后回答简洁一点")).status).toBe("completed");
        expect(f.repository.memory.list(f.actor).items).toEqual([]);
      } finally { await f.close(); }
    }
  });

  it("never offers private memory to a public visitor", async () => {
    const f = fixture();
    try {
      f.seed("profile.response.style", "PRIVATE_ONLY_MARKER");
      f.complete.mockImplementationOnce(async (request) => {
        expect(request.tools.some((tool) => tool.name.startsWith("memory_"))).toBe(false);
        expect(JSON.stringify(request.messages)).not.toContain("PRIVATE_ONLY_MARKER");
        return { kind: "assistant", content: "公开回答。" };
      });
      expect((await f.run(await f.session("public"), "你好", "public-run", "public")).status).toBe("completed");
    } finally { await f.close(); }
  });

  it("persists an autonomous memory across closing and reopening storage", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "harness-memory-"));
    const database = path.join(directory, "cloud.sqlite");
    const first = fixture({ database });
    try {
      first.complete.mockResolvedValueOnce({ kind: "tool_calls", calls: [{ id: "save", name: "memory_remember", input: remember() }] });
      expect((await first.run(await first.session(), "以后回答简洁一点")).status).toBe("completed");
    } finally { await first.close(); }
    const reopened = fixture({ database });
    try {
      reopened.complete.mockImplementationOnce(async (request) => {
        expect(request.systemPrompt.dynamicText).toContain("以后回答简洁一点");
        return { kind: "assistant", content: "已使用保存的偏好。" };
      });
      expect((await reopened.run(await reopened.session(), "解释事务")).status).toBe("completed");
    } finally { await reopened.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("rejects model-selected identities and lifecycle escape hatches in every tool schema", () => {
    expect(validateMemoryToolInput("memory_remember", { ...remember(), confirm: true })).toBe(false);
    expect(validateMemoryToolInput("memory_remember", { ...remember(), ownInvalidations: [] })).toBe(false);
    expect(validateMemoryToolInput("memory_search", { query: "风格", tenantId: "other" })).toBe(false);
    expect(validateMemoryToolInput("memory_forget", { memoryId: "mem_x", revision: 1, basis: "inference", excerpt: "我猜测" })).toBe(false);
  });
});
