import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionIdentity } from "@daoyin/harness-contracts";
import { SqliteCloudRepository } from "./sqlite-repository.js";

const databases = new Set<SqliteCloudRepository>();
const directories: string[] = [];
function open(filename = ":memory:"): SqliteCloudRepository {
  const repository = new SqliteCloudRepository(filename);
  databases.add(repository);
  return repository;
}
function close(repository: SqliteCloudRepository): void { repository.close(); databases.delete(repository); }
function identity(user = "alice"): ExecutionIdentity {
  return { actorUserId: user, space: { kind: "organization", id: "space-a", tenantId: "tenant-a" },
    appInstallationId: "story-a", authorizationId: `grant-${user}`, billingAccountId: "tenant-wallet",
    expiresAt: Date.now() + 60_000, permissions: ["agent.use"], allowedTools: [] };
}
async function fixture(repository = open()) {
  const actor = identity();
  const session = await repository.createSession(actor, { title: "fixture", profileId: "story", profileVersion: "1" });
  const accepted = await repository.acceptRun(actor, session.id, "request-1", "hello");
  const stores = repository.bindRun(actor, session.id, accepted.run.id);
  const base = { accountId: stores.accountId, scopeId: stores.scopeId, sessionId: session.id, turnId: accepted.run.id };
  return { repository, actor, session, accepted, stores, base };
}
afterEach(async () => {
  for (const database of databases) database.close();
  databases.clear();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("cloud SQL persistence (real isolated SQLite; no model or platform calls)", () => {
  it.each(["user", "tenant", "space", "application"] as const)("isolates %s in every lookup", async (dimension) => {
    const { repository, actor, session, accepted } = await fixture();
    const other: ExecutionIdentity = dimension === "user" ? identity("bob")
      : dimension === "application" ? { ...actor, appInstallationId: "youji-a" }
      : { ...actor, space: { kind: "organization", id: dimension === "space" ? "space-b" : "space-a", tenantId: dimension === "tenant" ? "tenant-b" : "tenant-a" } };
    expect(await repository.listSessions(other)).toEqual([]);
    await expect(repository.getSession(other, session.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(repository.getRun(other, accepted.run.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(repository.findRequest(other, session.id, "request-1")).rejects.toMatchObject({ statusCode: 404 });
    await expect(repository.readEvents(other, session.id, 0, 100)).rejects.toMatchObject({ statusCode: 404 });
    await expect(repository.acceptRun(other, session.id, "attack", "read this")).rejects.toMatchObject({ statusCode: 404 });
    await expect(repository.requestCancellation(other, accepted.run.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(() => repository.bindRun(other, session.id, accepted.run.id)).toThrow();
  });

  it("deduplicates requests without changing the original payer or authorization", async () => {
    const { repository, actor, session, accepted } = await fixture();
    const duplicate = await repository.acceptRun({ ...actor, authorizationId: "new-grant", billingAccountId: "personal-wallet" }, session.id, "request-1", "hello");
    expect(duplicate).toMatchObject({ created: false, run: { id: accepted.run.id, authorizationId: actor.authorizationId, billingAccountId: "tenant-wallet" } });
    await expect(repository.acceptRun(actor, session.id, "request-1", "different")).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(repository.acceptRun(actor, session.id, "request-2", "next")).rejects.toMatchObject({ code: "SESSION_BUSY" });
    expect(await repository.listRuns(actor, session.id)).toHaveLength(1);
  });

  it("persists terminal events and run state atomically; late results cannot replace them", async () => {
    const { repository, actor, session, accepted, stores, base } = await fixture();
    await stores.events.append({ ...base, type: "turn.started", payload: { status: "running", userMessageId: "message-1", userMessage: "hello" } });
    await stores.events.append({ ...base, type: "turn.completed", payload: { status: "completed", assistantMessageId: "message-2", outcomeSummary: "answer" } });
    expect(await repository.getRun(actor, accepted.run.id)).toMatchObject({ status: "completed", finalText: "answer", lastEventSeq: 2 });
    await expect(stores.events.append({ ...base, type: "assistant.delta", payload: { contentBlockId: "late", delta: "late answer" } }))
      .rejects.toMatchObject({ code: "RUN_NOT_ACTIVE" });
    expect((await repository.readEvents(actor, session.id, 1, 100)).map((event) => event.eventSeq)).toEqual([2]);
    const duplicate = await repository.acceptRun(actor, session.id, "request-1", "hello");
    expect(duplicate.created).toBe(false);
    expect(duplicate.run.status).toBe("completed");
  });

  it("binds event and compaction stores to an exact session/run identity", async () => {
    const { repository, actor, stores, base } = await fixture();
    const another = await repository.createSession(actor, { title: "other", profileId: "story", profileVersion: "1" });
    await expect(stores.events.read(another.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(stores.compactions.list(another.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(stores.events.append({ ...base, accountId: "bob", type: "turn.started", payload: { status: "running", userMessageId: "m", userMessage: "fake" } }))
      .rejects.toMatchObject({ code: "EVENT_SCOPE_MISMATCH" });
    expect(await stores.events.read(base.sessionId)).toEqual([]);
  });

  it("keeps raw events when creating a bounded compaction", async () => {
    const { stores, base } = await fixture();
    await stores.events.append({ ...base, type: "turn.started", payload: { status: "running", userMessageId: "m", userMessage: "hello" } });
    const summary = await stores.compactions.append({ sessionId: base.sessionId, sourceStartSeq: 1, sourceEndSeq: 1, summary: "hello", strategy: "test" });
    expect(await stores.compactions.latest(base.sessionId)).toEqual(summary);
    expect(await stores.events.read(base.sessionId)).toHaveLength(1);
    await expect(stores.compactions.append({ sessionId: base.sessionId, sourceStartSeq: 1, sourceEndSeq: 20, summary: "invented", strategy: "test" }))
      .rejects.toMatchObject({ code: "COMPACTION_INVALID" });
  });

  it("rolls back oversized events without consuming a sequence number", async () => {
    const { stores, base } = await fixture();
    await expect(stores.events.append({ ...base, type: "assistant.delta", payload: { contentBlockId: "huge", delta: "x".repeat(130_000) } }))
      .rejects.toMatchObject({ code: "EVENT_TOO_LARGE" });
    const event = await stores.events.append({ ...base, type: "assistant.delta", payload: { contentBlockId: "small", delta: "ok" } });
    expect(event.eventSeq).toBe(1);
  });

  it("reopens durable state and marks interrupted work without resubmitting it", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "daoyin-cloud-sql-"));
    directories.push(directory);
    const filename = path.join(directory, "cloud.sqlite");
    const first = open(filename);
    const { actor, session, accepted, stores, base } = await fixture(first);
    await stores.events.append({ ...base, type: "turn.started", payload: { status: "running", userMessageId: "m", userMessage: "hello" } });
    close(first);
    const reopened = open(filename);
    expect((await reopened.getRun(actor, accepted.run.id)).status).toBe("running");
    expect(reopened.recoverInterruptedRuns()).toBe(1);
    expect(reopened.recoverInterruptedRuns()).toBe(0);
    expect((await reopened.getRun(actor, accepted.run.id)).status).toBe("interrupted");
    expect((await reopened.readEvents(actor, session.id, 0, 100)).map((event) => event.type)).toEqual(["turn.started", "turn.interrupted"]);
    expect(await reopened.acceptRun(actor, session.id, "request-1", "hello")).toMatchObject({ created: false, run: { id: accepted.run.id, status: "interrupted" } });
  });

  it("shares request uniqueness across two SQL connections without automatic takeover", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "daoyin-cloud-connections-"));
    directories.push(directory);
    const filename = path.join(directory, "cloud.sqlite");
    const first = open(filename);
    const { actor, session, accepted } = await fixture(first);
    const second = open(filename);
    expect(await second.acceptRun(actor, session.id, "request-1", "hello")).toMatchObject({ created: false, run: { id: accepted.run.id } });
    await expect(second.acceptRun(actor, session.id, "request-2", "next")).rejects.toMatchObject({ code: "SESSION_BUSY" });
    expect((await first.getRun(actor, accepted.run.id)).status).toBe("running");
  });
});
