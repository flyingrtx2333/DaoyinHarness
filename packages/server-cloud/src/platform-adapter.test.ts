import { describe, expect, it, vi } from "vitest";
import type { ExecutionIdentity } from "@daoyin/harness-contracts";
import { createPlatformAdapters, createPlatformCloudServer } from "./platform-adapter.js";
import { SqliteCloudRepository } from "./sqlite-repository.js";

const serviceToken = "fixture-only-service-token-000000000000";
const visitorToken = "fixture-only-visitor-credential";
const identity: ExecutionIdentity = {
  actorUserId: "visitor_a", space: { kind: "public", id: "company-public", audience: "daoyin-company-public" },
  appInstallationId: "daoyin-company-public", authorizationId: "grant_a", billingAccountId: "company:7:8",
  expiresAt: Date.now() + 600_000, permissions: ["agent.use", "company.knowledge.read"], allowedTools: ["search_company_knowledge"],
};
const source = { id: "company_1_2", document_id: 1, chunk_id: 2, title: "项目", location: "", content: "公开互动项目。", untrusted: true };

describe("platform adapter (real engine/SQLite, explicitly simulated platform and model)", () => {
  it("executes the shared loop through fixed platform endpoints, replays and never persists credentials", async () => {
    let models = 0;
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const transport: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname.split("/").at(-1) ?? "";
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ path, body });
      expect(new URL(String(url)).origin).toBe("https://platform.example");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("x-agent-service-token")).toBe(serviceToken);
      if (path === "introspect") return Response.json({ identity });
      if (path === "authorize") return Response.json({ active: true });
      if (path === "search") return Response.json({ schemaVersion: 1, sources: [source] });
      models += 1;
      return Response.json({ schemaVersion: 1, output: models === 1
        ? { kind: "tool_calls", content: "", calls: [{ id: "call_1", name: "search_company_knowledge", input: { query: "介绍项目" } }] }
        : { kind: "assistant", content: "道引提供公开互动项目。" } });
    };
    const repository = new SqliteCloudRepository(":memory:");
    const app = createPlatformCloudServer({ repository, platformUrl: "https://platform.example", serviceToken, fetch: transport });
    const headers = { authorization: `Bearer ${visitorToken}` };
    try {
      const session = (await app.inject({ method: "POST", url: "/api/v1/cloud/sessions", headers, payload: {} })).json<{ session: { id: string } }>().session;
      const path = `/api/v1/cloud/sessions/${session.id}/runs`;
      const accepted = await app.inject({ method: "POST", url: path, headers, payload: { requestId: "req_1", message: "介绍项目" } });
      expect(accepted.statusCode).toBe(202);
      const runId = accepted.json<{ run: { id: string } }>().run.id;
      await vi.waitFor(async () => {
        expect((await app.inject({ url: `/api/v1/cloud/runs/${runId}`, headers })).json<{ run: { status: string } }>().run.status).toBe("completed");
      });
      const retry = await app.inject({ method: "POST", url: path, headers, payload: { requestId: "req_1", message: "介绍项目" } });
      expect(retry.json<{ reused: boolean }>().reused).toBe(true);
      expect(models).toBe(2);
      expect(calls.filter((call) => call.path === "model").map((call) => call.body.operationId)).toEqual(["model_1", "model_2"]);
      expect(calls.find((call) => call.path === "search")?.body).toMatchObject({ authorizationId: "grant_a", runId, operationId: "call_1" });
      const events = await app.inject({ url: `/api/v1/cloud/sessions/${session.id}/events`, headers });
      expect(events.body).toContain("公开互动项目");
      expect(events.body).not.toContain(visitorToken);
      expect(events.body).not.toContain(serviceToken);
      expect(calls.filter((call) => call.path === "authorize").length).toBeGreaterThan(5);
    } finally { await app.close(); repository.close(); }
  });

  it("fails closed on revocation, malformed replies and oversized responses without retry or error disclosure", async () => {
    for (const response of [new Response("secret upstream detail", { status: 403 }),
      Response.json({ identity: { unexpected: true } }),
      new Response("x".repeat(96_001))]) {
      const transport = vi.fn<typeof fetch>(async () => response);
      const adapters = createPlatformAdapters({ platformUrl: "https://platform.example", serviceToken, fetch: transport });
      const result = adapters.authenticate(visitorToken, new AbortController().signal);
      await expect(result).rejects.toBeInstanceOf(Error);
      const error: unknown = await result.catch((caught: unknown) => caught);
      expect(String(error)).not.toContain("secret upstream detail");
      expect(String(error)).not.toContain(serviceToken);
      expect(transport).toHaveBeenCalledTimes(1);
    }
    const adapters = createPlatformAdapters({ platformUrl: "https://platform.example", serviceToken,
      fetch: async () => Response.json({ identity: { ...identity, space: { kind: "organization", id: "x", tenantId: "x" } }, active: false }),
    });
    await expect(adapters.authenticate(visitorToken, new AbortController().signal)).resolves.toBeNull();
    await expect(adapters.isAuthorizationActive(identity, new AbortController().signal)).resolves.toBe(false);
  });

  it("rejects insecure targets and credential-bearing URLs before network I/O", () => {
    for (const platformUrl of ["http://platform.example", "https://user:password@platform.example", "https://platform.example/other", "https://platform.example?token=x"]) {
      expect(() => createPlatformAdapters({ platformUrl, serviceToken })).toThrow();
    }
  });
});
