import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { executionScopeKey, type ExecutionIdentity } from "@daoyin/harness-contracts";
import { PostgresCloudRepository } from "./postgres-repository.js";

const baseUrl = process.env.DAOYIN_TEST_POSTGRES_URL;
let databaseUrl = baseUrl;
let schema = "";
const integration = databaseUrl === undefined ? describe.skip : describe;
let repository: PostgresCloudRepository | undefined;

function identity(user = "alice"): ExecutionIdentity {
  return { actorUserId: user, space: { kind: "organization", id: "space-a", tenantId: "tenant-a" },
    appInstallationId: "story-a", authorizationId: `grant-${user}`, billingAccountId: "tenant-wallet",
    expiresAt: Date.now() + 60_000, permissions: ["agent.use", "memory.read", "memory.write", "memory.share", "memory.organization.read", "memory.organization.write"], allowedTools: [] };
}

beforeEach(async () => {
  if (databaseUrl === undefined) return;
  const admin = new Pool({ connectionString: baseUrl });
  try {
    schema = `harness_test_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(baseUrl!); url.searchParams.set("options", `-c search_path=${schema}`); databaseUrl = url.toString();
  } finally { await admin.end(); }
  repository = await PostgresCloudRepository.open(databaseUrl);
  await repository.migrate();
});

afterEach(async () => {
  await repository?.close(); repository = undefined;
  if (baseUrl && /^harness_test_[a-f0-9]{32}$/u.test(schema)) {
    const admin = new Pool({ connectionString: baseUrl });
    try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); }
  }
});

integration("cloud PostgreSQL persistence (real isolated database; no model or platform calls)", () => {
  it("enforces scoped reads, concurrent idempotency, cancellation and crash recovery", async () => {
    const db = repository!; const actor = identity();
    const session = await db.createSession(actor, { title: "recovery", profileId: "story", profileVersion: "1" });
    const results = await Promise.all([db.acceptRun(actor, session.id, "same", "hello"), db.acceptRun(actor, session.id, "same", "hello")]);
    expect(results.filter(result => result.created)).toHaveLength(1);
    await expect(db.acceptRun(actor, session.id, "same", "changed")).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(db.getSession(identity("bob"), session.id)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(db.readEvents(identity("bob"), session.id, 0, 100)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    const runId = results[0]!.run.id;
    expect(await db.requestCancellation(actor, runId)).toMatchObject({ cancelRequested: true });
    await db.acquireRuntimeLease({ recoverInterrupted: true });
    expect(await db.getRun(actor, runId)).toMatchObject({ status: "interrupted" });
    expect((await db.readEvents(actor, session.id, 0, 100)).map(event => event.type)).toEqual(["turn.interrupted"]);
  });
  it("migrates durable session events and rejects late terminal writes", async () => {
    const db = repository!;
    const actor = identity();
    const session = await db.createSession(actor, { title: "fixture", profileId: "story", profileVersion: "1" });
    const accepted = await db.acceptRun(actor, session.id, "request-1", "hello");
    const stores = await db.bindRun(actor, session.id, accepted.run.id);
    const base = { accountId: stores.accountId, scopeId: stores.scopeId, sessionId: session.id, turnId: accepted.run.id };
    await stores.events.append({ ...base, type: "turn.started", payload: { status: "running", userMessageId: "message-1", userMessage: "hello" } });
    await stores.events.append({ ...base, type: "turn.completed", payload: { status: "completed", assistantMessageId: "message-2", outcomeSummary: "answer" } });
    expect(await db.getRun(actor, accepted.run.id)).toMatchObject({ status: "completed", finalText: "answer", lastEventSeq: 2 });
    await expect(stores.events.append({ ...base, type: "assistant.delta", payload: { contentBlockId: "late", delta: "late" } })).rejects.toMatchObject({ code: "RUN_NOT_ACTIVE" });
    expect((await db.readEvents(actor, session.id, 0, 100)).map((event) => event.eventSeq)).toEqual([1, 2]);
    const second = await db.acceptRun(actor, session.id, "request-2", "again");
    const next = await db.bindRun(actor, session.id, second.run.id);
    await next.events.append({ ...base, turnId: second.run.id, type: "turn.started", payload: { status: "running", userMessageId: "m3", userMessage: "again" } });
    expect((await db.readEvents(actor, session.id, 2, 100)).map(event => event.eventSeq)).toEqual([3]);
  });

  it("keeps confirmed memory scoped, versioned and revocable", async () => {
    const db = repository!;
    const actor = identity();
    const proposal = await db.memory.propose(actor, { requestId: "remember-1", key: "video-format", scope: "organization", kind: "preference",
      content: "视频默认使用竖屏格式", keywords: ["视频", "竖屏"] });
    expect(await db.memory.search(actor, "视频")).toEqual([]);
    const active = await db.memory.confirm(actor, proposal.id, proposal.revision);
    expect((await db.memory.search(actor, "视频"))[0]?.memory.id).toBe(active.id);
    const forgotten = await db.memory.forget(actor, active.id, active.revision);
    expect(forgotten.state).toBe("forgotten");
    expect(await db.memory.search(actor, "视频")).toEqual([]);
  });

  it("fences a second runtime until the current lease is released", async () => {
    const db = repository!;
    await db.acquireRuntimeLease();
    const other = await PostgresCloudRepository.open(databaseUrl!);
    try {
      await expect(other.acquireRuntimeLease()).rejects.toMatchObject({ code: "RUNTIME_ALREADY_ACTIVE" });
      await db.releaseRuntimeLease();
      await expect(other.acquireRuntimeLease()).resolves.toMatchObject({ recoveredRuns: 0 });
    } finally { await other.close(); }
  });
  it("allows exactly one owner on concurrent first startup", async () => {
    const other = await PostgresCloudRepository.open(databaseUrl!);
    try {
      const outcomes = await Promise.allSettled([repository!.acquireRuntimeLease(), other.acquireRuntimeLease()]);
      expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    } finally { await other.close(); }
  });

  it("imports a stopped legacy SQLite database without copying its runtime lease", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "daoyin-cloud-postgres-import-"));
    const legacyPath = path.join(directory, "legacy.sqlite");
    const legacy = new DatabaseSync(legacyPath);
    const actor = identity();
    try {
      legacy.exec(`CREATE TABLE cloud_sessions (
        id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, actor_id TEXT NOT NULL, scope_id TEXT NOT NULL,
        title TEXT NOT NULL, profile_id TEXT NOT NULL, profile_version TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT`);
      legacy.prepare("INSERT INTO cloud_sessions VALUES (?,?,?,?,?,?,?,?)").run("ses_legacy", executionScopeKey(actor), actor.actorUserId,
        "legacy-scope", "legacy conversation", "story", "1", "2026-09-06T00:00:00.000Z");
    } finally { legacy.close(); }
    const previousUrl = process.env.DAOYIN_CLOUD_POSTGRES_URL;
    const previousLegacy = process.env.DAOYIN_CLOUD_LEGACY_SQLITE;
    process.env.DAOYIN_CLOUD_POSTGRES_URL = databaseUrl;
    process.env.DAOYIN_CLOUD_LEGACY_SQLITE = legacyPath;
    try {
      await import("./sqlite-to-postgres.js");
      expect((await repository!.listSessions(actor)).map((item) => item.id)).toContain("ses_legacy");
      vi.resetModules();
      await expect(import("./sqlite-to-postgres.js")).rejects.toThrow("Import requires an empty target");
      expect(await repository!.listSessions(actor)).toHaveLength(1);
    } finally {
      if (previousUrl === undefined) delete process.env.DAOYIN_CLOUD_POSTGRES_URL; else process.env.DAOYIN_CLOUD_POSTGRES_URL = previousUrl;
      if (previousLegacy === undefined) delete process.env.DAOYIN_CLOUD_LEGACY_SQLITE; else process.env.DAOYIN_CLOUD_LEGACY_SQLITE = previousLegacy;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
