import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ExecutionIdentity } from "@daoyin/harness-contracts";
import { createPlatformCloudServer } from "./platform-adapter.js";
import { SqliteCloudRepository } from "./sqlite-repository.js";
import { createSaishiProfile, isSaishiIdentity } from "./saishi-profile.js";
import { MEMORY_TOOL_NAMES } from "./memory-agent-policy.js";

const identity = (): ExecutionIdentity => ({ actorUserId: "7", space: { kind: "organization", id: "tenant_3", tenantId: "3" },
  appInstallationId: `saishi-readonly:3:${"a".repeat(24)}`, authorizationId: `sag_${"b".repeat(48)}`,
  billingAccountId: "saishi:3:7", expiresAt: Date.now() + 120_000,
  permissions: ["agent.use", "saishi.events.read", "memory.read", "memory.write"], allowedTools: ["saishi_list_events", ...MEMORY_TOOL_NAMES] });
const catalog = { id: "saishi-readonly", version: "1", instructions: "按已授权的工具查询赛事。", tools: [{
  name: "saishi_list_events", description: "Read events", inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false }, requiredPermissions: ["saishi.events.read"],
}] };

describe("kernel memory and the existing platform bridge (simulated transport, real engine/SQLite)", () => {
  it("advertises delegated memory to the model but executes it locally, not via the business call endpoint", async () => {
    const actor = identity();
    const repository = new SqliteCloudRepository(":memory:");
    const invocations: string[] = [];
    let models = 0;
    const transport: typeof fetch = async (url, init) => {
      const endpoint = new URL(String(url)).pathname.split("/").at(-1);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (endpoint === "introspect") return Response.json({ identity: actor });
      if (endpoint === "authorize") return Response.json({ active: true });
      if (endpoint === "profile") return Response.json(catalog);
      if (endpoint === "authorize-tool") return Response.json({ allowed: true });
      if (endpoint === "call") {
        invocations.push(String(body.name));
        return Response.json({ schemaVersion: 1, tool: body.name, readOnly: true, untrusted: true, data: { items: [] } });
      }
      if (endpoint !== "model") throw new Error("Unexpected test endpoint");
      const input = body.input as { tools: Array<{ name: string }>; messages: unknown[] };
      expect(input.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([...MEMORY_TOOL_NAMES]));
      models++;
      return Response.json({ schemaVersion: 1, output: models === 1 ? { kind: "tool_calls", content: "", calls: [{
        id: "save", name: "memory_remember", input: { key: "profile.response.style", scope: "application", kind: "preference",
          content: "以后回答简洁一点", basis: "user_statement", excerpt: "以后回答简洁一点" },
      }] } : models === 2 ? { kind: "tool_calls", content: "", calls: [
        { id: "search", name: "memory_search", input: { query: "回答简洁" } },
        { id: "events", name: "saishi_list_events", input: {} },
      ] } : { kind: "assistant", content: "偏好已保存，没有查到赛事。" } });
    };
    // Ephemeral test-only random strings; no actual platform/provider credentials or network calls.
    const app = createPlatformCloudServer({ repository, platformUrl: "https://platform.example",
      serviceToken: randomUUID(), appServiceToken: randomUUID(), fetch: transport });
    const headers = { authorization: `Bearer saishi_agent_${"c".repeat(64)}` };
    try {
      const response = await app.inject({ method: "POST", url: "/api/v1/cloud/sessions", headers, payload: {} });
      expect(response.statusCode).toBe(201);
      const sessionId = response.json<{ session: { id: string } }>().session.id;
      const submitted = await app.inject({ method: "POST", url: `/api/v1/cloud/sessions/${sessionId}/runs`, headers,
        payload: { requestId: "memory-workflow", message: "以后回答简洁一点，然后查赛事" } });
      expect(submitted.statusCode).toBe(202);
      const runId = submitted.json<{ run: { id: string } }>().run.id;
      await vi.waitFor(async () => expect((await repository.getRun(actor, runId)).status).toBe("completed"));
      expect(models).toBe(3);
      expect(invocations).toEqual(["saishi_list_events"]);
      expect(repository.memory.list(actor).items[0]).toMatchObject({ state: "active", scope: "application", source: { kind: "agent" } });
    } finally { await app.close(); repository.close(); }
  });

  it("does not accept kernel tool delegation without its matching memory permission", () => {
    const actor = identity();
    expect(isSaishiIdentity(actor)).toBe(true);
    expect(isSaishiIdentity({ ...actor, permissions: ["agent.use", "saishi.events.read"] })).toBe(false);
    const readOnly = { ...actor, allowedTools: ["saishi_list_events", "memory_search"], permissions: ["agent.use", "saishi.events.read", "memory.read"] };
    expect(isSaishiIdentity(readOnly)).toBe(true);
    const profile = createSaishiProfile(catalog, readOnly, { authorize: async () => true, call: async () => ({}) });
    expect(profile.tools.map((tool) => tool.definition.name)).toEqual(["saishi_list_events", "memory_search"]);
  });
});
