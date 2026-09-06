import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutionIdentity } from "@daoyin/harness-contracts";
import type { AgentEvent } from "@daoyin/harness-protocol";
import { SqliteCloudRepository } from "./sqlite-repository.js";
import { createCloudServer } from "./app.js";
import { assertHistoryAdmission, eventPage, HISTORY_LIMITS, readCompleteHistory } from "./history-policy.js";
import { runtimeBuild } from "./runtime-health.js";
import { describeRun, RunMeasurements } from "./run-diagnostics.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const repository = new SqliteCloudRepository(":memory:");
  const identity: ExecutionIdentity = { actorUserId: "alice", space: { kind: "organization", id: "org", tenantId: "tenant" },
    appInstallationId: "app", authorizationId: "grant", billingAccountId: "payer", expiresAt: Date.now() + 60_000,
    permissions: ["agent.use"], allowedTools: [] };
  const complete = vi.fn(async () => ({ kind: "assistant" as const, content: "answer" }));
  const checkPlatform = vi.fn(async () => undefined);
  const app = createCloudServer({ repository, authenticate: async (token) => token === "alice" ? identity : token === "bob" ? { ...identity, actorUserId: "bob" } : null,
    isAuthorizationActive: async () => true, resolveProfile: async () => ({ id: "test", version: "1", instructions: "test", tools: [] }),
    createModel: async () => ({ complete }), checkPlatform,
    buildInfo: runtimeBuild({ revision: "a".repeat(40), builtAt: "2026-09-06T00:00:00Z", secret: "must-not-leak" }) });
  cleanup.push(async () => { await app.close(); repository.close(); });
  const session = await repository.createSession(identity, { title: "test", profileId: "test", profileVersion: "1" });
  const { run } = await repository.acceptRun(identity, session.id, "one", "private question");
  const stores = repository.bindRun(identity, session.id, run.id);
  const base = { accountId: stores.accountId, scopeId: stores.scopeId, sessionId: session.id, turnId: run.id };
  await stores.events.append({ ...base, type: "turn.started", payload: { status: "running", userMessageId: "msg", userMessage: "private question" } });
  return { repository, identity, app, session, run, stores, base, complete, checkPlatform };
}

describe("P0 history/readiness/diagnostics: real SQLite/API, mocked platform, no paid calls", () => {
  it("reads beyond 1200 old events, including terminal state, and admits the next turn", async () => {
    const f = await fixture();
    for (let n = 0; n < 1300; n++) await f.stores.events.append({ ...f.base, type: "assistant.delta", payload: { contentBlockId: "block", delta: "x" } });
    await f.stores.events.append({ ...f.base, type: "turn.completed", payload: { status: "completed", assistantMessageId: "answer", outcomeSummary: "finished" } });
    const history = await f.stores.events.read(f.session.id);
    expect(history).toHaveLength(1302); expect(history.at(-1)?.type).toBe("turn.completed");
    const next = await f.repository.acceptRun(f.identity, f.session.id, "two", "next question");
    expect(next.created).toBe(true);
    const bound = f.repository.bindRun(f.identity, f.session.id, next.run.id);
    expect((await bound.events.read(f.session.id)).at(-1)?.type).toBe("turn.completed");
  });
  it("has byte-limited HTTP pages without prematurely setting hasMore=false", async () => {
    const f = await fixture();
    for (let n = 0; n < 12; n++) await f.stores.events.append({ ...f.base, type: "assistant.delta", payload: { contentBlockId: "large", delta: "中".repeat(30_000) } });
    const response = await f.app.inject({ url: `/api/v1/cloud/sessions/${f.session.id}/events?after=0`, headers: { authorization: "Bearer alice" } });
    expect(response.statusCode).toBe(200);
    const page = response.json<{ events: AgentEvent[]; hasMore: boolean; nextEventSeq: number }>();
    expect(page.events.length).toBeLessThan(13); expect(page.hasMore).toBe(true);
    expect(Buffer.byteLength(response.body)).toBeLessThanOrEqual(HISTORY_LIMITS.pageBytes);
    const remaining = await f.repository.readEvents(f.identity, f.session.id, page.nextEventSeq, 200);
    expect(page.events.length + remaining.length).toBe(13);
  });
  it("separates live and ready, requires a lease, and never invokes a model", async () => {
    const f = await fixture();
    expect((await f.app.inject("/health/live")).json()).toEqual({ status: "alive" });
    expect((await f.app.inject("/health/ready")).statusCode).toBe(503);
    expect(f.complete).not.toHaveBeenCalled(); expect(f.checkPlatform).not.toHaveBeenCalled();
    expect((await f.app.inject("/api/v1/cloud/runtime")).statusCode).toBe(401);
  });
  it("reports ready only after explicit database lease and successful platform probe", async () => {
    const f = await fixture(); f.repository.acquireRuntimeLease();
    expect((await f.app.inject("/health/ready")).statusCode).toBe(200);
    expect(f.checkPlatform).toHaveBeenCalledTimes(1); expect(f.complete).not.toHaveBeenCalled();
    const result = await f.app.inject({ url: "/api/v1/cloud/runtime", headers: { authorization: "Bearer alice" } });
    expect(result.json().build.revision).toBe("a".repeat(40));
    expect(result.body).not.toContain("must-not-leak");
  });
  it("scopes diagnostic reads and omits private text and unobserved measurements", async () => {
    const f = await fixture();
    await f.stores.events.append({ ...f.base, type: "assistant.delta", payload: { contentBlockId: "b", delta: "private answer" } });
    const path = `/api/v1/cloud/runs/${f.run.id}/diagnostics`;
    expect((await f.app.inject({ url: path, headers: { authorization: "Bearer bob" } })).statusCode).toBe(404);
    const response = await f.app.inject({ url: path, headers: { authorization: "Bearer alice" } });
    expect(response.statusCode).toBe(200); expect(response.json().textEvents).toBe(1);
    expect(response.body).not.toContain("private answer"); expect(response.body).not.toContain("private question");
    expect(response.json().runtime.stages).toBeNull();
  });
  it("keeps diagnostics at the captured Run cursor when history advances during a read", async () => {
    const f = await fixture();
    const captured = await f.repository.getRun(f.identity, f.run.id);
    await f.stores.events.append({ ...f.base, type: "turn.completed", payload: { status: "completed", assistantMessageId: "finished", outcomeSummary: "private answer" } });
    const history = await f.stores.events.read(f.session.id);
    const result = describeRun(captured, history, new RunMeasurements());
    expect(result.status).toBe("running");
    expect(result.lastEventSeq).toBe(captured.lastEventSeq);
    expect(result.events).toBe(1);
    expect(result.totalRecordedMs).toBeNull();
  });
  it("bounds turns, bytes and events separately, never hiding malformed history", async () => {
    expect(() => assertHistoryAdmission({ runs: 2, bytes: 10000, events: 1302 })).not.toThrow();
    for (const usage of [{ runs: 100, bytes: 0, events: 0 }, { runs: 1, bytes: HISTORY_LIMITS.bytes, events: 1 },
      { runs: 1, bytes: 1, events: HISTORY_LIMITS.events }]) expect(() => assertHistoryAdmission(usage)).toThrow();
    const f = await fixture(); const first = (await f.stores.events.read(f.session.id))[0]!;
    await expect(readCompleteHistory(f.session.id, 0, async () => [{ ...first, eventSeq: 2 }])).rejects.toThrow("不连续");
    expect(eventPage([], 5)).toEqual({ events: [], nextEventSeq: 5, hasMore: false });
  });
});
