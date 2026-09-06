import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutionIdentity } from "@daoyin/harness-contracts";
import type { CloudRepository } from "./repository.js";
import { SqliteCloudRepository } from "./sqlite-repository.js";
import { withCommittedSessionEvents } from "./event-repository.js";

const stores: SqliteCloudRepository[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); });
async function fixture() {
  const sql = new SqliteCloudRepository(":memory:"); stores.push(sql);
  const identity: ExecutionIdentity = { actorUserId: "alice", space: { kind: "organization", id: "space", tenantId: "tenant" },
    appInstallationId: "app", authorizationId: "grant", billingAccountId: "payer", expiresAt: Date.now() + 60000,
    permissions: ["agent.use"], allowedTools: [] };
  // Emulate asynchronous repositories without native notification, not a real PostgreSQL test.
  const base: CloudRepository = {
    assertExecutionOwner: () => sql.assertExecutionOwner(), createSession: sql.createSession.bind(sql),
    listSessions: sql.listSessions.bind(sql), getSession: sql.getSession.bind(sql), getRun: sql.getRun.bind(sql),
    findRequest: sql.findRequest.bind(sql), listRuns: sql.listRuns.bind(sql), readEvents: sql.readEvents.bind(sql),
    acceptRun: sql.acceptRun.bind(sql), requestCancellation: sql.requestCancellation.bind(sql), interruptRun: sql.interruptRun.bind(sql),
    bindRun: async (...args) => sql.bindRun(...args),
  };
  const session = await base.createSession(identity, { title: "fixture", profileId: "fixture", profileVersion: "1" });
  return { sql, base, identity, session };
}

describe("post-commit notification adapter for asynchronous repositories", () => {
  it("waits for async admission resolution and does not notify reused or rejected requests", async () => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const underlying = f.base.acceptRun;
    f.base.acceptRun = async (...args) => { const result = await underlying(...args); await gate; return result; };
    const repository = withCommittedSessionEvents(f.base); const notify = vi.fn();
    repository.subscribeSession!(f.identity, f.session.id, notify);
    const pending = repository.acceptRun(f.identity, f.session.id, "one", "message");
    await Promise.resolve(); expect(notify).not.toHaveBeenCalled();
    release(); await pending; expect(notify).toHaveBeenCalledOnce();
    await repository.acceptRun(f.identity, f.session.id, "one", "message");
    await expect(repository.acceptRun(f.identity, f.session.id, "one", "different")).rejects.toThrow();
    expect(notify).toHaveBeenCalledOnce();
  });
  it("supports awaited bindRun, immutable events, cancel and interrupted states in the same adapter", async () => {
    const f = await fixture(); const repository = withCommittedSessionEvents(f.base);
    const { run } = await repository.acceptRun(f.identity, f.session.id, "request", "question");
    const notify = vi.fn(); const other = vi.fn();
    const off = repository.subscribeSession!(f.identity, f.session.id, notify);
    repository.subscribeSession!({ ...f.identity, actorUserId: "bob" }, f.session.id, other);
    const bound = await repository.bindRun(f.identity, f.session.id, run.id);
    await bound.events.append({ accountId: bound.accountId, scopeId: bound.scopeId, sessionId: f.session.id, turnId: run.id,
      type: "turn.started", payload: { userMessageId: "message", userMessage: "question", status: "running" } });
    await repository.requestCancellation(f.identity, run.id);
    await repository.interruptRun(f.identity, run.id, "runtime_recovery");
    expect(notify).toHaveBeenCalledTimes(3); expect(other).not.toHaveBeenCalled();
    expect((await repository.getRun(f.identity, run.id)).status).toBe("interrupted");
    off();
    await repository.requestCancellation(f.identity, run.id);
    expect(notify).toHaveBeenCalledTimes(3);
  });
  it("does not wrap native repository subscriptions twice", async () => {
    const { sql } = await fixture(); expect(withCommittedSessionEvents(sql)).toBe(sql);
  });
});
