import type { EvaluationCase, EvaluationSpec, Experiment, Trial, TEMPLATES, metrics } from "../../../server-cloud/src/evaluation/contracts.js";
export type { EvaluationCase, EvaluationSpec, Experiment, Trial };
export interface Catalog { version: string; revision: string | null; templates: typeof TEMPLATES; liveAvailable: boolean; model: string | null; judgeModel: string | null }
export interface EvaluationView extends Experiment {
  metrics: ReturnType<typeof metrics>; dispatchedCalls: { agent: number; judge: number };
  active: { caseId: string; repetition: number; stage: string } | null;
}
export interface HistoryItem { id: string; title: string; status: Experiment["status"]; createdAt: string; mode: "live" | "replay"; planned: number; completed: number }
export class EvaluationApiError extends Error {
  public constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
const errorMessages: Record<string, string> = {
  SUPERADMIN_REQUIRED: "仅超级管理员可以进入测试评估。", EVALUATION_NOT_CONFIGURED: "评估服务尚未配置。",
  EVAL_MODEL_DISABLED: "尚未配置专用评估模型，可先执行程序回放。", EVAL_BUSY: "已有实验运行中，请从历史记录查看。",
  EVAL_IDEMPOTENCY_CONFLICT: "提交编号对应的配置不同，请先恢复原实验。", CASE_NOT_APPROVED: "请先确认每道题的场景和成功条件。",
  SECRET_IN_INPUT: "输入中检测到访问凭证，请移除后再试。", PAID_CONFIRMATION_REQUIRED: "请先确认真实模型费用。",
};
export class EvaluationClient {
  #csrf = ""; #scope = "";
  public get scope(): string { return this.#scope; }
  public constructor(private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)) {}
  public reset(): void { this.#csrf = ""; this.#scope = ""; }
  public async request<T>(path: string, body?: unknown, parent?: AbortSignal): Promise<T> {
    const scope = this.#scope;
    const signal = parent ? AbortSignal.any([parent, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
    const response = await this.fetcher(`/api/harness-evaluation${path}`, {
      method: body === undefined ? "GET" : "POST", credentials: "same-origin", redirect: "error", cache: "no-store", signal,
      headers: { Accept: "application/json", ...(scope && path !== "/bootstrap" ? { "x-eval-account": scope } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json", "x-eval-csrf": this.#csrf }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) this.reset();
      const raw = value && typeof value === "object" && "detail" in value ? value.detail : null;
      const code = raw && typeof raw === "object" && "code" in raw && typeof raw.code === "string" ? raw.code : "EVAL_REQUEST_FAILED";
      throw new EvaluationApiError(response.status, code, errorMessages[code] ?? (response.status === 401 ? "登录已失效，请重新进入。" : response.status === 403 ? "当前账号不能访问测试评估。" : `请求未完成（${code}），请查询原实验后重试。`));
    }
    if (path !== "/bootstrap" && scope !== this.#scope) throw new EvaluationApiError(401, "EVAL_ACCOUNT_CHANGED", "账号已变化，未显示旧结果。");
    return value as T;
  }
  public async bootstrap(signal?: AbortSignal): Promise<void> {
    const value = await this.request<{ allowed: boolean; csrfToken: string; accountScope: string }>("/bootstrap", {}, signal);
    signal?.throwIfAborted();
    if (value.allowed !== true || !/^[a-f0-9]{64}$/u.test(value.csrfToken) || !/^[a-f0-9]{64}$/u.test(value.accountScope)) { this.reset(); throw new EvaluationApiError(403, "INVALID_ACCESS", "访问校验未通过。"); }
    this.#csrf = value.csrfToken; this.#scope = value.accountScope;
  }
  public catalog(signal?: AbortSignal): Promise<Catalog> { return this.request("/catalog", undefined, signal); }
  public async prepare(lines: string): Promise<EvaluationCase[]> { return (await this.request<{ cases: EvaluationCase[] }>("/prepare", { lines })).cases; }
  public history(offset: number, signal?: AbortSignal): Promise<{ runs: HistoryItem[] }> { return this.request(`/runs?offset=${offset}`, undefined, signal); }
  public create(spec: EvaluationSpec): Promise<{ run: EvaluationView; reused: boolean }> { return this.request("/runs", spec); }
  public detail(id: string, signal?: AbortSignal): Promise<EvaluationView> { return this.request(`/runs/${encodeURIComponent(id)}`, undefined, signal); }
  public trial(id: string, caseId: string, repetition: number, signal?: AbortSignal): Promise<{ trial: Trial; test: EvaluationCase; mode: "live" | "replay" }> {
    return this.request(`/runs/${encodeURIComponent(id)}/trials/${encodeURIComponent(caseId)}/${repetition}`, undefined, signal);
  }
  public cancel(id: string): Promise<EvaluationView> { return this.request(`/runs/${encodeURIComponent(id)}/cancel`, {}); }
}
