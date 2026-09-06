import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutionIdentity } from "@daoyin/harness-contracts";
import { SqliteCloudRepository } from "./sqlite-repository.js";
import { createCloudServer } from "./app.js";

const opened: SqliteCloudRepository[] = [];
const directories: string[] = [];
async function connections() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "daoyin-lease-"));
  directories.push(directory);
  const file = path.join(directory, "runtime.sqlite");
  const first = new SqliteCloudRepository(file);
  const second = new SqliteCloudRepository(file);
  opened.push(first, second);
  return { first, second };
}
function identity(): ExecutionIdentity {
  return { actorUserId: "visitor", space: { kind: "public", id: "public", audience: "test" }, appInstallationId: "test",
    authorizationId: "grant", billingAccountId: "wallet", expiresAt: Date.now() + 60_000, permissions: ["agent.use"], allowedTools: [] };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const item of opened.splice(0)) item.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("single-instance runtime lease (real temporary SQLite; no platform/model I/O)", () => {
  it("rejects a second live executor and unowned writes", async () => {
    const { first, second } = await connections();
    first.acquireRuntimeLease();
    expect(() => second.acquireRuntimeLease({ recoverInterrupted: true })).toThrow(expect.objectContaining({ code: "RUNTIME_ALREADY_ACTIVE" }));
    await expect(second.createSession(identity(), { title: "blocked", profileId: "p", profileVersion: "1" }))
      .rejects.toMatchObject({ code: "RUNTIME_LEASE_LOST" });
    expect(first.renewRuntimeLease()).toBe(true);
  });

  it("recovers orphaned state once, fences the stale writer and preserves the original request", async () => {
    const { first, second } = await connections();
    let time = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => time);
    first.acquireRuntimeLease({ durationMs: 1000 });
    const actor = identity();
    const session = await first.createSession(actor, { title: "recovery", profileId: "p", profileVersion: "1" });
    const accepted = await first.acceptRun(actor, session.id, "request", "original goal");
    const stores = first.bindRun(actor, session.id, accepted.run.id);
    const base = { accountId: stores.accountId, scopeId: stores.scopeId, sessionId: session.id, turnId: accepted.run.id };
    await stores.events.append({ ...base, type: "turn.started", payload: { status: "running", userMessageId: "m", userMessage: "original goal" } });
    await stores.events.append({ ...base, type: "tool.started", payload: { toolCallId: "unknown", toolName: "lookup", displayText: "query" } });
    time += 1001;
    expect(second.acquireRuntimeLease({ recoverInterrupted: true })).toEqual({ recoveredRuns: 1 });
    expect(first.renewRuntimeLease()).toBe(false);
    expect(() => first.assertExecutionOwner()).toThrow(expect.objectContaining({ code: "RUNTIME_LEASE_LOST" }));
    await expect(stores.events.append({ ...base, type: "turn.completed", payload: { status: "completed", assistantMessageId: "late", outcomeSummary: "late success" } }))
      .rejects.toMatchObject({ code: "RUNTIME_LEASE_LOST" });
    expect((await second.getRun(actor, accepted.run.id)).status).toBe("interrupted");
    const replay = await second.acceptRun(actor, session.id, "request", "original goal");
    expect(replay).toMatchObject({ created: false, run: { id: accepted.run.id, status: "interrupted" } });
    expect((await second.readEvents(actor, session.id, 0, 100)).map((event) => event.type))
      .toEqual(["turn.started", "tool.started", "turn.interrupted"]);
    expect(second.recoverInterruptedRuns()).toBe(0);
    first.releaseRuntimeLease(); // Must not clear the successor's ownership.
    expect(second.renewRuntimeLease()).toBe(true);
    expect(() => second.assertExecutionOwner()).not.toThrow();
  });

  it("permits immediate graceful handover after the old executor has drained", async () => {
    const { first, second } = await connections();
    first.acquireRuntimeLease();
    first.releaseRuntimeLease();
    expect(second.acquireRuntimeLease({ recoverInterrupted: true })).toEqual({ recoveredRuns: 0 });
    expect(() => first.assertExecutionOwner()).toThrow();
  });

  it("fails before any model call when HTTP execution ownership is lost", async () => {
    const { first, second } = await connections();
    let time = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => time);
    first.acquireRuntimeLease({ durationMs: 1000 });
    const actor = identity();
    const complete = vi.fn(async () => ({ kind: "assistant" as const, content: "should not run" }));
    const app = createCloudServer({ repository: first, authenticate: async () => actor,
      isAuthorizationActive: async () => true,
      resolveProfile: async () => ({ id: "p", version: "1", instructions: "test", tools: [] }), createModel: async () => ({ complete }) });
    try {
      time += 1001;
      second.acquireRuntimeLease();
      const response = await app.inject({ method: "POST", url: "/api/v1/cloud/sessions", headers: { authorization: "Bearer fixture" }, payload: {} });
      expect(response.statusCode).toBe(503);
      expect(complete).not.toHaveBeenCalled();
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.json<{ status: string }>().status).toBe("unavailable");
    } finally { await app.close(); }
  });
});
