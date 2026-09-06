// Invoked only by verify-p0.mjs. Creates fixture data and restores its OWN dump.
// Does not accept a production backup or configurable database destination.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") throw new Error("Windows acceptance required.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const container = process.env.DAOYIN_P0_CONTAINER ?? "";
const runId = process.env.DAOYIN_P0_RUN_ID ?? "";
const url = new URL(process.env.DAOYIN_TEST_POSTGRES_URL ?? "invalid:");
if (!/^[a-f0-9]{64}$/u.test(container) || !/^[a-f0-9]{16}$/u.test(runId) ||
    url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.username !== "p0" || url.password ||
    url.pathname !== "/daoyin_p0" || url.search || url.hash || !url.port) throw new Error("Only the runner-owned local fixture database is accepted.");
const output = resolve(root, ".cache", "p0-validation", runId, "restore.json");
if (process.argv.length !== 3 || resolve(process.argv[2]) !== output) throw new Error("Unexpected report destination.");
function docker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8", windowsHide: true, timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error("Isolated restore command failed; production was not accessed.");
  return result.stdout.trim();
}
if (process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith("npipe://")) throw new Error("Remote Docker is not allowed.");
assert.ok(docker(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]).startsWith("npipe://"));
assert.equal(docker(["inspect", "--format", '{{index .Config.Labels "com.daoyin.p0-run"}}', container]), runId);
assert.equal(docker(["port", container, "5432/tcp"]), `127.0.0.1:${url.port}`);

const { Pool } = await import("pg");
const { PostgresCloudRepository } = await import("../packages/server-cloud/dist/postgres-repository.js");
const tables = ["cloud_runtime_lease", "cloud_sessions", "cloud_runs", "cloud_events", "cloud_compactions",
  "durable_memories", "memory_requests", "memory_shares", "memory_audit", "memory_references"];
const dbUrl = (name) => { const target = new URL(url); target.pathname = `/${name}`; return target.href; };
function canonical(value) {
  if (value instanceof Date) return JSON.stringify({ $date: value.toISOString() });
  if (Buffer.isBuffer(value)) return JSON.stringify({ $bytes: value.toString("hex") });
  if (typeof value === "bigint") return JSON.stringify({ $bigint: value.toString() });
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Unsupported database value in restore comparison.");
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
async function snapshot(connectionString) {
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const result = {};
    for (const name of tables) {
      const rows = (await pool.query(`SELECT * FROM ${name}`)).rows.map(canonical).sort(); // constant table whitelist
      result[name] = { rows: rows.length, sha256: createHash("sha256").update(rows.join("\n")).digest("hex") };
    }
    return result;
  } finally { await pool.end(); }
}
const actor = { actorUserId: "p0-fixture-user", space: { kind: "organization", id: "p0-fixture-space", tenantId: "p0-fixture-tenant" },
  appInstallationId: "p0-fixture-app", authorizationId: "p0-fixture-grant", billingAccountId: "p0-fixture-payer",
  expiresAt: Date.now() + 30 * 60_000,
  permissions: ["agent.use", "memory.read", "memory.write", "memory.organization.read", "memory.organization.write"], allowedTools: [] };
const report = { schemaVersion: 1, runId, evidence: "local-postgres-fixture-dump-and-restore",
  productionBackup: false, providerCalls: 0, status: "running", tables: null, recoveredRuns: null };
let source;
let restored;
try {
  docker(["exec", container, "createdb", "-U", "p0", "daoyin_p0_source"]);
  docker(["exec", container, "createdb", "-U", "p0", "daoyin_p0_restore"]);
  source = await PostgresCloudRepository.open(dbUrl("daoyin_p0_source"));
  await source.migrate();
  const session = await source.createSession(actor, { title: "P0 fixture only", profileId: "fixture", profileVersion: "1" });
  const first = await source.acceptRun(actor, session.id, "request-complete", "fixture input");
  const bound = await source.bindRun(actor, session.id, first.run.id);
  const base = { accountId: bound.accountId, scopeId: bound.scopeId, sessionId: session.id, turnId: first.run.id };
  await bound.events.append({ ...base, type: "turn.started", payload: { status: "running", userMessageId: "fixture-user-message", userMessage: "fixture input" } });
  await bound.events.append({ ...base, type: "assistant.delta", payload: { contentBlockId: "fixture-text", delta: "fixture answer" } });
  await bound.events.append({ ...base, type: "turn.completed", payload: { status: "completed", assistantMessageId: "fixture-answer", outcomeSummary: "fixture answer" } });
  const pending = await source.acceptRun(actor, session.id, "request-interrupted", "fixture interrupted input");
  const memory = await source.memory.propose(actor, { requestId: "fixture-memory", key: "video-format", scope: "organization",
    kind: "preference", content: "Fixture video preference", keywords: ["video"] });
  await source.memory.confirm(actor, memory.id, memory.revision);
  await source.close(); source = undefined;
  const before = await snapshot(dbUrl("daoyin_p0_source"));
  docker(["exec", container, "pg_dump", "-U", "p0", "--format=custom", "--no-owner", "--no-acl", "--file=/tmp/p0-fixture.dump", "daoyin_p0_source"]);
  // No --create/--clean: the destination is explicitly the new empty fixture DB.
  docker(["exec", container, "pg_restore", "-U", "p0", "--single-transaction", "--no-owner", "--no-acl", "--dbname=daoyin_p0_restore", "/tmp/p0-fixture.dump"]);
  const after = await snapshot(dbUrl("daoyin_p0_restore"));
  assert.deepEqual(after, before, "Restored table counts/content hashes differ from the fixture source.");
  report.tables = after;
  restored = await PostgresCloudRepository.open(dbUrl("daoyin_p0_restore"));
  await restored.verifySchema();
  const recovery = await restored.acquireRuntimeLease({ recoverInterrupted: true });
  assert.equal(recovery.recoveredRuns, 1);
  assert.equal((await restored.getRun(actor, pending.run.id)).status, "interrupted");
  assert.equal((await restored.getRun(actor, first.run.id)).status, "completed");
  const reused = await restored.acceptRun(actor, session.id, "request-complete", "fixture input");
  assert.equal(reused.created, false);
  assert.equal(reused.run.id, first.run.id);
  report.recoveredRuns = recovery.recoveredRuns;
  report.status = "passed-fixture-only";
  console.log("P0 fixture restore: table hashes match; interrupted state reconciled; no Agent/model execution.");
} catch {
  report.status = "failed";
  process.exitCode = 1;
  console.error("P0 fixture restore did not pass. No production backup was read or restored.");
} finally {
  await source?.close();
  try { await restored?.releaseRuntimeLease(); } finally { await restored?.close(); }
  report.finishedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
}
