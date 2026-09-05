import { describe, expect, it, vi } from "vitest";
import type { ExecutionIdentity } from "@daoyin/harness-contracts";
import { ToolRegistry, type ToolExecutionContext } from "@daoyin/harness-tools/registry";
import { createCloudServer } from "./app.js";
import { SqliteCloudRepository } from "./sqlite-repository.js";
import type { CloudRun } from "./repository.js";
import {
  COMPANY_KNOWLEDGE_TOOL, COMPANY_PUBLIC_INSTALLATION, createCompanyPublicProfile,
  isCompanyPublicIdentity, parseCompanyKnowledgeQuery, parseCompanyKnowledgeResult,
} from "./company-profile.js";

function identity(): ExecutionIdentity {
  return {
    actorUserId: "visitor_alice", space: { kind: "public", id: "company-public", audience: COMPANY_PUBLIC_INSTALLATION },
    appInstallationId: COMPANY_PUBLIC_INSTALLATION, authorizationId: "grant-alice", billingAccountId: "public-sponsor",
    expiresAt: Date.now() + 60_000, permissions: ["agent.use", "company.knowledge.read"], allowedTools: [COMPANY_KNOWLEDGE_TOOL],
  };
}
const source = { id: "company_1_2", document_id: 1, chunk_id: 2, title: "公开项目", location: "第1页", content: "项目支持互动体验。", untrusted: true };
const response = { schemaVersion: 1, sources: [source] };
function registryFixture() {
  const search = vi.fn(async () => response);
  const profile = createCompanyPublicProfile({ search });
  const binding = profile.tools[0];
  if (binding === undefined) throw new Error("Missing fixture tool");
  const registry = new ToolRegistry([binding.definition], { authorize: async ({ context, request }) => {
    const current = context.executionIdentity;
    if (current === undefined || !isCompanyPublicIdentity(current)) return false;
    return request === undefined || (binding.validateInput(request.input) && await binding.authorizeResource(request, current, new AbortController().signal));
  } });
  const context: ToolExecutionContext = { accountId: "visitor_alice", scopeId: "scope", sessionId: "session", turnId: "run-1", sourceEventIds: [], executionIdentity: identity() };
  return { search, profile, registry, context };
}

describe("company profile contracts (no real platform/model calls)", () => {
  it("normalizes only the documented query fields", () => {
    expect(parseCompanyKnowledgeQuery({ query: "  项目介绍  " })).toEqual({ query: "项目介绍", top_k: 5 });
    for (const input of [{ query: " " }, { query: 123 }, { query: "项目", top_k: true }, { query: "项目", top_k: 6 },
      { query: "项目", top_k: "2" }, { query: "项目", tenant_id: "other" }, { query: "项目", url: "https://example.invalid" }]) {
      expect(() => parseCompanyKnowledgeQuery(input)).toThrow();
    }
  });

  it("rejects unexpected source fields, invented IDs and oversized excerpts", () => {
    expect(parseCompanyKnowledgeResult(response)).toEqual({ sources: [source] });
    for (const item of [{ ...source, media: [] }, { ...source, id: "invented" }, { ...source, untrusted: false },
      { ...source, content: "x".repeat(1201) }, { ...source, document_id: -1 }]) {
      expect(() => parseCompanyKnowledgeResult({ schemaVersion: 1, sources: [item] })).toThrow();
    }
    expect(() => parseCompanyKnowledgeResult({ schemaVersion: 1, sources: [source, source] })).toThrow();
    expect(() => parseCompanyKnowledgeResult({ ...response, raw_provider_payload: {} })).toThrow();
  });

  it("passes registry-owned operation identifiers, not identifiers from tool JSON", async () => {
    const { registry, context, search } = registryFixture();
    const result = await registry.execute({ id: "operation-1", name: COMPANY_KNOWLEDGE_TOOL, input: { query: "项目介绍", top_k: 1 } }, new AbortController().signal, context);
    expect(result).toMatchObject({ ok: true, evidence: { result: { sources: [source] } } });
    expect(search).toHaveBeenCalledWith({ query: "项目介绍", top_k: 1 },
      { identity: context.executionIdentity, runId: "run-1", operationId: "operation-1" }, expect.any(AbortSignal));
    expect(registry.auditInput(COMPANY_KNOWLEDGE_TOOL, { query: "private wording" })).toEqual({ queryLength: 15 });
    const denied = await registry.execute({ id: "operation-2", name: COMPANY_KNOWLEDGE_TOOL, input: { query: "项目介绍", operationId: "spoof" } }, new AbortController().signal, context);
    expect(denied).toMatchObject({ ok: false, code: "TOOL_ACCESS_DENIED" });
    expect(search).toHaveBeenCalledOnce();
  });

  it("does not treat personal, enterprise or another public app as the company entrance", async () => {
    const { registry, context, search } = registryFixture();
    const base = identity();
    const others: ExecutionIdentity[] = [
      { ...base, space: { kind: "personal", id: "personal", ownerUserId: base.actorUserId } },
      { ...base, space: { kind: "organization", id: "enterprise", tenantId: "tenant-a" } },
      { ...base, appInstallationId: "another-public-app" },
      { ...base, space: { kind: "public", id: "company-public", audience: "another-public-app" } },
    ];
    for (const other of others) {
      const scoped = { ...context, executionIdentity: other };
      expect(await registry.descriptorsFor(scoped)).toEqual([]);
      expect(await registry.execute({ id: "call", name: COMPANY_KNOWLEDGE_TOOL, input: { query: "项目介绍" } }, new AbortController().signal, scoped))
        .toMatchObject({ ok: false, code: "TOOL_ACCESS_DENIED" });
    }
    expect(search).not.toHaveBeenCalled();
  });

  it("does not convert an empty retrieval into invented evidence", async () => {
    const { registry, context, search } = registryFixture();
    search.mockResolvedValue({ schemaVersion: 1, sources: [] });
    expect(await registry.execute({ id: "empty", name: COMPANY_KNOWLEDGE_TOOL, input: { query: "项目介绍" } }, new AbortController().signal, context))
      .toMatchObject({ ok: true, summary: "未找到相关公开资料", evidence: { result: { sources: [] } } });
  });

  it("runs the profile through the existing API, engine and SQLite with explicit test doubles", async () => {
    const repository = new SqliteCloudRepository(":memory:");
    const actor = identity();
    const search = vi.fn(async () => response);
    let modelCalls = 0;
    const app = createCloudServer({
      repository, authenticate: async () => actor, isAuthorizationActive: async () => true,
      resolveProfile: async () => createCompanyPublicProfile({ search }),
      createModel: async () => ({ complete: async (request) => {
        modelCalls += 1;
        expect(request.tools.map((tool) => tool.name)).toEqual([COMPANY_KNOWLEDGE_TOOL]);
        if (modelCalls === 1) return { kind: "tool_calls", calls: [{ id: "lookup-1", name: COMPANY_KNOWLEDGE_TOOL, input: { query: "项目介绍" } }] };
        expect(request.messages.some((message) => message.role === "tool" && message.content.includes("项目支持互动体验"))).toBe(true);
        return { kind: "assistant", content: "项目支持互动体验。" };
      } }),
    });
    const headers = { authorization: "Bearer test-double-only" };
    try {
      const created = await app.inject({ method: "POST", url: "/api/v1/cloud/sessions", headers, payload: {} });
      expect(created.statusCode).toBe(201);
      const sessionId = created.json<{ session: { id: string } }>().session.id;
      const accepted = await app.inject({ method: "POST", url: `/api/v1/cloud/sessions/${sessionId}/runs`, headers, payload: { requestId: "request-1", message: "介绍项目" } });
      expect(accepted.statusCode).toBe(202);
      const runId = accepted.json<{ run: CloudRun }>().run.id;
      await vi.waitFor(async () => expect((await repository.getRun(actor, runId)).status).toBe("completed"));
      expect(search).toHaveBeenCalledOnce();
      expect((await repository.readEvents(actor, sessionId, 0, 100)).map((event) => event.type))
        .toEqual(["turn.started", "tool.started", "tool.completed", "assistant.delta", "turn.completed"]);
    } finally { await app.close(); repository.close(); }
  });
});
