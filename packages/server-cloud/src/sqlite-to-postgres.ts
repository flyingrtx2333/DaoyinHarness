import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { migratePostgres } from "./postgres-repository.js";

const databaseUrl = process.env.DAOYIN_CLOUD_POSTGRES_URL ?? "";
const legacyPath = process.env.DAOYIN_CLOUD_LEGACY_SQLITE ?? "";
try {
  const url = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("unsupported protocol");
} catch {
  throw new Error("Set DAOYIN_CLOUD_POSTGRES_URL to a PostgreSQL connection URL before importing.");
}
if (!isAbsolute(legacyPath)) throw new Error("Set DAOYIN_CLOUD_LEGACY_SQLITE to the absolute path of a stopped legacy SQLite database.");

const tables: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["cloud_sessions", ["id", "scope_key", "actor_id", "scope_id", "title", "profile_id", "profile_version", "created_at"]],
  ["cloud_runs", ["id", "scope_key", "session_id", "request_id", "input_hash", "user_message", "status", "final_text", "last_event_seq", "cancel_requested", "authorization_id", "billing_account_id", "created_at"]],
  ["cloud_events", ["session_id", "event_seq", "turn_id", "event_id", "body"]],
  ["cloud_compactions", ["session_id", "source_end_seq", "body"]],
  ["durable_memories", ["id", "domain_key", "owner_key", "origin_app", "created_by", "root_key", "fact_key", "memory_scope", "kind", "content", "keywords", "source", "revision", "state", "supersedes", "replaces_revision", "created_at", "expires_at"]],
  ["memory_requests", ["request_key", "input_hash", "memory_id"]],
  ["memory_shares", ["id", "memory_id", "revision", "target_app", "expires_at", "revoked", "created_by", "created_at"]],
  ["memory_audit", ["id", "memory_id", "revision", "actor_id", "action", "created_at"]],
  ["memory_references", ["consumer_scope", "session_id", "turn_id", "step", "memory_id", "revision", "grant_id", "reasons", "created_at"]],
];

const legacy = new DatabaseSync(legacyPath, { readOnly: true });
const pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5_000 });
try {
  const present = new Set(legacy.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => String(row.name)));
  if (legacy.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") throw new Error("Legacy SQLite integrity check failed.");
  if (present.has("cloud_runs") && Number(legacy.prepare("SELECT COUNT(*) AS n FROM cloud_runs WHERE status='running'").get()?.n) > 0) {
    throw new Error("Stop admissions and finish active runs before importing.");
  }
  await migratePostgres(pool);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`LOCK TABLE ${tables.map(([table]) => table).join(",")} IN ACCESS EXCLUSIVE MODE`);
    for (const [table] of tables) {
      if (Number((await client.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0]?.n) !== 0) {
        throw new Error(`Import requires an empty target: ${table} contains existing data.`);
      }
    }
    let copied = 0;
    for (const [table, columns] of tables) {
      if (!present.has(table)) continue;
      const rows = legacy.prepare(`SELECT ${columns.join(",")} FROM ${table}`).all();
      const fields = columns.join(",");
      const placeholders = columns.map((_column, index) => `$${String(index + 1)}`).join(",");
      for (const row of rows) {
        const values = columns.map((column) => column === "cancel_requested" || column === "revoked" ? Number(row[column]) !== 0 : row[column] ?? null);
        await client.query(`INSERT INTO ${table}(${fields}) VALUES (${placeholders})`, values);
        copied += 1;
      }
      if (Number((await client.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0]?.n) !== rows.length) {
        throw new Error(`Import count mismatch: ${table}`);
      }
    }
    await client.query("COMMIT");
    process.stdout.write(`Legacy SQLite import completed; copied and count-verified ${String(copied)} rows.\n`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
} finally {
  legacy.close();
  await pool.end();
}
