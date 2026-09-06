import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { assertHistoryAdmission, readCompleteHistory } from "./history-policy.js";
import { SqliteMemoryRepository } from "./memory-repository.js";
import { assertExecutionIdentity, executionScopeKey, type AppendCompactionInput, type ExecutionIdentity, type ExecutionScope } from "@daoyin/harness-contracts";
import type { AgentEvent, AgentEventType, PendingAgentEvent, SessionCompaction } from "@daoyin/harness-protocol";
import { CloudError, type BoundRunStores, type CloudRepository, type CloudRun, type CloudSession } from "./repository.js";

type Row = Record<string, unknown>;
const now = (): string => new Date().toISOString();
const id = (prefix: string): string => `${prefix}_${randomUUID()}`;
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const notFound = (): CloudError => new CloudError(404, "RESOURCE_NOT_FOUND", "资源不存在或当前身份无权访问。");

function session(row: Row): CloudSession {
  return { id: String(row.id), title: String(row.title), profileId: String(row.profile_id),
    profileVersion: String(row.profile_version), createdAt: String(row.created_at) };
}

function run(row: Row): CloudRun {
  return {
    id: String(row.id), sessionId: String(row.session_id), requestId: String(row.request_id),
    userMessage: String(row.user_message), status: row.status as CloudRun["status"],
    finalText: String(row.final_text), lastEventSeq: Number(row.last_event_seq),
    cancelRequested: row.cancel_requested === 1, authorizationId: String(row.authorization_id),
    billingAccountId: String(row.billing_account_id), createdAt: String(row.created_at),
  };
}

/**
 * Single-instance SQL adapter for the first cloud vertical slice and isolated tests.
 * This is NOT a MySQL/multi-worker scheduler. Opening the database never takes ownership.
 * The standard runtime explicitly acquires a fenced lease before marking prior runs interrupted.
 * The caller owns the protected database directory and the connection lifecycle.
 */
export class SqliteCloudRepository implements CloudRepository {
  public readonly memory: SqliteMemoryRepository;
  readonly #db: DatabaseSync;
  #leaseOwner: string | null = null;
  #leaseDurationMs = 30_000;
  readonly #listeners = new Map<string, Set<() => void>>();
  #changedSessions = new Set<string>();

  public subscribeSession(scope: ExecutionScope, sessionId: string, listener: () => void): () => void {
    this.#session(executionScopeKey(scope), sessionId);
    const listeners = this.#listeners.get(sessionId) ?? new Set<() => void>();
    listeners.add(listener);
    this.#listeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#listeners.delete(sessionId);
    };
  }

  public constructor(filename: string) {
    this.#db = new DatabaseSync(filename);
    this.#db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS cloud_runtime_lease (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), owner_id TEXT NOT NULL, expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS cloud_sessions (
        id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, actor_id TEXT NOT NULL, scope_id TEXT NOT NULL,
        title TEXT NOT NULL, profile_id TEXT NOT NULL, profile_version TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS cloud_sessions_scope ON cloud_sessions(scope_key, created_at);
      CREATE TABLE IF NOT EXISTS cloud_runs (
        id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES cloud_sessions(id),
        request_id TEXT NOT NULL, input_hash TEXT NOT NULL, user_message TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled','interrupted')),
        final_text TEXT NOT NULL DEFAULT '', last_event_seq INTEGER NOT NULL DEFAULT 0,
        cancel_requested INTEGER NOT NULL DEFAULT 0, authorization_id TEXT NOT NULL,
        billing_account_id TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(session_id, request_id)
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS cloud_one_active_run ON cloud_runs(session_id) WHERE status='running';
      CREATE INDEX IF NOT EXISTS cloud_runs_scope ON cloud_runs(scope_key, session_id);
      CREATE TABLE IF NOT EXISTS cloud_events (
        session_id TEXT NOT NULL REFERENCES cloud_sessions(id), event_seq INTEGER NOT NULL,
        turn_id TEXT NOT NULL REFERENCES cloud_runs(id), event_id TEXT NOT NULL UNIQUE,
        body TEXT NOT NULL, PRIMARY KEY(session_id, event_seq)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS cloud_compactions (
        session_id TEXT NOT NULL REFERENCES cloud_sessions(id), source_end_seq INTEGER NOT NULL,
        body TEXT NOT NULL, PRIMARY KEY(session_id, source_end_seq)
      ) STRICT;
    `);
    this.memory = new SqliteMemoryRepository(this.#db, (operation) => this.#transaction(operation));
  }

  /** Does not release a lease: explicit graceful shutdown and a crashed connection differ. */
  public close(): void { this.#db.close(); }

  public checkReadiness(): void {
    if (this.#leaseOwner === null) throw new Error("Runtime lease not acquired.");
    this.assertExecutionOwner();
    this.#db.prepare("SELECT session_id,event_seq,turn_id,event_id,body FROM cloud_events WHERE 0").all();
    this.#db.prepare("SELECT id,status,last_event_seq,cancel_requested FROM cloud_runs WHERE 0").all();
    if (Number(this.#db.prepare("PRAGMA query_only").get()?.query_only) !== 0) throw new Error("Database is read-only.");
  }

  /** First adoption requires the legacy process to be stopped. Never shares one DB across workers. */
  public acquireRuntimeLease(options: { durationMs?: number; recoverInterrupted?: boolean } = {}): { recoveredRuns: number } {
    const duration = options.durationMs ?? 30_000;
    if (!Number.isSafeInteger(duration) || duration < 1000 || duration > 300_000 || this.#leaseOwner !== null) {
      throw new CloudError(409, "RUNTIME_LEASE_INVALID", "运行租约参数无效或当前连接已经取得租约。");
    }
    const owner = id("runtime");
    const result = this.#transaction(() => {
      const row = this.#db.prepare("SELECT * FROM cloud_runtime_lease WHERE singleton=1").get();
      const instant = Date.now();
      if (row !== undefined && Number(row.expires_at) > instant) {
        throw new CloudError(409, "RUNTIME_ALREADY_ACTIVE", "该数据库已有有效执行实例，不能同时启动第二个服务。");
      }
      this.#db.prepare(`INSERT INTO cloud_runtime_lease VALUES (1,?,?)
        ON CONFLICT(singleton) DO UPDATE SET owner_id=excluded.owner_id,expires_at=excluded.expires_at`).run(owner, instant + duration);
      let recoveredRuns = 0;
      if (options.recoverInterrupted === true) {
        const active = this.#db.prepare("SELECT id,scope_key FROM cloud_runs WHERE status='running'").all();
        for (const item of active) this.#interrupt(String(item.scope_key), String(item.id), "runtime_restart");
        recoveredRuns = active.length;
      }
      return { recoveredRuns };
    }, false);
    this.#leaseOwner = owner;
    this.#leaseDurationMs = duration;
    return result;
  }

  public assertExecutionOwner(): void {
    const row = this.#db.prepare("SELECT * FROM cloud_runtime_lease WHERE singleton=1").get();
    // Embedded isolated repositories remain supported until this DB opts into lease ownership.
    if (row === undefined && this.#leaseOwner === null) return;
    if (row === undefined || row.owner_id !== this.#leaseOwner || Number(row.expires_at) <= Date.now()) {
      throw new CloudError(503, "RUNTIME_LEASE_LOST", "当前实例不再拥有执行租约，不能继续模型、工具或状态写入。");
    }
  }

  public renewRuntimeLease(): boolean {
    if (this.#leaseOwner === null) return false;
    return this.#transaction(() => {
      const instant = Date.now();
      const result = this.#db.prepare("UPDATE cloud_runtime_lease SET expires_at=? WHERE singleton=1 AND owner_id=? AND expires_at>?")
        .run(instant + this.#leaseDurationMs, this.#leaseOwner, instant);
      return result.changes === 1;
    }, false);
  }

  /** Invoke only after the server has drained its work. A stale owner cannot release a successor. */
  public releaseRuntimeLease(): void {
    if (this.#leaseOwner === null) return;
    this.#transaction(() => {
      this.#db.prepare("UPDATE cloud_runtime_lease SET expires_at=0 WHERE singleton=1 AND owner_id=?").run(this.#leaseOwner);
    }, false);
    this.#leaseOwner = null;
  }

  public async createSession(scope: ExecutionScope, input: Omit<CloudSession, "id" | "createdAt">): Promise<CloudSession> {
    const key = executionScopeKey(scope);
    if (!input.title.trim() || input.title.length > 120 || !input.profileId || !input.profileVersion) {
      throw new CloudError(400, "SESSION_INPUT_INVALID", "会话配置无效。");
    }
    return this.#transaction(() => {
      const count = this.#db.prepare("SELECT COUNT(*) AS n FROM cloud_sessions WHERE scope_key=?").get(key);
      if (Number(count?.n) >= 500) throw new CloudError(429, "SESSION_LIMIT", "当前空间的试运行会话数量已达上限。");
      const result: CloudSession = { ...input, id: id("ses"), createdAt: now() };
      this.#db.prepare("INSERT INTO cloud_sessions VALUES (?,?,?,?,?,?,?,?)").run(
        result.id, key, scope.actorUserId, `cloud_${digest(key)}`, input.title.trim(),
        input.profileId, input.profileVersion, result.createdAt,
      );
      return result;
    });
  }

  public async listSessions(scope: ExecutionScope): Promise<CloudSession[]> {
    return this.#db.prepare("SELECT * FROM cloud_sessions WHERE scope_key=? ORDER BY created_at DESC, id DESC LIMIT 100")
      .all(executionScopeKey(scope)).map(session);
  }

  public async getSession(scope: ExecutionScope, sessionId: string): Promise<CloudSession> {
    return session(this.#session(executionScopeKey(scope), sessionId));
  }

  public async acceptRun(identity: ExecutionIdentity, sessionId: string, requestId: string, userMessage: string): Promise<{ run: CloudRun; created: boolean }> {
    assertExecutionIdentity(identity);
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(requestId) || !userMessage.trim() || userMessage.length > 10_000) {
      throw new CloudError(400, "RUN_INPUT_INVALID", "请求标识或消息无效。");
    }
    const key = executionScopeKey(identity);
    return this.#transaction(() => {
      this.#session(key, sessionId);
      const hash = digest(userMessage);
      const existing = this.#db.prepare("SELECT * FROM cloud_runs WHERE session_id=? AND request_id=? AND scope_key=?")
        .get(sessionId, requestId, key);
      if (existing !== undefined) {
        if (existing.input_hash !== hash) throw new CloudError(409, "IDEMPOTENCY_CONFLICT", "同一请求标识不能用于不同消息。");
        return { run: run(existing), created: false };
      }
      const active = this.#db.prepare("SELECT id FROM cloud_runs WHERE session_id=? AND status='running'").get(sessionId);
      if (active !== undefined) throw new CloudError(409, "SESSION_BUSY", "当前会话已有任务，请等待完成或取消。");
      const usage = this.#db.prepare(`SELECT COUNT(*) AS events, COALESCE(SUM(length(CAST(body AS BLOB))),0) AS bytes,
        (SELECT COUNT(*) FROM cloud_runs WHERE session_id=?) AS runs FROM cloud_events WHERE session_id=?`).get(sessionId, sessionId);
      assertHistoryAdmission({ events: Number(usage?.events), bytes: Number(usage?.bytes), runs: Number(usage?.runs) });
      const runId = id("run");
      this.#db.prepare(`INSERT INTO cloud_runs
        (id,scope_key,session_id,request_id,input_hash,user_message,status,authorization_id,billing_account_id,created_at)
        VALUES (?,?,?,?,?,?,'running',?,?,?)`).run(
        runId, key, sessionId, requestId, hash, userMessage, identity.authorizationId, identity.billingAccountId, now(),
      );
      this.#changedSessions.add(sessionId);
      return { run: run(this.#run(key, runId)), created: true };
    });
  }

  public async getRun(scope: ExecutionScope, runId: string): Promise<CloudRun> {
    return run(this.#run(executionScopeKey(scope), runId));
  }

  public async findRequest(scope: ExecutionScope, sessionId: string, requestId: string): Promise<CloudRun | undefined> {
    const key = executionScopeKey(scope);
    this.#session(key, sessionId);
    const row = this.#db.prepare("SELECT * FROM cloud_runs WHERE scope_key=? AND session_id=? AND request_id=?").get(key, sessionId, requestId);
    return row === undefined ? undefined : run(row);
  }

  public async listRuns(scope: ExecutionScope, sessionId: string): Promise<CloudRun[]> {
    const key = executionScopeKey(scope);
    this.#session(key, sessionId);
    return this.#db.prepare("SELECT * FROM cloud_runs WHERE scope_key=? AND session_id=? ORDER BY created_at DESC,id DESC LIMIT 100")
      .all(key, sessionId).map(run);
  }

  public async readEvents(scope: ExecutionScope, sessionId: string, afterEventSeq: number, limit: number): Promise<AgentEvent[]> {
    this.#session(executionScopeKey(scope), sessionId);
    if (!Number.isSafeInteger(afterEventSeq) || afterEventSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new CloudError(400, "EVENT_CURSOR_INVALID", "事件游标或分页数量无效。");
    }
    return this.#readEvents(sessionId, afterEventSeq, limit);
  }

  public bindRun(scope: ExecutionScope, sessionId: string, runId: string): BoundRunStores {
    const key = executionScopeKey(scope);
    const selectedSession = this.#session(key, sessionId);
    const selectedRun = this.#run(key, runId);
    if (selectedRun.session_id !== sessionId) throw notFound();
    const checkSession = (requested: string): void => {
      if (requested !== sessionId) throw notFound();
      this.#session(key, sessionId);
    };
    return {
      accountId: String(selectedSession.actor_id), scopeId: String(selectedSession.scope_id),
      events: {
        append: async (pending) => {
          checkSession(pending.sessionId);
          if (pending.turnId !== runId || pending.accountId !== selectedSession.actor_id || pending.scopeId !== selectedSession.scope_id) {
            throw new CloudError(403, "EVENT_SCOPE_MISMATCH", "事件与执行身份不匹配。");
          }
          return this.#transaction(() => this.#append(key, pending));
        },
        read: async (requested, after = 0) => {
          checkSession(requested);
          if (!Number.isSafeInteger(after) || after < 0) throw new CloudError(400, "EVENT_CURSOR_INVALID", "事件游标无效。");
          // Sessions are bounded at admission; never silently cut a tool/result pair for model history.
          return readCompleteHistory(sessionId, after, async (cursor, limit) => this.#readEvents(sessionId, cursor, limit));
        },
      },
      compactions: {
        append: async (input) => { checkSession(input.sessionId); return this.#appendCompaction(key, runId, input); },
        list: async (requested) => { checkSession(requested); return this.#compactions(sessionId); },
        latest: async (requested) => { checkSession(requested); return this.#compactions(sessionId).at(-1); },
      },
    };
  }

  public async requestCancellation(scope: ExecutionScope, runId: string): Promise<CloudRun> {
    const key = executionScopeKey(scope);
    return this.#transaction(() => {
      const current = this.#run(key, runId);
      const updated = this.#db.prepare("UPDATE cloud_runs SET cancel_requested=1 WHERE id=? AND scope_key=? AND status='running' AND cancel_requested=0").run(runId, key);
      if (updated.changes) this.#changedSessions.add(String(current.session_id));
      return run(this.#run(key, runId));
    });
  }

  public async interruptRun(scope: ExecutionScope, runId: string, reason: "runtime_restart" | "runtime_recovery"): Promise<void> {
    const key = executionScopeKey(scope);
    this.#transaction(() => this.#interrupt(key, runId, reason));
  }

  /** Operator-only, after ensuring the previous single instance has stopped. Never called by HTTP. */
  public recoverInterruptedRuns(): number {
    return this.#transaction(() => {
      const active = this.#db.prepare("SELECT id,scope_key FROM cloud_runs WHERE status='running'").all();
      for (const row of active) this.#interrupt(String(row.scope_key), String(row.id), "runtime_restart");
      return active.length;
    });
  }

  #session(key: string, sessionId: string): Row {
    const row = this.#db.prepare("SELECT * FROM cloud_sessions WHERE id=? AND scope_key=?").get(sessionId, key);
    if (row === undefined) throw notFound();
    return row;
  }

  #run(key: string, runId: string): Row {
    const row = this.#db.prepare("SELECT * FROM cloud_runs WHERE id=? AND scope_key=?").get(runId, key);
    if (row === undefined) throw notFound();
    return row;
  }

  #transaction<T>(operation: () => T, enforceLease = true): T {
    this.#db.exec("BEGIN IMMEDIATE");
    const changed = new Set<string>();
    this.#changedSessions = changed;
    let result: T;
    try {
      if (enforceLease) this.assertExecutionOwner();
      result = operation();
      if (enforceLease) this.assertExecutionOwner();
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    } finally { this.#changedSessions = new Set<string>(); }
    // Notify ONLY after the event and its Run projection commit together. A failed
    // subscriber cannot turn a successful durable operation into a retryable error.
    for (const sessionId of changed) for (const listener of [...(this.#listeners.get(sessionId) ?? [])]) {
      try { listener(); } catch { /* Reconnect/replay remains authoritative. */ }
    }
    return result;
  }

  #readEvents(sessionId: string, after: number, limit = 1_200): AgentEvent[] {
    return this.#db.prepare("SELECT body FROM cloud_events WHERE session_id=? AND event_seq>? ORDER BY event_seq LIMIT ?")
      .all(sessionId, after, limit).map((row) => JSON.parse(String(row.body)) as AgentEvent);
  }

  #append<TType extends AgentEventType>(key: string, pending: PendingAgentEvent<TType>): AgentEvent {
    const selectedRun = this.#run(key, pending.turnId);
    if (selectedRun.session_id !== pending.sessionId || selectedRun.status !== "running") {
      throw new CloudError(409, "RUN_NOT_ACTIVE", "该任务已结束，不能追加执行结果。");
    }
    const previous = this.#db.prepare("SELECT COALESCE(MAX(event_seq),0) AS n FROM cloud_events WHERE session_id=?").get(pending.sessionId);
    const event = { ...pending, id: id("evt"), eventSeq: Number(previous?.n ?? 0) + 1, occurredAt: now() } as AgentEvent;
    const body = JSON.stringify(event);
    if (Buffer.byteLength(body, "utf8") > 128_000) throw new CloudError(413, "EVENT_TOO_LARGE", "工具或模型结果超过事件存储上限。");
    this.#db.prepare("INSERT INTO cloud_events VALUES (?,?,?,?,?)").run(event.sessionId, event.eventSeq, event.turnId, event.id, body);
    let status: CloudRun["status"] = "running";
    let finalText = "";
    if (event.type === "turn.completed" || event.type === "turn.failed") {
      status = event.payload.status;
      finalText = event.payload.outcomeSummary;
    } else if (event.type === "turn.cancelled") {
      status = "cancelled";
      finalText = "任务已停止。";
    } else if (event.type === "turn.interrupted") {
      status = "interrupted";
      finalText = "执行被中断，已保留记录；未自动重试外部操作。";
    }
    this.#db.prepare("UPDATE cloud_runs SET last_event_seq=?,status=?,final_text=? WHERE id=? AND scope_key=? AND status='running'")
      .run(event.eventSeq, status, finalText, event.turnId, key);
    this.#changedSessions.add(event.sessionId);
    return event;
  }

  #interrupt(key: string, runId: string, reason: "runtime_restart" | "runtime_recovery"): void {
    const selectedRun = this.#run(key, runId);
    if (selectedRun.status !== "running") return;
    const selectedSession = this.#session(key, String(selectedRun.session_id));
    this.#append(key, {
      type: "turn.interrupted", accountId: String(selectedSession.actor_id), scopeId: String(selectedSession.scope_id),
      sessionId: String(selectedRun.session_id), turnId: runId,
      payload: { status: "interrupted", reason, lastCompletedEventSeq: Number(selectedRun.last_event_seq) },
    });
  }

  #compactions(sessionId: string): SessionCompaction[] {
    return this.#db.prepare("SELECT body FROM cloud_compactions WHERE session_id=? ORDER BY source_end_seq")
      .all(sessionId).map((row) => JSON.parse(String(row.body)) as SessionCompaction);
  }

  #appendCompaction(key: string, runId: string, input: AppendCompactionInput): SessionCompaction {
    return this.#transaction(() => {
      const selectedRun = this.#run(key, runId);
      if (selectedRun.status !== "running" || selectedRun.session_id !== input.sessionId) throw notFound();
      const last = this.#compactions(input.sessionId).at(-1);
      const max = this.#db.prepare("SELECT COALESCE(MAX(event_seq),0) AS n FROM cloud_events WHERE session_id=?").get(input.sessionId);
      if (!Number.isSafeInteger(input.sourceStartSeq) || !Number.isSafeInteger(input.sourceEndSeq) ||
          input.sourceStartSeq < 1 || input.sourceEndSeq < input.sourceStartSeq || input.sourceEndSeq > Number(max?.n) ||
          input.sourceEndSeq <= (last?.sourceEndSeq ?? 0) || !input.summary.trim() || input.summary.length > 24_000 ||
          !input.strategy.trim() || input.strategy.length > 80) {
        throw new CloudError(400, "COMPACTION_INVALID", "压缩摘要来源或范围无效。");
      }
      const value: SessionCompaction = { ...input, id: id("cmp"), createdAt: now() };
      this.#db.prepare("INSERT INTO cloud_compactions VALUES (?,?,?)").run(input.sessionId, input.sourceEndSeq, JSON.stringify(value));
      return value;
    });
  }
}
