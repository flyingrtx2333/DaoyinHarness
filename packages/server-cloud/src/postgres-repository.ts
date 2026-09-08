import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { assertHistoryAdmission, readCompleteHistory } from "./history-policy.js";
import { assertExecutionIdentity, executionScopeKey, type AppendCompactionInput, type ExecutionIdentity, type ExecutionScope } from "@daoyin/harness-contracts";
import type { AgentEvent, AgentEventType, PendingAgentEvent, SessionCompaction } from "@daoyin/harness-protocol";
import { PostgresMemoryRepository, migratePostgresMemory } from "./postgres-memory-repository.js";
import { CloudError, type BoundRunStores, type CloudChildInput, type CloudChildRun, type CloudRepository, type CloudRun, type CloudSession, type SessionAction } from "./repository.js";
import { applySessionAction, sessionState } from "./session-management.js";

type Row = Record<string, unknown>;
type TransactionClient = PoolClient;
const now = (): string => new Date().toISOString();
const id = (prefix: string): string => `${prefix}_${randomUUID()}`;
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const notFound = (): CloudError => new CloudError(404, "RESOURCE_NOT_FOUND", "资源不存在或当前身份无权访问。");
const asNumber = (value: unknown): number => Number(value);
const asBoolean = (value: unknown): boolean => value === true || value === 1 || value === "1" || value === "t";

function session(row: Row): CloudSession {
  const state = sessionState(row);
  return { id: String(row.id), title: String(row.title), profileId: String(row.profile_id),
    profileVersion: String(row.profile_version), createdAt: String(row.created_at),
    pinnedAt: state.pinnedAt, archivedAt: state.archivedAt };
}

function run(row: Row): CloudRun {
  return { id: String(row.id), sessionId: String(row.session_id), requestId: String(row.request_id),
    userMessage: String(row.user_message), status: row.status as CloudRun["status"], finalText: String(row.final_text),
    lastEventSeq: asNumber(row.last_event_seq), cancelRequested: asBoolean(row.cancel_requested),
    authorizationId: String(row.authorization_id), billingAccountId: String(row.billing_account_id), createdAt: String(row.created_at) };
}

const cloudSchema = [
  `CREATE TABLE IF NOT EXISTS cloud_runtime_lease (
    singleton SMALLINT PRIMARY KEY CHECK(singleton=1), owner_id TEXT NOT NULL, expires_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_sessions (
    id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, actor_id TEXT NOT NULL, scope_id TEXT NOT NULL,
    title TEXT NOT NULL, profile_id TEXT NOT NULL, profile_version TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  "ALTER TABLE cloud_sessions ADD COLUMN IF NOT EXISTS pinned_at TEXT",
  "ALTER TABLE cloud_sessions ADD COLUMN IF NOT EXISTS archived_at TEXT",
  "ALTER TABLE cloud_sessions ADD COLUMN IF NOT EXISTS deleted_at TEXT",
  "CREATE INDEX IF NOT EXISTS cloud_sessions_scope ON cloud_sessions(scope_key, created_at)",
  `CREATE TABLE IF NOT EXISTS cloud_runs (
    id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES cloud_sessions(id),
    request_id TEXT NOT NULL, input_hash TEXT NOT NULL, user_message TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled','interrupted')),
    final_text TEXT NOT NULL DEFAULT '', last_event_seq INTEGER NOT NULL DEFAULT 0,
    cancel_requested BOOLEAN NOT NULL DEFAULT FALSE, authorization_id TEXT NOT NULL,
    billing_account_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(session_id, request_id)
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS cloud_one_active_run ON cloud_runs(session_id) WHERE status='running'",
  "CREATE INDEX IF NOT EXISTS cloud_runs_scope ON cloud_runs(scope_key, session_id)",
  `CREATE TABLE IF NOT EXISTS cloud_child_runs (
    parent_run_id TEXT NOT NULL REFERENCES cloud_runs(id),
    parent_session_id TEXT NOT NULL REFERENCES cloud_sessions(id),
    operation_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, node_id TEXT NOT NULL,
    child_run_id TEXT NOT NULL UNIQUE REFERENCES cloud_runs(id),
    child_session_id TEXT NOT NULL UNIQUE REFERENCES cloud_sessions(id),
    scope_key TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(parent_run_id, operation_id)
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_events (
    session_id TEXT NOT NULL REFERENCES cloud_sessions(id), event_seq INTEGER NOT NULL,
    turn_id TEXT NOT NULL REFERENCES cloud_runs(id), event_id TEXT NOT NULL UNIQUE,
    body TEXT NOT NULL, PRIMARY KEY(session_id, event_seq)
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_compactions (
    session_id TEXT NOT NULL REFERENCES cloud_sessions(id), source_end_seq INTEGER NOT NULL,
    body TEXT NOT NULL, PRIMARY KEY(session_id, source_end_seq)
  )`,
];

/** Explicit operator migration. Normal cloud startup only verifies this schema. */
export async function migratePostgres(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const statement of cloudSchema) await client.query(statement);
    await migratePostgresMemory(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

/** PostgreSQL cloud store. Every state mutation checks the current runtime lease in its transaction. */
export class PostgresCloudRepository implements CloudRepository {
  public readonly memory: PostgresMemoryRepository;
  #leaseOwner: string | null = null;
  #leaseDurationMs = 30_000;

  private constructor(private readonly pool: Pool) {
    this.memory = new PostgresMemoryRepository(pool, (operation) => this.#transaction(operation));
  }

  public static async open(connectionString: string): Promise<PostgresCloudRepository> {
    const pool = new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
    try {
      await pool.query("SELECT 1");
      return new PostgresCloudRepository(pool);
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
  }

  public async close(): Promise<void> { await this.pool.end(); }

  public async checkReadiness(): Promise<void> {
    if (this.#leaseOwner === null) throw new Error("Runtime lease not acquired.");
    await this.verifySchema();
    // Read-only probe of required column shape and write privileges; NOT a write test.
    await this.pool.query("SELECT session_id,event_seq,turn_id,event_id,body FROM cloud_events WHERE FALSE");
    await this.pool.query("SELECT id,scope_key,session_id,request_id,input_hash,user_message,status,final_text,last_event_seq,cancel_requested,authorization_id,billing_account_id,created_at FROM cloud_runs WHERE FALSE");
    const result = await this.pool.query<{ ready: boolean }>(`SELECT current_setting('transaction_read_only')='off'
      AND NOT pg_is_in_recovery() AND has_table_privilege('cloud_events','SELECT')
      AND has_table_privilege('cloud_events','INSERT') AND has_table_privilege('cloud_runs','SELECT')
      AND has_table_privilege('cloud_runs','INSERT') AND has_table_privilege('cloud_runs','UPDATE')
      AND has_table_privilege('cloud_sessions','SELECT') AND has_table_privilege('cloud_sessions','INSERT')
      AND has_table_privilege('cloud_sessions','UPDATE') AS ready`);
    if (result.rows[0]?.ready !== true) throw new Error("Database permissions or role are not ready.");
    await this.assertExecutionOwner();
  }

  public async migrate(): Promise<void> { await migratePostgres(this.pool); }

  public async verifySchema(): Promise<void> {
    const required = ["cloud_runtime_lease", "cloud_sessions", "cloud_runs", "cloud_events", "cloud_compactions",
      "durable_memories", "memory_requests", "memory_shares", "memory_audit", "memory_references"];
    const result = await this.pool.query<{ relation: string | null }>("SELECT to_regclass($1) AS relation", ["cloud_runtime_lease"]);
    if (result.rows[0]?.relation === null) throw new Error("PostgreSQL schema has not been migrated.");
    for (const table of required.slice(1)) {
      const check = await this.pool.query<{ relation: string | null }>("SELECT to_regclass($1) AS relation", [table]);
      if (check.rows[0]?.relation === null) throw new Error("PostgreSQL schema is incomplete.");
    }
    // Fail readiness before serving the new API against an unmigrated database.
    await this.pool.query("SELECT pinned_at,archived_at,deleted_at FROM cloud_sessions WHERE FALSE");
    await this.pool.query("SELECT parent_run_id,parent_session_id,operation_id,tool_call_id,node_id,child_run_id,child_session_id,scope_key,created_at FROM cloud_child_runs WHERE FALSE");
  }

  public async acquireRuntimeLease(options: { durationMs?: number; recoverInterrupted?: boolean } = {}): Promise<{ recoveredRuns: number }> {
    const duration = options.durationMs ?? 30_000;
    if (!Number.isSafeInteger(duration) || duration < 1_000 || duration > 300_000 || this.#leaseOwner !== null) {
      throw new CloudError(409, "RUNTIME_LEASE_INVALID", "运行租约参数无效或当前连接已经取得租约。");
    }
    const owner = id("runtime");
    const result = await this.#transaction(async (client) => {
      // The singleton row may not exist yet: row locks alone cannot fence first startup.
      await client.query("SELECT pg_advisory_xact_lock(13820491)");
      const instant = Date.now();
      const current = await client.query<Row>("SELECT * FROM cloud_runtime_lease WHERE singleton=1 FOR UPDATE");
      if (current.rows[0] !== undefined && asNumber(current.rows[0].expires_at) > instant) {
        throw new CloudError(409, "RUNTIME_ALREADY_ACTIVE", "该数据库已有有效执行实例，不能同时启动第二个服务。");
      }
      await client.query(`INSERT INTO cloud_runtime_lease(singleton,owner_id,expires_at) VALUES (1,$1,$2)
        ON CONFLICT(singleton) DO UPDATE SET owner_id=EXCLUDED.owner_id,expires_at=EXCLUDED.expires_at`, [owner, instant + duration]);
      let recoveredRuns = 0;
      if (options.recoverInterrupted === true) {
        const active = await client.query<Row>("SELECT id,scope_key FROM cloud_runs WHERE status='running' FOR UPDATE");
        for (const item of active.rows) await this.#interrupt(client, String(item.scope_key), String(item.id), "runtime_restart");
        recoveredRuns = active.rows.length;
      }
      return { recoveredRuns };
    }, false);
    this.#leaseOwner = owner;
    this.#leaseDurationMs = duration;
    return result;
  }

  public async renewRuntimeLease(): Promise<boolean> {
    if (this.#leaseOwner === null) return false;
    const instant = Date.now();
    const result = await this.pool.query("UPDATE cloud_runtime_lease SET expires_at=$1 WHERE singleton=1 AND owner_id=$2 AND expires_at>$3",
      [instant + this.#leaseDurationMs, this.#leaseOwner, instant]);
    return result.rowCount === 1;
  }

  public async assertExecutionOwner(): Promise<void> {
    if (this.#leaseOwner === null) return;
    const result = await this.pool.query<Row>("SELECT * FROM cloud_runtime_lease WHERE singleton=1");
    const row = result.rows[0];
    if (row === undefined || String(row.owner_id) !== this.#leaseOwner || asNumber(row.expires_at) <= Date.now()) {
      throw new CloudError(503, "RUNTIME_LEASE_LOST", "当前实例不再拥有执行租约，不能继续模型、工具或状态写入。");
    }
  }

  public async releaseRuntimeLease(): Promise<void> {
    if (this.#leaseOwner === null) return;
    const owner = this.#leaseOwner;
    this.#leaseOwner = null;
    await this.pool.query("UPDATE cloud_runtime_lease SET expires_at=0 WHERE singleton=1 AND owner_id=$1", [owner]);
  }

  public async createSession(scope: ExecutionScope, input: Omit<CloudSession, "id" | "createdAt">): Promise<CloudSession> {
    const key = executionScopeKey(scope);
    if (!input.title.trim() || input.title.length > 120 || !input.profileId || !input.profileVersion) {
      throw new CloudError(400, "SESSION_INPUT_INVALID", "会话配置无效。");
    }
    return this.#transaction(async (client) => {
      const count = await client.query<{ n: string }>(`SELECT COUNT(*) AS n FROM cloud_sessions s WHERE scope_key=$1
        AND NOT EXISTS (SELECT 1 FROM cloud_child_runs c WHERE c.child_session_id=s.id)`, [key]);
      if (asNumber(count.rows[0]?.n) >= 500) throw new CloudError(429, "SESSION_LIMIT", "当前空间的试运行会话数量已达上限。");
      const result: CloudSession = { ...input, id: id("ses"), createdAt: now() };
      await client.query(`INSERT INTO cloud_sessions(id,scope_key,actor_id,scope_id,title,profile_id,profile_version,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [result.id, key, scope.actorUserId, `cloud_${digest(key)}`,
        input.title.trim(), input.profileId, input.profileVersion, result.createdAt]);
      return result;
    });
  }

  public async listSessions(scope: ExecutionScope): Promise<CloudSession[]> {
    const result = await this.pool.query<Row>(`SELECT * FROM cloud_sessions s WHERE scope_key=$1 AND deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM cloud_child_runs c WHERE c.child_session_id=s.id)
      ORDER BY (pinned_at IS NOT NULL) DESC,pinned_at DESC,created_at DESC,id DESC LIMIT 500`, [executionScopeKey(scope)]);
    return result.rows.map(session);
  }

  public async getSession(scope: ExecutionScope, sessionId: string): Promise<CloudSession> {
    return session(await this.#session(this.pool, executionScopeKey(scope), sessionId));
  }

  public async manageSession(scope: ExecutionScope, sessionId: string, action: SessionAction): Promise<CloudSession | null> {
    const key = executionScopeKey(scope);
    return this.#transaction(async (client) => {
      // The same session lock fences new Run admission, including other tabs.
      const current = await this.#session(client, key, sessionId, true, action === "delete");
      const child = await client.query("SELECT 1 FROM cloud_child_runs WHERE child_session_id=$1", [sessionId]);
      if (child.rows.length) throw new CloudError(409, "CHILD_SESSION_READ_ONLY", "请管理父会话；子会话保留为执行证据。");
      const next = applySessionAction(sessionState(current), action);
      if (action === "archive" || action === "delete") {
        const active = await client.query("SELECT id FROM cloud_runs WHERE session_id=$1 AND status='running'", [sessionId]);
        if (active.rows.length) throw new CloudError(409, "SESSION_BUSY", "会话正在生成，请先停止生成后再操作。");
      }
      const result = await client.query<Row>(`UPDATE cloud_sessions SET pinned_at=$1,archived_at=$2,deleted_at=$3
        WHERE id=$4 AND scope_key=$5 RETURNING *`, [next.pinnedAt, next.archivedAt, next.deletedAt, sessionId, key]);
      return next.deletedAt ? null : session(result.rows[0]!);
    });
  }

  public async acceptRun(identity: ExecutionIdentity, sessionId: string, requestId: string, userMessage: string): Promise<{ run: CloudRun; created: boolean }> {
    assertExecutionIdentity(identity);
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(requestId) || !userMessage.trim() || userMessage.length > 10_000) {
      throw new CloudError(400, "RUN_INPUT_INVALID", "请求标识或消息无效。");
    }
    const key = executionScopeKey(identity);
    return this.#transaction(async (client) => {
      const selectedSession = await this.#session(client, key, sessionId, true);
      const childSession = await client.query("SELECT 1 FROM cloud_child_runs WHERE child_session_id=$1", [sessionId]);
      if (childSession.rows.length) throw new CloudError(409, "CHILD_SESSION_READ_ONLY", "子会话仅用于委派审计，请在父会话继续任务。");
      const inputHash = digest(userMessage);
      const previous = await client.query<Row>("SELECT * FROM cloud_runs WHERE session_id=$1 AND request_id=$2 AND scope_key=$3 FOR UPDATE", [sessionId, requestId, key]);
      if (previous.rows[0] !== undefined) {
        if (String(previous.rows[0].input_hash) !== inputHash) throw new CloudError(409, "IDEMPOTENCY_CONFLICT", "同一请求标识不能用于不同消息。");
        return { run: run(previous.rows[0]), created: false };
      }
      if (selectedSession.archived_at) throw new CloudError(409, "SESSION_ARCHIVED", "请先恢复已归档的会话。");
      const active = await client.query("SELECT id FROM cloud_runs WHERE session_id=$1 AND status='running' FOR UPDATE", [sessionId]);
      if (active.rows[0] !== undefined) throw new CloudError(409, "SESSION_BUSY", "当前会话已有任务，请等待完成或取消。");
      const usage = await client.query<{ events: string; bytes: string; runs: string }>(`SELECT COUNT(*) AS events,
        COALESCE(SUM(octet_length(body)),0) AS bytes,
        (SELECT COUNT(*) FROM cloud_runs WHERE session_id=$1) AS runs FROM cloud_events WHERE session_id=$1`, [sessionId]);
      assertHistoryAdmission({ events: Number(usage.rows[0]?.events), bytes: Number(usage.rows[0]?.bytes), runs: Number(usage.rows[0]?.runs) });
      const runId = id("run");
      await client.query(`INSERT INTO cloud_runs(id,scope_key,session_id,request_id,input_hash,user_message,status,authorization_id,billing_account_id,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,'running',$7,$8,$9)`, [runId, key, sessionId, requestId, inputHash, userMessage,
        identity.authorizationId, identity.billingAccountId, now()]);
      return { run: run(await this.#run(client, key, runId)), created: true };
    });
  }

  public async acceptChildRun(identity: ExecutionIdentity, parentRunId: string, input: CloudChildInput): Promise<{ child: CloudChildRun; created: boolean }> {
    assertExecutionIdentity(identity);
    if (identity.space.kind === "public" || !identity.permissions.includes("agent.use")) throw notFound();
    if (![input.operationId, input.toolCallId, input.nodeId].every((value) => /^[A-Za-z0-9_-]{1,128}$/u.test(value)) ||
        !input.instruction.trim() || input.instruction.length > 10_000) throw new CloudError(400, "CHILD_INPUT_INVALID", "子任务参数无效。");
    const key = executionScopeKey(identity);
    return this.#transaction(async (client) => {
      // Serialize child admission against parent cancellation/termination and other siblings.
      const parent = await this.#run(client, key, parentRunId, true);
      if (parent.status !== "running" || asBoolean(parent.cancel_requested) || parent.authorization_id !== identity.authorizationId ||
          parent.billing_account_id !== identity.billingAccountId) throw new CloudError(409, "PARENT_NOT_ACTIVE", "父任务已结束、取消或授权不匹配。");
      const nested = await client.query("SELECT 1 FROM cloud_child_runs WHERE child_run_id=$1", [parentRunId]);
      if (nested.rows.length) throw new CloudError(409, "CHILD_RECURSION_DENIED", "子 Agent 不能继续委派。");
      const existing = await client.query<Row>(`SELECT r.*,c.tool_call_id,c.node_id FROM cloud_child_runs c JOIN cloud_runs r ON r.id=c.child_run_id
        WHERE c.parent_run_id=$1 AND c.operation_id=$2 AND c.scope_key=$3`, [parentRunId, input.operationId, key]);
      const parentSessionId = String(parent.session_id);
      const previous = existing.rows[0];
      if (previous !== undefined) {
        if (previous.input_hash !== digest(input.instruction) || previous.tool_call_id !== input.toolCallId || previous.node_id !== input.nodeId) {
          throw new CloudError(409, "IDEMPOTENCY_CONFLICT", "同一子任务标识不能用于不同输入。");
        }
        return { child: { parentRunId, parentSessionId, operationId: input.operationId, toolCallId: input.toolCallId, nodeId: input.nodeId, run: run(previous) }, created: false };
      }
      const count = await client.query<{ n: string }>("SELECT COUNT(*) AS n FROM cloud_child_runs WHERE parent_run_id=$1", [parentRunId]);
      if (Number(count.rows[0]?.n) >= 8) throw new CloudError(429, "CHILD_RUN_LIMIT", "本轮子 Agent 数量已达上限。");
      const parentSession = await this.#session(client, key, parentSessionId);
      const sessionId = id("ses"); const runId = id("run"); const createdAt = now();
      await client.query(`INSERT INTO cloud_sessions(id,scope_key,actor_id,scope_id,title,profile_id,profile_version,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [sessionId, key, identity.actorUserId, parentSession.scope_id,
        `子任务 · ${input.nodeId}`, parentSession.profile_id, parentSession.profile_version, createdAt]);
      await client.query(`INSERT INTO cloud_runs(id,scope_key,session_id,request_id,input_hash,user_message,status,authorization_id,billing_account_id,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,'running',$7,$8,$9)`, [runId, key, sessionId, input.operationId, digest(input.instruction), input.instruction,
        identity.authorizationId, identity.billingAccountId, createdAt]);
      await client.query(`INSERT INTO cloud_child_runs(parent_run_id,parent_session_id,operation_id,tool_call_id,node_id,child_run_id,child_session_id,scope_key,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [parentRunId, parentSessionId, input.operationId, input.toolCallId, input.nodeId, runId, sessionId, key, createdAt]);
      return { child: { parentRunId, parentSessionId, operationId: input.operationId, toolCallId: input.toolCallId, nodeId: input.nodeId,
        run: run(await this.#run(client, key, runId)) }, created: true };
    });
  }

  public async listChildRuns(scope: ExecutionScope, parentRunId: string): Promise<CloudChildRun[]> {
    const key = executionScopeKey(scope);
    await this.#run(this.pool, key, parentRunId);
    const result = await this.pool.query<Row>(`SELECT r.*,c.parent_run_id,c.parent_session_id,c.operation_id,c.tool_call_id,c.node_id
      FROM cloud_child_runs c JOIN cloud_runs r ON r.id=c.child_run_id AND r.scope_key=c.scope_key
      WHERE c.parent_run_id=$1 AND c.scope_key=$2 ORDER BY c.created_at,c.node_id LIMIT 8`, [parentRunId, key]);
    return result.rows.map((row) => ({ parentRunId: String(row.parent_run_id), parentSessionId: String(row.parent_session_id),
      toolCallId: String(row.tool_call_id), nodeId: String(row.node_id), operationId: String(row.operation_id), run: run(row) }));
  }

  public async getRun(scope: ExecutionScope, runId: string): Promise<CloudRun> { return run(await this.#run(this.pool, executionScopeKey(scope), runId)); }

  public async findRequest(scope: ExecutionScope, sessionId: string, requestId: string): Promise<CloudRun | undefined> {
    const key = executionScopeKey(scope);
    await this.#session(this.pool, key, sessionId);
    const result = await this.pool.query<Row>("SELECT * FROM cloud_runs WHERE scope_key=$1 AND session_id=$2 AND request_id=$3", [key, sessionId, requestId]);
    return result.rows[0] === undefined ? undefined : run(result.rows[0]);
  }

  public async listRuns(scope: ExecutionScope, sessionId: string): Promise<CloudRun[]> {
    const key = executionScopeKey(scope);
    await this.#session(this.pool, key, sessionId);
    const result = await this.pool.query<Row>("SELECT * FROM cloud_runs WHERE scope_key=$1 AND session_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100", [key, sessionId]);
    return result.rows.map(run);
  }

  public async readEvents(scope: ExecutionScope, sessionId: string, afterEventSeq: number, limit: number): Promise<AgentEvent[]> {
    await this.#session(this.pool, executionScopeKey(scope), sessionId);
    if (!Number.isSafeInteger(afterEventSeq) || afterEventSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new CloudError(400, "EVENT_CURSOR_INVALID", "事件游标或分页数量无效。");
    }
    return this.#readEvents(this.pool, sessionId, afterEventSeq, limit);
  }

  public async bindRun(scope: ExecutionScope, sessionId: string, runId: string): Promise<BoundRunStores> {
    const key = executionScopeKey(scope);
    const selectedSession = await this.#session(this.pool, key, sessionId);
    const selectedRun = await this.#run(this.pool, key, runId);
    if (String(selectedRun.session_id) !== sessionId) throw notFound();
    const accountId = String(selectedSession.actor_id);
    const scopeId = String(selectedSession.scope_id);
    const check = async (requested: string): Promise<void> => {
      if (requested !== sessionId) throw notFound();
      await this.#session(this.pool, key, sessionId);
    };
    return { accountId, scopeId,
      events: {
        append: async (pending) => {
          if (pending.sessionId !== sessionId || pending.turnId !== runId || pending.accountId !== accountId || pending.scopeId !== scopeId) {
            throw new CloudError(403, "EVENT_SCOPE_MISMATCH", "事件与执行身份不匹配。");
          }
          return this.#transaction((client) => this.#append(client, key, pending));
        },
        read: async (requested, after = 0) => {
          await check(requested);
          if (!Number.isSafeInteger(after) || after < 0) throw new CloudError(400, "EVENT_CURSOR_INVALID", "事件游标无效。");
          return readCompleteHistory(sessionId, after, (cursor, limit) => this.#readEvents(this.pool, sessionId, cursor, limit));
        },
      },
      compactions: {
        append: async (input) => { await check(input.sessionId); return this.#appendCompaction(key, runId, input); },
        list: async (requested) => { await check(requested); return this.#compactions(this.pool, sessionId); },
        latest: async (requested) => { await check(requested); return (await this.#compactions(this.pool, sessionId)).at(-1); },
      },
    };
  }

  public async requestCancellation(scope: ExecutionScope, runId: string): Promise<CloudRun> {
    const key = executionScopeKey(scope);
    return this.#transaction(async (client) => {
      await this.#run(client, key, runId, true);
      const child = await client.query("SELECT 1 FROM cloud_child_runs WHERE child_run_id=$1", [runId]);
      if (child.rows.length) throw new CloudError(409, "CANCEL_PARENT_RUN", "请取消父任务，系统会一并停止其子 Agent。");
      await client.query("UPDATE cloud_runs SET cancel_requested=TRUE WHERE id=$1 AND scope_key=$2 AND status='running'", [runId, key]);
      return run(await this.#run(client, key, runId));
    });
  }

  public async interruptRun(scope: ExecutionScope, runId: string, reason: "runtime_restart" | "runtime_recovery"): Promise<void> {
    const key = executionScopeKey(scope);
    await this.#transaction((client) => this.#interrupt(client, key, runId, reason));
  }

  async #transaction<T>(operation: (client: TransactionClient) => Promise<T>, enforceLease = true): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (enforceLease) await this.#assertLease(client);
      const value = await operation(client);
      if (enforceLease) await this.#assertLease(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async #assertLease(client: TransactionClient): Promise<void> {
    if (this.#leaseOwner === null) return;
    const result = await client.query<Row>("SELECT * FROM cloud_runtime_lease WHERE singleton=1 FOR SHARE");
    const row = result.rows[0];
    if (row === undefined || String(row.owner_id) !== this.#leaseOwner || asNumber(row.expires_at) <= Date.now()) {
      throw new CloudError(503, "RUNTIME_LEASE_LOST", "当前实例不再拥有执行租约，不能继续模型、工具或状态写入。");
    }
  }

  async #session(client: Pool | TransactionClient, key: string, sessionId: string, lock = false, includeDeleted = false): Promise<Row> {
    const result = await client.query<Row>(`SELECT * FROM cloud_sessions WHERE id=$1 AND scope_key=$2${includeDeleted ? "" : " AND deleted_at IS NULL"}${lock ? " FOR UPDATE" : ""}`, [sessionId, key]);
    if (result.rows[0] === undefined) throw notFound();
    const parent = await client.query(`SELECT 1 FROM cloud_child_runs c JOIN cloud_sessions p ON p.id=c.parent_session_id
      WHERE c.child_session_id=$1 AND p.deleted_at IS NOT NULL`, [String(result.rows[0].session_id ?? result.rows[0].id)]);
    if (parent.rows.length) throw notFound();
    return result.rows[0];
  }

  async #run(client: Pool | TransactionClient, key: string, runId: string, lock = false): Promise<Row> {
    const result = await client.query<Row>(`SELECT r.* FROM cloud_runs r JOIN cloud_sessions s ON s.id=r.session_id
      WHERE r.id=$1 AND r.scope_key=$2 AND s.scope_key=$2 AND s.deleted_at IS NULL${lock ? " FOR UPDATE OF r" : ""}`, [runId, key]);
    if (result.rows[0] === undefined) throw notFound();
    const parent = await client.query(`SELECT 1 FROM cloud_child_runs c JOIN cloud_sessions p ON p.id=c.parent_session_id
      WHERE c.child_session_id=$1 AND p.deleted_at IS NOT NULL`, [String(result.rows[0].session_id ?? result.rows[0].id)]);
    if (parent.rows.length) throw notFound();
    return result.rows[0];
  }

  async #readEvents(client: Pool | TransactionClient, sessionId: string, after: number, limit: number): Promise<AgentEvent[]> {
    const result = await client.query<Row>("SELECT body FROM cloud_events WHERE session_id=$1 AND event_seq>$2 ORDER BY event_seq LIMIT $3", [sessionId, after, limit]);
    return result.rows.map((row) => JSON.parse(String(row.body)) as AgentEvent);
  }

  async #append<TType extends AgentEventType>(client: TransactionClient, key: string, pending: PendingAgentEvent<TType>): Promise<AgentEvent> {
    const selectedRun = await this.#run(client, key, pending.turnId, true);
    if (String(selectedRun.session_id) !== pending.sessionId || selectedRun.status !== "running") {
      throw new CloudError(409, "RUN_NOT_ACTIVE", "该任务已结束，不能追加执行结果。");
    }
    const tail = await client.query<{ n: string }>("SELECT COALESCE(MAX(event_seq),0) AS n FROM cloud_events WHERE session_id=$1", [pending.sessionId]);
    const event = { ...pending, id: id("evt"), eventSeq: asNumber(tail.rows[0]?.n) + 1, occurredAt: now() } as AgentEvent;
    const body = JSON.stringify(event);
    if (Buffer.byteLength(body, "utf8") > 128_000) throw new CloudError(413, "EVENT_TOO_LARGE", "工具或模型结果超过事件存储上限。");
    await client.query("INSERT INTO cloud_events(session_id,event_seq,turn_id,event_id,body) VALUES ($1,$2,$3,$4,$5)",
      [event.sessionId, event.eventSeq, event.turnId, event.id, body]);
    let status: CloudRun["status"] = "running";
    let finalText = "";
    if (event.type === "turn.completed" || event.type === "turn.failed") { status = event.payload.status; finalText = event.payload.outcomeSummary; }
    else if (event.type === "turn.cancelled") { status = "cancelled"; finalText = "任务已停止。"; }
    else if (event.type === "turn.interrupted") { status = "interrupted"; finalText = "执行被中断，已保留记录；未自动重试外部操作。"; }
    await client.query("UPDATE cloud_runs SET last_event_seq=$1,status=$2,final_text=$3 WHERE id=$4 AND scope_key=$5 AND status='running'",
      [event.eventSeq, status, finalText, event.turnId, key]);
    return event;
  }

  async #interrupt(client: TransactionClient, key: string, runId: string, reason: "runtime_restart" | "runtime_recovery"): Promise<void> {
    const selectedRun = await this.#run(client, key, runId, true);
    if (selectedRun.status !== "running") return;
    const selectedSession = await this.#session(client, key, String(selectedRun.session_id));
    await this.#append(client, key, { type: "turn.interrupted", accountId: String(selectedSession.actor_id), scopeId: String(selectedSession.scope_id),
      sessionId: String(selectedRun.session_id), turnId: runId,
      payload: { status: "interrupted", reason, lastCompletedEventSeq: asNumber(selectedRun.last_event_seq) } });
  }

  async #compactions(client: Pool | TransactionClient, sessionId: string): Promise<SessionCompaction[]> {
    const result = await client.query<Row>("SELECT body FROM cloud_compactions WHERE session_id=$1 ORDER BY source_end_seq", [sessionId]);
    return result.rows.map((row) => JSON.parse(String(row.body)) as SessionCompaction);
  }

  async #appendCompaction(key: string, runId: string, input: AppendCompactionInput): Promise<SessionCompaction> {
    return this.#transaction(async (client) => {
      const selectedRun = await this.#run(client, key, runId, true);
      if (selectedRun.status !== "running" || String(selectedRun.session_id) !== input.sessionId) throw notFound();
      const last = (await this.#compactions(client, input.sessionId)).at(-1);
      const max = await client.query<{ n: string }>("SELECT COALESCE(MAX(event_seq),0) AS n FROM cloud_events WHERE session_id=$1", [input.sessionId]);
      if (!Number.isSafeInteger(input.sourceStartSeq) || !Number.isSafeInteger(input.sourceEndSeq) || input.sourceStartSeq < 1 ||
          input.sourceEndSeq < input.sourceStartSeq || input.sourceEndSeq > asNumber(max.rows[0]?.n) || input.sourceEndSeq <= (last?.sourceEndSeq ?? 0) ||
          !input.summary.trim() || input.summary.length > 24_000 || !input.strategy.trim() || input.strategy.length > 80) {
        throw new CloudError(400, "COMPACTION_INVALID", "压缩摘要来源或范围无效。");
      }
      const value: SessionCompaction = { ...input, id: id("cmp"), createdAt: now() };
      await client.query("INSERT INTO cloud_compactions(session_id,source_end_seq,body) VALUES ($1,$2,$3)", [input.sessionId, input.sourceEndSeq, JSON.stringify(value)]);
      return value;
    });
  }
}
