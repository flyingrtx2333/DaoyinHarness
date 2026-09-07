import { setTimeout as delay } from "node:timers/promises";
import type { AgentEvent } from "@daoyin/harness-protocol";
import type { CloudRun, CloudSession } from "../repository.js";
import { EvaluationError, record, type EvaluationCase, type EvaluationSpec, type RuntimeHandle, type Trial } from "./contracts.js";
import type { Authority } from "./store.js";

export interface RuntimeCatalog { available: boolean; model: string | null; profileId: string; runtime: { revision?: string | null } | null }
/** Only the platform knows business grants/provider credentials. No fixture or local API injection. */
export class PlatformEvaluationRuntime {
  public constructor(private readonly origin: URL, private readonly serviceToken: string) {}
  public async request<T>(authority: Authority, operation: string, payload: Record<string, unknown> = {}, parent?: AbortSignal): Promise<T> {
    const signal = parent ? AbortSignal.any([parent, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
    try {
      const response = await fetch(new URL("/api/internal/harness-evaluation/runtime", this.origin), {
        method: "POST", redirect: "error", signal,
        headers: { "Content-Type": "application/json", "x-eval-service-token": this.serviceToken },
        body: JSON.stringify({ ...payload, ...authority, operation }),
      });
      const reader = response.body?.getReader();
      if (!reader) throw new EvaluationError(502, "EVAL_RUNTIME_PROTOCOL", "实际运行时未返回结果。");
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
          if (size > 2_000_000) throw new EvaluationError(502, "EVAL_RUNTIME_RESPONSE_LIMIT", "真实运行时结果过大。");
          chunks.push(part.value);
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!response.ok) {
        const detail = record(value) && record(value.detail) ? value.detail : null;
        const code = detail && typeof detail.code === "string" && /^[A-Z][A-Z0-9_]{1,80}$/u.test(detail.code) ? detail.code : "EVAL_RUNTIME_REJECTED";
        throw new EvaluationError(response.status, code, `真实账号链路请求未完成（${code}）。`);
      }
      if (!record(value)) throw new EvaluationError(502, "EVAL_RUNTIME_PROTOCOL", "实际运行时返回格式不正确。");
      return value as T;
    } catch (error) {
      if (error instanceof EvaluationError) throw error;
      throw new EvaluationError(503, "EVAL_RUNTIME_UNCERTAIN", "实际任务结果尚未确认，未自动重提。");
    }
  }
  public catalog(authority: Authority, signal?: AbortSignal): Promise<RuntimeCatalog> {
    return this.request(authority, "catalog", {}, signal);
  }
}

export async function runLiveTrial(options: {
  runtime: PlatformEvaluationRuntime; authority: Authority; spec: EvaluationSpec; test: EvaluationCase;
  repetition: number; requestId: string; signal: AbortSignal; catalog: RuntimeCatalog;
  onHandle(handle: RuntimeHandle): void; onStage(stage: string): void;
}): Promise<Trial> {
  const { runtime, authority, spec, test, repetition, requestId } = options;
  const started = performance.now(); const deadline = AbortSignal.timeout(135_000);
  const signal = AbortSignal.any([options.signal, deadline]);
  let sessionId: string | undefined; let run: CloudRun | undefined; let submissionStarted = false;
  const result: Trial = { caseId: test.id, repetition, requestId, verdict: "failed", runStatus: "not_started", answer: "",
    checks: [], tools: [], modelCalls: 0, modelCallsKnown: false, judgeCalls: 0, durationMs: 0, firstTextMs: null,
    inputTokens: null, outputTokens: null, recall: null, retrievedMemoryIds: [], errorCode: null,
    modelName: options.catalog.model, runtimeRevision: options.catalog.runtime?.revision ?? null,
    evidenceKind: "real-platform-account-runtime" };
  const persistHandle = (): void => { if (sessionId) options.onHandle({ caseId: test.id, repetition, sessionId, requestId, ...(run ? { runId: run.id } : {}) }); };
  async function usage(): Promise<void> {
    if (!run) return;
    try {
      const value = await runtime.request<{ modelCalls: number }>(authority, "usage", { resourceId: run.id });
      if (Number.isSafeInteger(value.modelCalls) && value.modelCalls >= 0) { result.modelCalls = value.modelCalls; result.modelCallsKnown = true; }
    } catch { /* Unknown is explicitly recorded, not reported as a measured zero. */ }
  }
  try {
    signal.throwIfAborted(); options.onStage("创建真实账号评估会话");
    const created = await runtime.request<{ session: CloudSession }>(authority, "create_session", {}, signal);
    if (!created.session?.id) throw new EvaluationError(502, "EVAL_SESSION_SETUP", "真实会话创建结果未确认。");
    sessionId = created.session.id; result.sessionId = sessionId; persistHandle();
    signal.throwIfAborted(); submissionStarted = true;
    const accepted = await runtime.request<{ run: CloudRun }>(authority, "submit", {
      resourceId: sessionId, requestId, message: test.input, maxModelCalls: spec.maxModelCalls,
    }, signal);
    run = accepted.run;
    if (!run?.id || run.sessionId !== sessionId || run.requestId !== requestId) throw new EvaluationError(502, "EVAL_RUN_ADMISSION", "实际任务回执不匹配。");
    result.runId = run.id; persistHandle(); options.onStage("真实模型与业务工具执行中");
    while (run.status === "running" || run.status === "queued") {
      await delay(1000, undefined, { signal });
      run = (await runtime.request<{ run: CloudRun }>(authority, "run", { resourceId: run.id }, signal)).run;
    }
    result.runStatus = run.status; result.answer = run.finalText;
    const events: AgentEvent[] = []; let cursor = 0;
    for (let page = 0; page < 128; page++) {
      const data = await runtime.request<{ events: AgentEvent[]; hasMore: boolean; nextEventSeq: number }>(authority, "events", { resourceId: sessionId, after: cursor }, signal);
      events.push(...data.events.filter(event => event.turnId === run!.id));
      if (!data.hasMore) break;
      if (data.nextEventSeq <= cursor || page === 127) throw new EvaluationError(502, "EVAL_EVIDENCE_INCOMPLETE", "实际事件读取不完整。");
      cursor = data.nextEventSeq;
    }
    result.tools = events.flatMap(event => event.type === "tool.completed"
      ? [{ name: event.payload.toolName, status: "completed", summary: event.payload.summary }]
      : event.type === "tool.failed" ? [{ name: event.payload.toolName, status: "failed", summary: event.payload.code }] : []);
    const first = events.find(event => event.type === "assistant.delta");
    const start = events.find(event => event.type === "turn.started");
    if (first && start) result.firstTextMs = Math.max(0, Date.parse(first.occurredAt) - Date.parse(start.occurredAt));
    result.checks.push({ name: "真实任务完成", passed: run.status === "completed", detail: `持久化任务状态：${run.status}` });
    result.checks.push({ name: "真实工具执行", passed: result.tools.some(tool => tool.status === "failed") ? false : null,
      detail: `${result.tools.length} 次实际工具结果；工具完成不等于业务事实已验证。` });
    for (const fact of test.expectedFacts) result.checks.push({ name: "业务条件待复核", passed: null, detail: fact });
    result.checks.push({ name: "证据范围", passed: null, detail: "实际账号、云端任务、平台网关和业务工具；未配置独立真值核对，业务正确性待复核，记忆召回率未测。" });
    result.verdict = run.status === "completed" && !result.tools.some(tool => tool.status === "failed") ? "review" : "failed";
    await usage();
  } catch (error) {
    // Recover a receipt read-only; never retry the uncertain POST or start another model task.
    if (!run && sessionId && submissionStarted) {
      try {
        const data = await runtime.request<{ runs: CloudRun[] }>(authority, "runs", { resourceId: sessionId });
        run = data.runs.find(item => item.requestId === requestId && item.userMessage === test.input);
        if (run) { result.runId = run.id; persistHandle(); }
      } catch { /* The durable session/request receipt remains available for operators. */ }
    }
    result.runStatus = run?.status ?? (submissionStarted ? "unknown" : "not_started"); result.answer = run?.finalText ?? "";
    result.errorCode = error instanceof EvaluationError ? error.code : options.signal.aborted ? "EVAL_CANCELLED" : "EVAL_TRIAL_TIMEOUT";
    if (run && ["running", "queued"].includes(run.status)) {
      try {
        await runtime.request(authority, "cancel", { resourceId: run.id });
        result.checks.push({ name: "停止请求", passed: null, detail: "已请求停止实际任务；服务端最终状态以原 Run 为准。" });
      } catch { result.checks.push({ name: "停止请求", passed: false, detail: "停止结果未确认；保留原 Run，运行时仍受单轮超时与调用上限保护。" }); }
    }
    result.verdict = options.signal.aborted ? "cancelled" : "failed";
    result.checks.push({ name: "执行异常", passed: false, detail: "实际请求未完成，请按记录中的会话与任务编号核查；未自动重跑。" });
    await usage();
  }
  result.durationMs = Math.round(performance.now() - started);
  return result;
}
