import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { EVALUATOR_VERSION, EvaluationError, type EvaluationSpec, type Experiment, type Trial } from "./contracts.js";
import type { StoredTelemetrySpan } from "./telemetry.js";
import type { AgentEvent } from "@daoyin/harness-protocol";
import type { AuditRunSummary } from "./contracts.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const fingerprint = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
export interface Authority { actorId: string; sessionId: string }
export interface TelemetryTraceSummary {
  traceId: string; name: string; serviceName: string; serviceVersion: string; startedAt: string;
  durationMs: number; status: "ok" | "error"; spanCount: number; errorCount: number; toolNames: string[];
}
/** Separate evaluation DB, NOT the runtime's production cloud_* database. */
export class EvaluationStore {
  readonly #db: DatabaseSync; readonly #owner = randomUUID();
  public constructor(path: string) {
    this.#db = new DatabaseSync(path);
    const tables = this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    if (tables.some(table => !["evaluation_lease", "evaluation_runs", "evaluation_calls", "telemetry_spans", "audit_events"].includes(String(table.name)))) {
      this.#db.close(); throw new EvaluationError(503, "EVAL_DATABASE_SCOPE", "必须使用独立评估数据库，禁止复用业务或云端会话库。");
    }
    this.#db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS evaluation_lease(id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS evaluation_runs(id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, session_id TEXT NOT NULL,
        request_id TEXT NOT NULL, input_hash TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
        body TEXT NOT NULL, UNIQUE(actor_id,request_id)) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS evaluation_one_active ON evaluation_runs((1)) WHERE status IN ('running','cancelling');
      CREATE TABLE IF NOT EXISTS evaluation_calls(run_id TEXT NOT NULL REFERENCES evaluation_runs(id), seq INTEGER NOT NULL,
        kind TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(run_id,seq)) STRICT;`);
    this.#db.exec(`CREATE TABLE IF NOT EXISTS telemetry_spans(
      trace_id TEXT NOT NULL, span_id TEXT PRIMARY KEY, parent_span_id TEXT NOT NULL, name TEXT NOT NULL,
      service_name TEXT NOT NULL, service_version TEXT NOT NULL, started_at TEXT NOT NULL, duration_ms REAL NOT NULL,
      status TEXT NOT NULL, attributes TEXT NOT NULL, ingested_at TEXT NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS telemetry_trace_started ON telemetry_spans(trace_id,started_at,span_id);
      CREATE INDEX IF NOT EXISTS telemetry_recent_roots ON telemetry_spans(started_at DESC) WHERE parent_span_id='';`);
    this.#db.exec(`CREATE TABLE IF NOT EXISTS audit_events(
      event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT NOT NULL, account_id TEXT NOT NULL, scope_id TEXT NOT NULL,
      event_seq INTEGER NOT NULL, event_type TEXT NOT NULL, occurred_at TEXT NOT NULL, body TEXT NOT NULL, ingested_at TEXT NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS audit_turn_events ON audit_events(turn_id,event_seq,event_id);
      CREATE INDEX IF NOT EXISTS audit_recent_runs ON audit_events(occurred_at DESC) WHERE event_type='turn.started';`);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.#db.prepare("SELECT expires FROM evaluation_lease WHERE id=1").get();
      if (old && Number(old.expires) > Date.now()) throw new EvaluationError(409, "EVAL_ALREADY_RUNNING", "评估服务已有有效实例。");
      this.#db.prepare("INSERT INTO evaluation_lease VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires").run(this.#owner, Date.now() + 30_000);
      const rows = this.#db.prepare("SELECT body FROM evaluation_runs WHERE status IN ('running','cancelling')").all();
      for (const row of rows) {
        const run = JSON.parse(String(row.body)) as Experiment;
        run.status = "interrupted"; run.finishedAt = new Date().toISOString();
        this.#db.prepare("UPDATE evaluation_runs SET status=?,body=? WHERE id=?").run(run.status, JSON.stringify(run), run.id);
      }
      this.#db.exec("COMMIT");
    } catch (error) { this.#db.exec("ROLLBACK"); this.#db.close(); throw error; }
  }
  public assertOwner(): void {
    const row = this.#db.prepare("SELECT owner,expires FROM evaluation_lease WHERE id=1").get();
    if (!row || row.owner !== this.#owner || Number(row.expires) <= Date.now()) throw new EvaluationError(503, "EVAL_LEASE_LOST", "评估执行实例已失效。");
  }
  #transaction<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try { this.assertOwner(); const value = fn(); this.assertOwner(); this.#db.exec("COMMIT"); return value; }
    catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  public ingestAudit(events: readonly AgentEvent[]): number {
    let accepted = 0; this.#transaction(() => {
      const insert = this.#db.prepare(`INSERT OR IGNORE INTO audit_events(event_id,session_id,turn_id,account_id,scope_id,event_seq,event_type,occurred_at,body,ingested_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
      const ingestedAt = new Date().toISOString();
      for (const event of events) accepted += Number(insert.run(event.id,event.sessionId,event.turnId,event.accountId,event.scopeId,event.eventSeq,event.type,event.occurredAt,JSON.stringify(event),ingestedAt).changes);
    }); return accepted;
  }
  public auditRuns(hours: number, offset = 0): Array<Omit<AuditRunSummary, "traceId">> {
    const since = new Date(Date.now() - hours * 3_600_000).toISOString();
    const rows = this.#db.prepare(`SELECT s.body,s.session_id,s.turn_id,s.account_id,s.scope_id,s.occurred_at,
      (SELECT COUNT(*) FROM audit_events e WHERE e.turn_id=s.turn_id) event_count,
      (SELECT COUNT(*) FROM audit_events e WHERE e.turn_id=s.turn_id AND e.event_type='model.requested') model_calls,
      (SELECT COUNT(*) FROM audit_events e WHERE e.turn_id=s.turn_id AND e.event_type='tool.started') tool_calls,
      (SELECT e.event_type FROM audit_events e WHERE e.turn_id=s.turn_id AND e.event_type IN ('turn.completed','turn.failed','turn.cancelled','turn.interrupted') ORDER BY e.event_seq DESC LIMIT 1) terminal_type
      FROM audit_events s WHERE s.event_type='turn.started' AND s.occurred_at>=? ORDER BY s.occurred_at DESC,s.event_id DESC LIMIT 100 OFFSET ?`).all(since, offset) as Array<Record<string, unknown>>;
    return rows.map(row => { const event = JSON.parse(String(row.body)) as AgentEvent; const terminal = String(row.terminal_type ?? ""); return {
      runId:String(row.turn_id),sessionId:String(row.session_id),accountId:String(row.account_id),scopeId:String(row.scope_id),startedAt:String(row.occurred_at),
      status: terminal === "turn.completed" ? "completed" : terminal === "turn.failed" ? "failed" : terminal === "turn.cancelled" ? "cancelled" : terminal === "turn.interrupted" ? "interrupted" : "running",
      userMessage:event.type === "turn.started" ? event.payload.userMessage : "",eventCount:Number(row.event_count),modelCalls:Number(row.model_calls),toolCalls:Number(row.tool_calls) }; });
  }
  public auditRun(runId: string): AgentEvent[] { return this.#db.prepare("SELECT body FROM audit_events WHERE turn_id=? ORDER BY event_seq,event_id").all(runId).map(row => JSON.parse(String(row.body)) as AgentEvent); }
  public auditRunsForTraces(hours: number, offset = 0): AuditRunSummary[] {
    const byRun = new Map(this.auditRuns(hours, 0).map(run => [run.runId, run]));
    return this.telemetryTraces(hours, offset).flatMap(trace => {
      const root = this.telemetryTrace(trace.traceId).find(span => !span.parentSpanId);
      const runId = typeof root?.attributes["daoyin.run.id"] === "string" ? root.attributes["daoyin.run.id"] : "";
      const audit = byRun.get(runId);
      return audit === undefined ? [] : [{ traceId: trace.traceId, ...audit }];
    });
  }
  public auditRunForTrace(traceId: string): { runId: string; events: AgentEvent[] } | null {
    const root = this.telemetryTrace(traceId).find(span => !span.parentSpanId);
    const runId = typeof root?.attributes["daoyin.run.id"] === "string" ? root.attributes["daoyin.run.id"] : "";
    if (!runId) return null;
    const events = this.auditRun(runId);
    return events.length ? { runId, events } : null;
  }
  public renew(): void { this.#transaction(() => { this.#db.prepare("UPDATE evaluation_lease SET expires=? WHERE id=1 AND owner=?").run(Date.now() + 30_000, this.#owner); }); }
  public close(): void {
    try { this.#db.prepare("UPDATE evaluation_lease SET expires=0 WHERE id=1 AND owner=?").run(this.#owner); }
    finally { this.#db.close(); }
  }
  public ingestTelemetry(spans: readonly StoredTelemetrySpan[]): number {
    return this.#transaction(() => {
      const insert = this.#db.prepare(`INSERT OR IGNORE INTO telemetry_spans
        (trace_id,span_id,parent_span_id,name,service_name,service_version,started_at,duration_ms,status,attributes,ingested_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      const now = new Date().toISOString(); let inserted = 0;
      for (const span of spans) inserted += Number(insert.run(span.traceId, span.spanId, span.parentSpanId, span.name,
        span.serviceName, span.serviceVersion, span.startedAt, span.durationMs, span.status,
        JSON.stringify(span.attributes), now).changes);
      this.#db.prepare("DELETE FROM telemetry_spans WHERE ingested_at < ?").run(new Date(Date.now() - 7 * 86_400_000).toISOString());
      const count = Number(this.#db.prepare("SELECT COUNT(*) AS n FROM telemetry_spans").get()?.n ?? 0);
      if (count > 50_000) this.#db.prepare(`DELETE FROM telemetry_spans WHERE span_id IN
        (SELECT span_id FROM telemetry_spans ORDER BY ingested_at,span_id LIMIT ?)` ).run(count - 50_000);
      return inserted;
    });
  }
  public telemetrySummary(hours: number): {
    windowHours: number; traces: number; errors: number; errorRate: number; p50Ms: number | null; p95Ms: number | null;
    operations: Array<{ name: string; count: number; errors: number; averageMs: number }>;
  } {
    this.assertOwner();
    const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
    const roots = this.#db.prepare("SELECT duration_ms,status FROM telemetry_spans WHERE parent_span_id='' AND started_at>=? ORDER BY duration_ms").all(cutoff);
    const durations = roots.map(row => Number(row.duration_ms));
    const percentile = (ratio: number): number | null => durations.length ? Math.round(durations[Math.min(durations.length - 1, Math.floor((durations.length - 1) * ratio))]!) : null;
    const errors = roots.filter(row => row.status === "error").length;
    const operations = this.#db.prepare(`SELECT name,COUNT(*) AS count,
      SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors,AVG(duration_ms) AS average
      FROM telemetry_spans WHERE started_at>=? GROUP BY name ORDER BY count DESC,name LIMIT 12`).all(cutoff)
      .map(row => ({ name: String(row.name), count: Number(row.count), errors: Number(row.errors), averageMs: Math.round(Number(row.average)) }));
    return { windowHours: hours, traces: roots.length, errors, errorRate: roots.length ? errors / roots.length : 0,
      p50Ms: percentile(.5), p95Ms: percentile(.95), operations };
  }

  /**
   * 分页查询指定时间窗口内的根 Trace 链路摘要列表 (telemetryTraces)。
   *
   * @param {number} hours 统计窗口（小时）
   * @param {number} [offset=0] 分页偏移量
   * @returns {TelemetryTraceSummary[]} 链路摘要列表（每页最多 30 条）
   *
   * @example
   * ```json
   * // 调用: telemetryTraces(1, 0)
   * // 返回值示例:
   * [
   *   {
   *     "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
   *     "name": "agent.turn",
   *     "serviceName": "daoyin-agent",
   *     "serviceVersion": "1.0.0",
   *     "startedAt": "2024-03-09T13:20:00.000Z",
   *     "durationMs": 1500,
   *     "status": "ok",
   *     "spanCount": 4,
   *     "errorCount": 0,
   *     "toolNames": ["saishi_list_events", "saishi_list_materials"]
   *   }
   * ]
   * ```
   */
  public telemetryTraces(hours: number, offset = 0): TelemetryTraceSummary[] {
    this.assertOwner();
    const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
    return this.#db.prepare(`SELECT root.trace_id,root.name,root.service_name,root.service_version,root.started_at,
      root.duration_ms,root.status,COUNT(all_spans.span_id) AS span_count,
      GROUP_CONCAT(DISTINCT CASE WHEN all_spans.name='agent.tool'
        THEN COALESCE(json_extract(all_spans.attributes,'$."tool.display_name"'),
          json_extract(all_spans.attributes,'$."tool.name"')) END) AS tool_names,
      SUM(CASE WHEN all_spans.status='error' THEN 1 ELSE 0 END) AS error_count
      FROM telemetry_spans root JOIN telemetry_spans all_spans ON all_spans.trace_id=root.trace_id
      WHERE root.parent_span_id='' AND root.started_at>=?
      GROUP BY root.span_id ORDER BY root.started_at DESC LIMIT 30 OFFSET ?`).all(cutoff, offset).map(row => ({
        traceId: String(row.trace_id), name: String(row.name), serviceName: String(row.service_name),
        serviceVersion: String(row.service_version), startedAt: String(row.started_at), durationMs: Math.round(Number(row.duration_ms)),
        status: row.status === "error" ? "error" as const : "ok" as const,
        spanCount: Number(row.span_count), errorCount: Number(row.error_count),
        toolNames: typeof row.tool_names === "string" && row.tool_names ? row.tool_names.split(",").slice(0, 8) : [],
      }));
  }
  public telemetryTrace(traceId: string): StoredTelemetrySpan[] {
    this.assertOwner();
    const rows = this.#db.prepare(`SELECT trace_id,span_id,parent_span_id,name,service_name,service_version,
      started_at,duration_ms,status,attributes FROM telemetry_spans WHERE trace_id=? ORDER BY started_at,span_id`).all(traceId);
    if (!rows.length) throw new EvaluationError(404, "TRACE_NOT_FOUND", "链路不存在或已超过保留期。");
    return rows.map(row => ({ traceId: String(row.trace_id), spanId: String(row.span_id), parentSpanId: String(row.parent_span_id),
      name: String(row.name), serviceName: String(row.service_name), serviceVersion: String(row.service_version),
      startedAt: String(row.started_at), durationMs: Number(row.duration_ms), status: row.status === "error" ? "error" : "ok",
      attributes: JSON.parse(String(row.attributes)) as Record<string, string | number | boolean> }));
  }
  public create(authority: Authority, spec: EvaluationSpec, model: string | null, revision: string | null): { run: Experiment; created: boolean } {
    return this.#transaction(() => {
      const hash = fingerprint({ ...spec, requestId: undefined, model, revision, evaluator: EVALUATOR_VERSION });
      const old = this.#db.prepare("SELECT input_hash,body FROM evaluation_runs WHERE actor_id=? AND request_id=?").get(authority.actorId, spec.requestId);
      if (old) {
        if (old.input_hash !== hash) throw new EvaluationError(409, "EVAL_IDEMPOTENCY_CONFLICT", "该提交编号已经用于不同配置，请恢复原实验。");
        return { run: JSON.parse(String(old.body)) as Experiment, created: false };
      }
      if (this.#db.prepare("SELECT 1 FROM evaluation_runs WHERE status IN ('running','cancelling')").get()) throw new EvaluationError(409, "EVAL_BUSY", "已有评估进行中，请等待或先取消。");
      if (Number(this.#db.prepare("SELECT COUNT(*) AS n FROM evaluation_runs").get()?.n) >= 1000) throw new EvaluationError(409, "EVAL_STORAGE_LIMIT", "评估记录达到保留上限，请由运维归档。");
      const run: Experiment = { id: `ev_${randomUUID().replaceAll("-", "")}`, actorId: authority.actorId, spec: structuredClone(spec), configurationHash: hash,
        status: "running", createdAt: new Date().toISOString(), finishedAt: null, version: EVALUATOR_VERSION, revision, model,
        trials: [], planned: spec.cases.length * spec.repetitions, completed: 0 };
      this.#db.prepare("INSERT INTO evaluation_runs VALUES (?,?,?,?,?,?,?,?)").run(run.id, authority.actorId, authority.sessionId, spec.requestId, hash, run.status, run.createdAt, JSON.stringify(run));
      return { run, created: true };
    });
  }
  public get(id: string): Experiment {
    this.assertOwner();
    const row = this.#db.prepare("SELECT body FROM evaluation_runs WHERE id=?").get(id);
    if (!row) throw new EvaluationError(404, "EVAL_NOT_FOUND", "评估不存在。");
    return JSON.parse(String(row.body)) as Experiment;
  }
  public findRequest(actorId: string, requestId: string): Experiment | null {
    this.assertOwner();
    const row = this.#db.prepare("SELECT body FROM evaluation_runs WHERE actor_id=? AND request_id=?").get(actorId, requestId);
    return row ? JSON.parse(String(row.body)) as Experiment : null;
  }
  public authority(id: string): Authority {
    const row = this.#db.prepare("SELECT actor_id,session_id FROM evaluation_runs WHERE id=?").get(id);
    if (!row) throw new EvaluationError(404, "EVAL_NOT_FOUND", "评估不存在。");
    return { actorId: String(row.actor_id), sessionId: String(row.session_id) };
  }
  public list(offset = 0, actorId?: string): Experiment[] {
    this.assertOwner();
    const rows = actorId === undefined
      ? this.#db.prepare("SELECT body FROM evaluation_runs ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET ?").all(offset)
      : this.#db.prepare("SELECT body FROM evaluation_runs WHERE actor_id=? ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET ?").all(actorId, offset);
    return rows.map(row => JSON.parse(String(row.body)) as Experiment);
  }
  public reserveCall(id: string, kind: "agent" | "judge"): void {
    this.#transaction(() => {
      const run = this.get(id);
      const count = Number(this.#db.prepare("SELECT COUNT(*) AS n FROM evaluation_calls WHERE run_id=?").get(id)?.n);
      if (run.status !== "running" || count >= run.spec.maxTotalCalls) throw new EvaluationError(409, "EVAL_TOTAL_BUDGET", "实验已停止或达到调用上限。");
      this.#db.prepare("INSERT INTO evaluation_calls VALUES (?,?,?,?)").run(id, count + 1, kind, new Date().toISOString());
    });
  }
  public counts(id: string): { agent: number; judge: number } {
    const rows = this.#db.prepare("SELECT kind,COUNT(*) AS n FROM evaluation_calls WHERE run_id=? GROUP BY kind").all(id);
    return { agent: Number(rows.find(r => r.kind === "agent")?.n ?? 0), judge: Number(rows.find(r => r.kind === "judge")?.n ?? 0) };
  }
  public recordRuntimeHandle(id: string, handle: import("./contracts.js").RuntimeHandle): void {
    this.#transaction(() => {
      const run = this.get(id);
      if (!["running", "cancelling"].includes(run.status)) throw new EvaluationError(409, "EVAL_FINISHED", "实验已经结束。");
      const handles = run.runtimeHandles ?? [];
      const index = handles.findIndex(value => value.caseId === handle.caseId && value.repetition === handle.repetition);
      if (index < 0) handles.push(handle); else handles[index] = handle;
      run.runtimeHandles = handles;
      this.#db.prepare("UPDATE evaluation_runs SET body=? WHERE id=?").run(JSON.stringify(run), id);
    });
  }
  public append(id: string, trial: Trial): void {
    this.#transaction(() => {
      const run = this.get(id);
      if (!["running", "cancelling"].includes(run.status)) throw new EvaluationError(409, "EVAL_FINISHED", "实验已经结束。");
      if (run.trials.some(t => t.caseId === trial.caseId && t.repetition === trial.repetition)) throw new EvaluationError(409, "EVAL_DUPLICATE_TRIAL", "该次试验已经保存。");
      run.trials.push(trial); run.completed = run.trials.length;
      this.#db.prepare("UPDATE evaluation_runs SET body=? WHERE id=?").run(JSON.stringify(run), id);
    });
  }
  public state(id: string, status: Experiment["status"]): void {
    this.#transaction(() => {
      const run = this.get(id);
      if (!["running", "cancelling"].includes(run.status)) return;
      if (status === "completed" && (run.completed !== run.planned || run.status === "cancelling")) throw new EvaluationError(409, "EVAL_INCOMPLETE", "不完整实验不能标记完成。");
      run.status = status; run.finishedAt = ["running", "cancelling"].includes(status) ? null : new Date().toISOString();
      this.#db.prepare("UPDATE evaluation_runs SET status=?,body=? WHERE id=?").run(status, JSON.stringify(run), id);
    });
  }
}
