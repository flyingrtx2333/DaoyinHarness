import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { EVALUATOR_VERSION, EvaluationError, type EvaluationSpec, type Experiment, type Trial } from "./contracts.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const fingerprint = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
export interface Authority { actorId: string; sessionId: string }
/** Separate evaluation DB, NOT the runtime's production cloud_* database. */
export class EvaluationStore {
  readonly #db: DatabaseSync; readonly #owner = randomUUID();
  public constructor(path: string) {
    this.#db = new DatabaseSync(path);
    const tables = this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    if (tables.some(table => !["evaluation_lease", "evaluation_runs", "evaluation_calls"].includes(String(table.name)))) {
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
  public renew(): void { this.#transaction(() => { this.#db.prepare("UPDATE evaluation_lease SET expires=? WHERE id=1 AND owner=?").run(Date.now() + 30_000, this.#owner); }); }
  public close(): void {
    try { this.#db.prepare("UPDATE evaluation_lease SET expires=0 WHERE id=1 AND owner=?").run(this.#owner); }
    finally { this.#db.close(); }
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
  public list(offset = 0): Experiment[] {
    this.assertOwner();
    return this.#db.prepare("SELECT body FROM evaluation_runs ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET ?").all(offset).map(r => JSON.parse(String(r.body)) as Experiment);
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
