import { setTimeout as delay } from "node:timers/promises";
import type { ModelClient } from "@daoyin/harness-agent-core";
import type { AgentEvent } from "@daoyin/harness-protocol";
import { createCloudServer } from "../app.js";
import type { CloudRun } from "../repository.js";
import { SqliteCloudRepository } from "../sqlite-repository.js";
import { createFixture, fixtureIdentity } from "./fixtures.js";
import { EvaluationProvider, type CallBudget, type EvaluationModelConfig } from "./provider.js";
import { EvaluationError, TEMPLATES, type Check, type EvaluationCase, type EvaluationSpec, type Trial } from "./contracts.js";

export interface TrialOptions {
  spec: EvaluationSpec; test: EvaluationCase; repetition: number; signal: AbortSignal;
  budget: CallBudget; model?: EvaluationModelConfig; fetcher?: typeof fetch;
  onStage?: (stage: string) => void;
}
export async function runTrial(options: TrialOptions): Promise<Trial> {
  const { spec, test, repetition } = options;
  const repository = new SqliteCloudRepository(":memory:");
  const identity = fixtureIdentity();
  const startedAt = performance.now();
  let modelCalls = 0; let judgeCalls = 0; let errorCode: string | null = null;
  let firstTextMs: number | null = null; let finalRun: CloudRun | undefined;
  const checks: Check[] = []; const attempted: string[] = [];
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  const deadline = setTimeout(() => controller.abort("trial-timeout"), 120_000);
  let app: ReturnType<typeof createCloudServer> | undefined;
  let provider: EvaluationProvider | undefined;
  const budget: CallBudget = { async take(kind) {
    signal.throwIfAborted();
    if (kind === "agent" && modelCalls >= spec.maxModelCalls) throw new EvaluationError(409, "EVAL_CALL_LIMIT", "本题达到模型调用上限。");
    await options.budget.take(kind);
    if (kind === "agent") modelCalls++; else judgeCalls++;
    options.onStage?.(kind === "agent" ? `模型调用 ${modelCalls}` : "独立判分");
  } };
  try {
    signal.throwIfAborted();
    const fixture = await createFixture(test, repository, identity);
    if (spec.mode === "live") {
      if (!options.model || !spec.confirmPaid) throw new EvaluationError(503, "EVAL_MODEL_NOT_CONFIGURED", "真实评估模型尚未配置。");
      provider = new EvaluationProvider(options.model, budget, options.fetcher);
    }
    const base = provider ? provider.client() : fixture.replay();
    const model: ModelClient = { complete: async request => {
      if (!provider) await budget.take("agent");
      try {
        const reply = await base.complete({ ...request, signal: AbortSignal.any([request.signal, signal]) });
        if (reply.kind === "tool_calls") attempted.push(...reply.calls.map(c => c.name));
        return reply;
      } catch (error) {
        errorCode = error instanceof EvaluationError ? error.code : "EVAL_MODEL_EXECUTION";
        throw error;
      }
    } };
    app = createCloudServer({ repository, authenticate: async token => token === "isolated-evaluation" ? identity : null,
      // This identity belongs only to the isolated fixture. Real administrator
      // authority is rechecked by the evaluation service before every paid call.
      // Keep the fixture cancellation endpoint usable after its parent aborts.
      isAuthorizationActive: async () => true, resolveProfile: async () => fixture.profile,
      createModel: async () => model, maxConcurrentRuns: 1, runTimeoutMs: 120_000 });
    await app.ready();
    const headers = { authorization: "Bearer isolated-evaluation" };
    const sessionResponse = await app.inject({ method: "POST", url: "/api/v1/cloud/sessions", headers, payload: { title: "隔离评估会话" } });
    if (sessionResponse.statusCode !== 201) throw new EvaluationError(503, "EVAL_SESSION_SETUP", "隔离会话创建失败。");
    const sessionId = sessionResponse.json<{ session: { id: string } }>().session.id;
    const response = await app.inject({ method: "POST", url: `/api/v1/cloud/sessions/${sessionId}/runs`, headers,
      payload: { requestId: `trial_${repetition}`, message: test.input } });
    if (response.statusCode !== 202) throw new EvaluationError(503, "EVAL_RUN_ADMISSION", "隔离任务未受理。");
    const runId = response.json<{ run: CloudRun }>().run.id;
    while (!signal.aborted) {
      finalRun = await repository.getRun(identity, runId);
      if (firstTextMs === null && finalRun.lastEventSeq > 0) {
        const page = await repository.readEvents(identity, sessionId, 0, 200);
        if (page.some(e => e.type === "assistant.delta")) firstTextMs = Math.round(performance.now() - startedAt);
      }
      if (finalRun.status !== "running" && finalRun.status !== "queued") break;
      await delay(30);
    }
    if (signal.aborted) {
      await app.inject({ method: "POST", url: `/api/v1/cloud/runs/${runId}/cancel`, headers, payload: {} });
      await app.close();
      finalRun = await repository.getRun(identity, runId);
      throw new EvaluationError(409, options.signal.aborted ? "EVAL_CANCELLED" : "EVAL_TRIAL_TIMEOUT", "该次试验已停止，未自动重跑。");
    }
    const events: AgentEvent[] = await repository.bindRun(identity, sessionId, runId).events.read(sessionId);
    checks.push({ name: "任务完成", passed: finalRun?.status === "completed", detail: `实际状态：${finalRun?.status ?? "unknown"}` });
    const allowed = new Set(fixture.profile.tools.map(t => t.definition.name));
    checks.push({ name: "工具和资源边界", passed: attempted.every(t => allowed.has(t)) && fixture.forbiddenAttempts.count === 0,
      detail: `越界尝试 ${fixture.forbiddenAttempts.count + attempted.filter(t => !allowed.has(t)).length} 次` });
    if (test.template === "saishi-materials") checks.push({ name: "素材证据覆盖", passed: fixture.readIds.size === 40, detail: `已读取 ${fixture.readIds.size}/40 条` });
    const uses = repository.memory.references(identity, sessionId, runId);
    const ids = [...new Set(uses.map(use => use.id))];
    const recall = fixture.expectedMemoryId ? (ids.includes(fixture.expectedMemoryId) ? 1 : 0) : null;
    if (fixture.expectedMemoryId) {
      checks.push({ name: "最新记忆进入上下文", passed: recall === 1, detail: `参考记忆覆盖 ${recall}/1` });
      checks.push({ name: "旧值及他人记忆隔离", passed: fixture.forbiddenMemoryIds.every(id => !ids.includes(id)), detail: "按实际引用 ID 核验" });
    }
    const answer = finalRun?.finalText ?? "";
    let verdict: Trial["verdict"] = checks.some(check => check.passed === false) ? "failed" : "passed";
    const requiredFacts = [...new Set([...TEMPLATES.find(t => t.id === test.template)!.facts, ...test.expectedFacts])].slice(0, 10);
    if (verdict === "passed" && spec.mode === "live") {
      if (!requiredFacts.length) {
        verdict = "review"; checks.push({ name: "业务成功标准", passed: null, detail: "未配置可核对标准，不将非空回答计为成功。" });
      } else {
        try {
          const judged = await provider!.judge({ question: test.input, answer, facts: requiredFacts, reference: fixture.reference }, signal);
          checks.push(...judged);
          if (judged.some(c => c.passed === false)) verdict = "failed";
          else if (judged.some(c => c.passed === null)) verdict = "review";
          if (test.template === "explore" && verdict === "passed") {
            verdict = "review";
            checks.push({ name: "独立事实核验", passed: null, detail: "自由探索仅完成语义评分，没有专用业务核对器，不能宣称已验证业务成功。" });
          }
        } catch (error) {
          errorCode = error instanceof EvaluationError ? error.code : "EVAL_JUDGE_FAILED";
          verdict = options.signal.aborted ? "cancelled" : "judge_error";
          checks.push({ name: "语义判分", passed: null, detail: "判分未完成，不计成功。" });
        }
      }
    } else if (spec.mode === "replay") {
      if (test.template === "explore" && verdict === "passed") verdict = "review";
      checks.push({ name: "证据范围", passed: null, detail: "程序预设回复；仅协议与夹具检查，不计真实模型任务成功率。" });
    }
    return { caseId: test.id, repetition, verdict, runStatus: finalRun?.status ?? "unknown", answer,
      checks, tools: events.flatMap(e => e.type === "tool.completed" ? [{ name: e.payload.toolName, status: "completed", summary: e.payload.summary }] :
        e.type === "tool.failed" ? [{ name: e.payload.toolName, status: "failed", summary: e.payload.code }] : []),
      modelCalls, judgeCalls, durationMs: Math.round(performance.now() - startedAt), firstTextMs,
      inputTokens: provider?.usage.inputTokens ?? null, outputTokens: provider?.usage.outputTokens ?? null,
      recall, retrievedMemoryIds: ids.map(id => id === fixture.expectedMemoryId ? "current-preference" : fixture.forbiddenMemoryIds.includes(id) ? "forbidden-reference" : "other-reference"), errorCode };
  } catch (error) {
    return { caseId: test.id, repetition, verdict: options.signal.aborted ? "cancelled" : "failed", runStatus: finalRun?.status ?? "not_started",
      answer: finalRun?.finalText ?? "", checks: [...checks, { name: "执行异常", passed: false, detail: "该次试验未完成，详见错误代码。" }], tools: [], modelCalls, judgeCalls,
      durationMs: Math.round(performance.now() - startedAt), firstTextMs, inputTokens: provider?.usage.inputTokens ?? null,
      outputTokens: provider?.usage.outputTokens ?? null, recall: null, retrievedMemoryIds: [],
      errorCode: error instanceof EvaluationError ? error.code : errorCode ?? "EVAL_RUNTIME_FAILURE" };
  } finally { clearTimeout(deadline); await app?.close(); repository.close(); }
}
