import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutionIdentity } from "@daoyin/harness-contracts";
import { SqliteCloudRepository } from "./sqlite-repository.js";
import type { MemoryProposal } from "./memory-policy.js";

// Real temporary SQLite; all identities are explicit test doubles. No model, network or paid I/O.
const opened: SqliteCloudRepository[] = [];
const dirs: string[] = [];
function repository(filename = ":memory:") { const value = new SqliteCloudRepository(filename); opened.push(value); return value; }
function identity(user = "alice", app = "story", tenant?: string): ExecutionIdentity {
  return { actorUserId: user, appInstallationId: app, authorizationId: `grant-${user}-${app}`, billingAccountId: "payer",
    space: tenant ? { kind: "organization", id: tenant, tenantId: tenant } : { kind: "personal", id: `personal-${user}`, ownerUserId: user },
    expiresAt: Date.now() + 120_000, allowedTools: [],
    permissions: ["agent.use", "memory.read", "memory.write", "memory.share", "memory.organization.read", "memory.organization.write"] };
}
const proposal = (overrides: Partial<MemoryProposal> = {}): MemoryProposal => ({
  requestId: "remember-1", key: "video.format", scope: "personal", kind: "preference", content: "视频采用竖屏，字幕简洁。",
  keywords: ["视频", "竖屏", "格式"], ...overrides,
});
function active(db: SqliteCloudRepository, actor = identity(), input = proposal()) {
  const candidate = db.memory.propose(actor, input);
  return db.memory.confirm(actor, candidate.id, candidate.revision);
}
async function run(db: SqliteCloudRepository, actor = identity()) {
  const session = await db.createSession(actor, { title: "memory fixture", profileId: "test", profileVersion: "1" });
  const accepted = await db.acceptRun(actor, session.id, "request", "视频格式");
  const stores = db.bindRun(actor, session.id, accepted.run.id);
  const base = { accountId: stores.accountId, scopeId: stores.scopeId, sessionId: session.id, turnId: accepted.run.id };
  const start = await stores.events.append({ ...base, type: "turn.started", payload: { status: "running", userMessageId: "m", userMessage: "视频采用竖屏" } });
  return { session, run: accepted.run, stores, base, start };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const item of opened.splice(0)) item.close();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("versioned long-term memory (real isolated SQLite)", () => {
  it("keeps pending records out of retrieval until explicitly confirmed", () => {
    const db = repository(); const actor = identity();
    const candidate = db.memory.propose(actor, proposal());
    expect(candidate.state).toBe("pending");
    expect(db.memory.search(actor, "视频")).toEqual([]);
    expect(db.memory.get(actor, candidate.id)).toMatchObject({ id: candidate.id, state: "pending" });
    const record = db.memory.confirm(actor, candidate.id, candidate.revision);
    expect(record).toMatchObject({ state: "active", revision: 2, source: { kind: "user_edit", requestId: "remember-1" } });
    expect(db.memory.confirm(actor, candidate.id, candidate.revision)).toEqual(record);
    expect(db.memory.search(actor, "视频")[0]?.memory.id).toBe(record.id);
    expect(db.memory.search(actor, "天气预报")).toEqual([]);
  });

  it("deduplicates retries and identical content, but rejects reusing an ID for a new body", () => {
    const db = repository(); const actor = identity();
    const candidate = db.memory.propose(actor, proposal());
    expect(db.memory.propose(actor, proposal()).id).toBe(candidate.id);
    expect(db.memory.propose(actor, proposal({ requestId: "another-request" })).id).toBe(candidate.id);
    expect(() => db.memory.propose(actor, proposal({ content: "new body" }))).toThrow(expect.objectContaining({ code: "MEMORY_VERSION_CONFLICT" }));
    expect(db.memory.list(actor).items).toHaveLength(1);
  });

  it("requires exact, versioned consent before another application can read personal memory", () => {
    const db = repository(); const actor = identity(); const target = identity("alice", "youji");
    const record = active(db, actor);
    expect(db.memory.search(target, "视频")).toEqual([]);
    expect(() => db.memory.get(target, record.id)).toThrow();
    const share = db.memory.share(actor, record.id, record.revision, "youji", Date.now() + 60_000);
    const hit = db.memory.search(target, "视频")[0];
    expect(hit?.reference.grantId).toBe(share.id);
    expect(db.memory.get(target, record.id).content).toContain("竖屏");
    expect(db.memory.search(identity("bob", "youji"), "视频")).toEqual([]);
    expect(db.memory.search(identity("alice", "youji", "enterprise"), "视频")).toEqual([]);
    db.memory.revokeShare(actor, share.id);
    expect(db.memory.search(target, "视频")).toEqual([]);
    expect(() => db.memory.get(target, record.id)).toThrow();
    expect(() => db.memory.share(actor, record.id, record.revision, "youji", share.expiresAt)).toThrow();
  });

  it("does not export app-private records or enterprise records into personal space", () => {
    const db = repository(); const actor = identity("alice", "story", "enterprise");
    expect(() => db.memory.propose(actor, proposal())).toThrow(expect.objectContaining({ code: "MEMORY_SCOPE_DENIED" }));
    const record = active(db, actor, proposal({ scope: "application" }));
    expect(() => db.memory.share(actor, record.id, record.revision, "youji", Date.now() + 60_000)).toThrow();
    expect(db.memory.search(identity("bob", "story", "enterprise"), "视频")).toEqual([]);
  });

  it("requires enterprise memory permissions even for members in the same tenant", () => {
    const db = repository(); const owner = identity("alice", "crm", "tenant-a");
    const record = active(db, owner, proposal({ scope: "organization" }));
    const colleague = identity("bob", "crm", "tenant-a");
    expect(db.memory.search(colleague, "视频")[0]?.memory.id).toBe(record.id);
    const restricted = { ...colleague, permissions: ["agent.use", "memory.read"] };
    expect(db.memory.search(restricted, "视频")).toEqual([]);
    expect(db.memory.search(identity("alice", "crm", "tenant-b"), "视频")).toEqual([]);
    expect(() => db.memory.confirm(restricted, record.id, 1)).toThrow();
    expect(() => db.memory.forget(identity("alice", "crm", "tenant-b"), record.id, record.revision)).toThrow();
  });

  it("keeps old memory until correction is confirmed; competing corrections cannot overwrite each other", () => {
    const db = repository(); const actor = identity(); const old = active(db, actor);
    const share = db.memory.share(actor, old.id, old.revision, "youji", Date.now() + 60_000);
    const next = db.memory.propose(actor, proposal({ requestId: "correct-1", content: "视频改用横屏。", replaces: { id: old.id, revision: old.revision } }));
    const competitor = db.memory.propose(actor, proposal({ requestId: "correct-2", content: "视频使用方形。", replaces: { id: old.id, revision: old.revision } }));
    expect(db.memory.search(actor, "视频")[0]?.memory.id).toBe(old.id);
    const current = db.memory.confirm(actor, next.id, next.revision);
    expect(db.memory.search(actor, "视频")[0]?.memory.id).toBe(current.id);
    expect(() => db.memory.confirm(actor, competitor.id, competitor.revision)).toThrow(expect.objectContaining({ code: "MEMORY_VERSION_CONFLICT" }));
    expect(db.memory.shares(actor, old.id).find((item) => item.id === share.id)?.revoked).toBe(true);
    expect(db.memory.search(identity("alice", "youji"), "视频")).toEqual([]);
    db.memory.reject(actor, competitor.id, competitor.revision);
    expect(db.memory.get(actor, current.id).state).toBe("active");
  });

  it("forgets the whole version chain and does not resurrect it on retry or candidate confirmation", () => {
    const db = repository(); const actor = identity(); const old = active(db, actor);
    const candidate = db.memory.propose(actor, proposal({ requestId: "correction", content: "视频改用横屏。", replaces: { id: old.id, revision: old.revision } }));
    db.memory.forget(actor, old.id, old.revision);
    expect(db.memory.list(actor).items.every((item) => item.state === "forgotten" && item.content === "" && item.keywords.length === 0)).toBe(true);
    expect(db.memory.propose(actor, proposal()).state).toBe("forgotten");
    expect(() => db.memory.confirm(actor, candidate.id, candidate.revision)).toThrow();
    const newCandidate = db.memory.propose(actor, proposal({ requestId: "new-remember" }));
    expect(newCandidate.state).toBe("pending");
    expect(newCandidate.id).not.toBe(old.id);
    expect(db.memory.search(actor, "视频")).toEqual([]);
    const rememberedAgain = db.memory.confirm(actor, newCandidate.id, newCandidate.revision);
    expect(db.memory.search(actor, "视频")[0]?.memory.id).toBe(rememberedAgain.id);
    expect(db.memory.propose(actor, proposal()).state).toBe("forgotten");
  });

  it("applies expiration at read time, without requiring a cleanup job", () => {
    const db = repository(); let time = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => time);
    const actor = identity(); active(db, actor, proposal({ expiresAt: time + 2000 }));
    expect(db.memory.search(actor, "视频")).toHaveLength(1);
    time += 2001;
    expect(db.memory.search(actor, "视频")).toEqual([]);
  });

  it("rejects public identities and validates conversation provenance against real scoped events", async () => {
    const db = repository(); const actor = identity(); const state = await run(db, actor);
    const source = { kind: "conversation" as const, requestId: "remember-1", sessionId: state.session.id, turnId: state.run.id, eventId: state.start.id };
    expect(db.memory.propose(actor, proposal(), source).source.eventId).toBe(state.start.id);
    expect(() => db.memory.propose(identity("bob"), proposal(), source)).toThrow(expect.objectContaining({ code: "MEMORY_SOURCE_DENIED" }));
    expect(() => db.memory.propose(actor, proposal({ requestId: "forged" }), { ...source, requestId: "forged", eventId: "invented" })).toThrow();
    const visitor: ExecutionIdentity = { ...actor, space: { kind: "public", id: "company-public", audience: "public" } };
    expect(() => db.memory.propose(visitor, proposal())).toThrow();
    expect(() => db.memory.search(visitor, "视频")).toThrow();
  });

  it("records exact references without copying body text and invalidates snapshots after revocation", async () => {
    const db = repository(); const sourceActor = identity(); const target = identity("alice", "youji");
    const record = active(db, sourceActor); const grant = db.memory.share(sourceActor, record.id, record.revision, "youji", Date.now() + 60_000);
    const state = await run(db, target);
    const snapshot = db.memory.prepare(target, { sessionId: state.session.id, turnId: state.run.id, step: 0, query: "视频", events: [] });
    expect(snapshot.text).toContain(record.content);
    const uses = db.memory.references(target, state.session.id, state.run.id);
    expect(uses[0]).toMatchObject({ id: record.id, revision: record.revision, grantId: grant.id, available: true });
    expect(JSON.stringify(uses)).not.toContain(record.content);
    db.memory.revokeShare(sourceActor, grant.id);
    await expect(snapshot.assertCurrent(new AbortController().signal)).rejects.toMatchObject({ code: "MEMORY_CONTEXT_CHANGED" });
    expect(() => db.memory.prepare(target, { sessionId: state.session.id, turnId: state.run.id, step: 1, query: "视频", events: [] })).toThrow();
    await state.stores.events.append({ ...state.base, type: "turn.completed", payload: { status: "completed", assistantMessageId: "answer", outcomeSummary: "Old answer based on a now revoked memory" } });
    const next = await db.acceptRun(target, state.session.id, "next", "继续");
    const safe = db.memory.prepare(target, { sessionId: state.session.id, turnId: next.run.id, step: 0, query: "继续", events: await state.stores.events.read(state.session.id) });
    expect(safe.excludedTurns).toContainEqual({ sessionId: state.session.id, turnId: state.run.id });
    expect(safe.text).not.toContain(record.content);
  });

  it("keeps lifecycle audit metadata private and requires memory.read to inspect reference receipts", async () => {
    const db = repository(); const actor = identity(); const candidate = db.memory.propose(actor, proposal());
    const candidateAudit = db.memory.audit(actor, candidate.id);
    expect(candidateAudit.items).toEqual(expect.arrayContaining([expect.objectContaining({ action: "proposed", memoryId: candidate.id })]));
    const reader = { ...actor, permissions: ["agent.use", "memory.read"] };
    expect(() => db.memory.get(reader, candidate.id)).toThrow(expect.objectContaining({ code: "MEMORY_NOT_FOUND" }));
    expect(() => db.memory.audit(reader, candidate.id)).toThrow(expect.objectContaining({ code: "MEMORY_ACCESS_DENIED" }));
    const record = db.memory.confirm(actor, candidate.id, candidate.revision);
    expect(db.memory.audit(actor, record.id).items.map((item) => item.action)).toEqual(expect.arrayContaining(["proposed", "confirmed"]));
    const state = await run(db, actor);
    db.memory.prepare(actor, { sessionId: state.session.id, turnId: state.run.id, step: 0, query: "视频", events: [] });
    const noRead = { ...actor, permissions: actor.permissions.filter((permission) => permission !== "memory.read") };
    expect(() => db.memory.references(noRead, state.session.id, state.run.id)).toThrow(expect.objectContaining({ code: "MEMORY_ACCESS_DENIED" }));
  });

  it("checks original source dependencies even when the fact did not match the current query", async () => {
    const db = repository(); const actor = identity(); const state = await run(db, actor);
    const candidate = db.memory.propose(actor, proposal(), { kind: "conversation", requestId: "remember-1",
      sessionId: state.session.id, turnId: state.run.id, eventId: state.start.id });
    const record = db.memory.confirm(actor, candidate.id, candidate.revision);
    await state.stores.events.append({ ...state.base, type: "turn.completed", payload: {
      status: "completed", assistantMessageId: "answer", outcomeSummary: "此前说过的视频偏好。",
    } });
    const next = await db.acceptRun(actor, state.session.id, "next", "完全无关问题");
    const snapshot = db.memory.prepare(actor, { sessionId: state.session.id, turnId: next.run.id, step: 0,
      query: "完全无关问题", events: await state.stores.events.read(state.session.id) });
    expect(snapshot.text).not.toContain(record.content);
    expect(db.memory.references(actor, state.session.id, next.run.id)[0]?.id).toBe(record.id);
    db.memory.forget(actor, record.id, record.revision);
    await expect(snapshot.assertCurrent(new AbortController().signal)).rejects.toMatchObject({ code: "MEMORY_CONTEXT_CHANGED" });
  });

  it("keeps organization candidate drafts out of ordinary members' memory lists", () => {
    const db = repository(); const owner = identity("alice", "crm", "tenant-a");
    const candidate = db.memory.propose(owner, proposal({ scope: "organization" }));
    const reader = { ...identity("bob", "crm", "tenant-a"), permissions: ["agent.use", "memory.read", "memory.organization.read"] };
    expect(db.memory.list(reader).items).toEqual([]);
    db.memory.confirm(owner, candidate.id, candidate.revision);
    expect(db.memory.list(reader).items[0]?.id).toBe(candidate.id);
  });

  it("persists memories and revocation across a second database connection", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "harness-memory-")); dirs.push(directory);
    const file = path.join(directory, "memory.sqlite");
    const first = repository(file); const actor = identity(); const record = active(first, actor);
    const second = repository(file);
    expect(second.memory.get(actor, record.id).content).toBe(record.content);
    second.memory.forget(actor, record.id, record.revision);
    expect(first.memory.search(actor, "视频")).toEqual([]);
  });
});
