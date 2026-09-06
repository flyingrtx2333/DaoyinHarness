import { setTimeout as delay } from "node:timers/promises";
import type { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@daoyin/harness-protocol";
import type { ExecutionIdentity } from "@daoyin/harness-contracts";
import { createCloudServer, type CloudServerOptions } from "./app.js";
import type { CloudRun } from "./repository.js";
import { SqliteCloudRepository } from "./sqlite-repository.js";

interface Frame { type: string; events?: AgentEvent[]; run?: CloudRun; lastEventSeq?: number }
const cleanups: Array<() => Promise<void>> = [];
async function fixture(overrides: Partial<CloudServerOptions> = {}) {
  const repository = new SqliteCloudRepository(":memory:");
  const identity: ExecutionIdentity = { actorUserId: "alice", space: { kind: "organization", id: "space-a", tenantId: "tenant-a" },
    appInstallationId: "app-a", authorizationId: "grant-a", billingAccountId: "payer-a", expiresAt: Date.now() + 60_000,
    permissions: ["agent.use"], allowedTools: [] };
  const complete = vi.fn(async () => ({ kind: "assistant" as const, content: "fixture reply" }));
  const app = createCloudServer({ repository, authenticate: async (bearer) => bearer === "alice" ? identity : bearer === "bob" ? { ...identity, actorUserId: "bob" } : null,
    isAuthorizationActive: async () => true, resolveProfile: async () => ({ id: "fixture", version: "1", instructions: "Fixture only", tools: [] }),
    createModel: async () => ({ complete }), eventStream: { heartbeatMs: 100, subscribeTimeoutMs: 200 }, ...overrides });
  await app.ready();
  const session = await repository.createSession(identity, { title: "fixture", profileId: "fixture", profileVersion: "1" });
  cleanups.push(async () => { await app.close(); repository.close(); });
  return { app, repository, identity, session, complete };
}
async function seeded(f: Awaited<ReturnType<typeof fixture>>) {
  const { run } = await f.repository.acceptRun(f.identity, f.session.id, "request-a", "fixture question");
  const stores = f.repository.bindRun(f.identity, f.session.id, run.id);
  const base = { accountId: stores.accountId, scopeId: stores.scopeId, sessionId: f.session.id, turnId: run.id };
  await stores.events.append({ ...base, type: "turn.started", payload: { status: "running", userMessageId: "msg-a", userMessage: "fixture question" } });
  const delta = (text: string) => stores.events.append({ ...base, type: "assistant.delta", payload: { contentBlockId: "block-a", delta: text } });
  return { run, stores, base, delta };
}
async function until(check: () => boolean) {
  for (let index = 0; index < 200; index++) { if (check()) return; await delay(10); }
  throw new Error("Event stream fixture timed out");
}
async function subscribe(f: Awaited<ReturnType<typeof fixture>>, after = 0) {
  const socket = await f.app.injectWS(`/api/v1/cloud/sessions/${f.session.id}/events/ws`, { headers: { authorization: "Bearer alice" } });
  const frames: Frame[] = [];
  let closed: number | undefined;
  socket.on("message", (raw) => frames.push(JSON.parse(raw.toString()) as Frame));
  socket.on("close", (code) => { closed = code; });
  socket.send(JSON.stringify({ type: "subscribe", after }));
  return { socket, frames, get closed() { return closed; } };
}
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });

describe("cloud WebSocket: real Fastify/SQLite/shared core, no provider calls", () => {
  it("notifies only after commit; listener failures and rolled-back events cannot corrupt writes", async () => {
    const f = await fixture(); const seed = await seeded(f);
    const observations: Promise<CloudRun>[] = [];
    const off = f.repository.subscribeSession(f.identity, f.session.id, () => { observations.push(f.repository.getRun(f.identity, seed.run.id)); });
    const failing = f.repository.subscribeSession(f.identity, f.session.id, () => { throw new Error("fixture subscriber"); });
    await seed.delta("one");
    expect((await observations[0])?.lastEventSeq).toBe(2);
    await expect(seed.delta("x".repeat(130_000))).rejects.toThrow();
    expect(observations).toHaveLength(1);
    off(); failing(); await seed.delta("two"); expect(observations).toHaveLength(1);
  });
  it("replays before ready, then pushes new events without HTTP polling", async () => {
    const f = await fixture(); const seed = await seeded(f);
    const sub = await subscribe(f);
    await until(() => sub.frames.some((frame) => frame.type === "ready"));
    await seed.delta("new text");
    await until(() => sub.frames.flatMap((frame) => frame.events ?? []).length === 2);
    expect(sub.frames.flatMap((frame) => frame.events ?? []).map((event) => event.eventSeq)).toEqual([1, 2]);
    expect(f.complete).not.toHaveBeenCalled();
  });
  it("does not miss commits made while the first replay read is pending", async () => {
    const f = await fixture(); const seed = await seeded(f);
    const read = f.repository.readEvents.bind(f.repository);
    vi.spyOn(f.repository, "readEvents").mockImplementationOnce(async (...args) => {
      const page = await read(...args); await seed.delta("during replay"); return page;
    });
    const sub = await subscribe(f);
    await until(() => sub.frames.some((frame) => frame.type === "ready"));
    expect(sub.frames.flatMap((frame) => frame.events ?? []).map((event) => event.eventSeq)).toEqual([1, 2]);
  });
  it("rejects other accounts, origins and malformed or repeated subscriptions", async () => {
    const f = await fixture();
    const path = `/api/v1/cloud/sessions/${f.session.id}/events/ws`;
    await expect(f.app.injectWS(path, { headers: { authorization: "Bearer bob" } })).rejects.toThrow();
    await expect(f.app.injectWS(path, { headers: { authorization: "Bearer alice", origin: "https://foreign.invalid" } })).rejects.toThrow();
    await expect(f.app.injectWS(path)).rejects.toThrow();
    const sub = await subscribe(f);
    await until(() => sub.frames.some((frame) => frame.type === "ready"));
    sub.socket.send(JSON.stringify({ type: "submit", message: "must not execute" }));
    await until(() => sub.closed !== undefined); expect(sub.closed).toBe(1008);
    expect(await f.repository.listRuns(f.identity, f.session.id)).toHaveLength(0);
  });
  it("rechecks idle authority and withholds further private events on revocation", async () => {
    let active = true;
    const f = await fixture({ isAuthorizationActive: async () => active }); const seed = await seeded(f);
    const sub = await subscribe(f);
    await until(() => sub.frames.some((frame) => frame.type === "ready"));
    active = false;
    await seed.delta("revoked data");
    await until(() => sub.closed !== undefined);
    expect(sub.closed).toBe(4403);
    expect(JSON.stringify(sub.frames)).not.toContain("revoked data");
  });
  it("closes a slow consumer and rejects a cursor ahead of durable history", async () => {
    const f = await fixture(); const seed = await seeded(f);
    const bad = await subscribe(f, 99);
    await until(() => bad.closed !== undefined); expect(bad.closed).toBe(4409);
    const sub = await subscribe(f);
    await until(() => sub.frames.some((frame) => frame.type === "ready"));
    const serverSocket = [...f.app.websocketServer.clients].find((item: WebSocket) => item.readyState === 1)!;
    Object.defineProperty(serverSocket, "bufferedAmount", { configurable: true, value: 600_000 });
    await seed.delta("backpressure");
    await until(() => sub.closed !== undefined); expect(sub.closed).toBe(1013);
  });
  it("disconnecting never cancels or re-submits a Run; reconnect replays its terminal event", async () => {
    const f = await fixture(); const seed = await seeded(f);
    const sub = await subscribe(f);
    await until(() => sub.frames.some((frame) => frame.type === "ready"));
    sub.socket.close(); await until(() => sub.closed !== undefined);
    expect((await f.repository.getRun(f.identity, seed.run.id)).cancelRequested).toBe(false);
    await seed.stores.events.append({ ...seed.base, type: "turn.completed", payload: { status: "completed", assistantMessageId: "msg-end", outcomeSummary: "finished" } });
    const resumed = await subscribe(f, 1);
    await until(() => resumed.frames.some((frame) => frame.type === "ready"));
    expect(resumed.frames.flatMap((frame) => frame.events ?? []).map((event) => event.eventSeq)).toEqual([2]);
    const repeated = await f.repository.acceptRun(f.identity, f.session.id, "request-a", "fixture question");
    expect(repeated.created).toBe(false); expect(repeated.run.id).toBe(seed.run.id);
    expect(f.complete).not.toHaveBeenCalled();
  });
  it("pushes shared-engine output and cancellation/interrupt projection after they are durable", async () => {
    const f = await fixture();
    const sub = await subscribe(f);
    await until(() => sub.frames.some((frame) => frame.type === "ready"));
    const accepted = await f.app.inject({ method: "POST", url: `/api/v1/cloud/sessions/${f.session.id}/runs`, headers: { authorization: "Bearer alice" },
      payload: { requestId: "http-1", message: "fixture" } });
    const run = accepted.json<{ run: CloudRun }>().run;
    await until(() => sub.frames.some((frame) => frame.run?.status === "completed"));
    expect((await f.repository.getRun(f.identity, run.id)).status).toBe("completed");
    expect(f.complete).toHaveBeenCalledOnce();
    const next = await f.repository.acceptRun(f.identity, f.session.id, "http-2", "interrupted");
    await f.repository.interruptRun(f.identity, next.run.id, "runtime_recovery");
    await until(() => sub.frames.some((frame) => frame.run?.id === next.run.id && frame.run.status === "interrupted"));
  });
});
