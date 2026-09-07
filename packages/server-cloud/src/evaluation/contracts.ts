// Browser-safe contracts. No server credentials or executable user-supplied expressions.
export const EVALUATOR_VERSION = "harness-evaluation-v2-live-runtime";
export type TemplateId = "saishi-materials" | "memory-current" | "explore";
export type EvaluationMode = "replay" | "live";
export type Verdict = "passed" | "failed" | "review" | "judge_error" | "cancelled";
export interface EvaluationCase { id: string; input: string; template: TemplateId; expectedFacts: string[]; approved: boolean }
export interface EvaluationSpec {
  requestId: string; title: string; mode: EvaluationMode; repetitions: number; maxModelCalls: number;
  maxTotalCalls: number; confirmPaid: boolean; cases: EvaluationCase[];
}
export interface Check { name: string; passed: boolean | null; detail: string }
export interface Trial {
  caseId: string; repetition: number; verdict: Verdict; runStatus: string; answer: string;
  checks: Check[]; tools: Array<{ name: string; status: string; summary: string }>;
  modelCalls: number; judgeCalls: number; durationMs: number; firstTextMs: number | null;
  inputTokens: number | null; outputTokens: number | null; recall: number | null;
  retrievedMemoryIds: string[]; errorCode: string | null;
  sessionId?: string; runId?: string; requestId?: string; runtimeRevision?: string | null;
  modelName?: string | null; modelCallsKnown?: boolean; evidenceKind?: string;
}
export interface RuntimeHandle { caseId: string; repetition: number; sessionId: string; requestId: string; runId?: string }

export interface Experiment {
  id: string; actorId: string; createdAt: string; finishedAt: string | null;
  status: "running" | "cancelling" | "completed" | "cancelled" | "interrupted" | "failed";
  spec: EvaluationSpec; configurationHash: string; version: string; model: string | null;
  revision: string | null; trials: Trial[]; planned: number; completed: number; runtimeHandles?: RuntimeHandle[];
}
export const TEMPLATES: ReadonlyArray<{ id: TemplateId; name: string; fixture: string; facts: string[] }> = [
  { id: "saishi-materials", name: "赛事素材状态", fixture: "隔离账号可查一场赛事；40 条素材分两页，其中 30 条完成、7 条处理中、3 条失败。只读，不接生产赛事。",
    facts: ["完整说明 40 条素材的处理情况：30 条完成、7 条处理中、3 条失败", "数据是查询快照，不表示已重跑分析或重新探测"] },
  { id: "memory-current", name: "最新记忆召回", fixture: "预置并确认竖屏偏好；旧横屏偏好已更正，另有其他用户的干扰记忆。测试召回与使用，不代表测试了自动提取。",
    facts: ["当前视频偏好为竖屏，不使用旧横屏值", "不泄露其他用户的偏好"] },
  { id: "explore", name: "自由探索", fixture: "无生产业务数据。未填写成功条件时只观察执行，不将非空回答判为成功。", facts: [] },
];
export class EvaluationError extends Error {
  public constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
export const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function object(v: unknown, keys: string[]): Record<string, unknown> {
  if (!record(v) || Object.keys(v).some(k => !keys.includes(k))) throw new EvaluationError(400, "INVALID_INPUT", "测试参数不正确。");
  return v;
}
function text(v: unknown, max: number): string {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new EvaluationError(400, "INVALID_TEXT", "请填写有效的测试文本。");
  // Fail before storage/provider transmission. This is not a general PII anonymizer.
  if (/Bearer\s+[A-Za-z0-9._-]{16,}|(?:sk-|das_|saishi_agent_)[A-Za-z0-9_-]{24,}/u.test(v)) throw new EvaluationError(400, "SECRET_IN_INPUT", "请移除访问凭证后再导入用例。");
  return v.trim();
}
function integer(v: unknown, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) throw new EvaluationError(400, "INVALID_LIMIT", "次数或调用上限不正确。");
  return v;
}
export function prepareCases(value: unknown): EvaluationCase[] {
  const raw = object(value, ["lines"]);
  const lines = text(raw.lines, 60_000).split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  if (!lines.length || lines.length > 50) throw new EvaluationError(400, "CASE_LIMIT", "每批请填写 1–50 条输入，一行一题。");
  return lines.map((line, index) => {
    const template: TemplateId = /素材.*(?:状态|处理)|(?:处理|状态).*素材/u.test(line) ? "saishi-materials" : /(?:之前|刚才|记得).*(?:画幅|竖屏|视频偏好)/u.test(line) ? "memory-current" : "explore";
    return { id: `case_${index + 1}`, input: text(line, 2000), template, expectedFacts: [...TEMPLATES.find(t => t.id === template)!.facts], approved: false };
  });
}
export function parseSpec(value: unknown): EvaluationSpec {
  const raw = object(value, ["requestId", "title", "mode", "repetitions", "maxModelCalls", "maxTotalCalls", "confirmPaid", "cases"]);
  if (!Array.isArray(raw.cases) || !raw.cases.length || raw.cases.length > 50) throw new EvaluationError(400, "CASE_LIMIT", "每批最多 50 题。");
  const ids = new Set<string>();
  const cases = raw.cases.map(v => {
    const item = object(v, ["id", "input", "template", "expectedFacts", "approved"]);
    const id = text(item.id, 64);
    if (!/^[A-Za-z0-9_-]+$/u.test(id) || ids.has(id)) throw new EvaluationError(400, "CASE_ID", "题目编号不能重复。");
    ids.add(id);
    if (!TEMPLATES.some(t => t.id === item.template) || item.approved !== true || !Array.isArray(item.expectedFacts) || item.expectedFacts.length > 8) throw new EvaluationError(400, "CASE_NOT_APPROVED", "请先确认场景和成功条件。");
    return { id, input: text(item.input, 2000), template: item.template as TemplateId, expectedFacts: item.expectedFacts.map(fact => text(fact, 500)), approved: true };
  });
  if (typeof raw.mode !== "string" || !["replay", "live"].includes(raw.mode)) throw new EvaluationError(400, "MODE_INVALID", "请选择测试方式。");
  const mode = raw.mode as EvaluationMode;
  if (typeof raw.confirmPaid !== "boolean" || (mode === "live" && raw.confirmPaid !== true)) throw new EvaluationError(400, "PAID_CONFIRMATION_REQUIRED", "真实模型评测需要确认费用和调用上限。");
  const repetitions = integer(raw.repetitions, 1, 5);
  const maxModelCalls = integer(raw.maxModelCalls, 2, 12);
  const maxTotalCalls = integer(raw.maxTotalCalls, 1, 3250);
  if (mode === "live" && maxTotalCalls < cases.length * repetitions * (maxModelCalls + 1)) throw new EvaluationError(400, "BUDGET_TOO_SMALL", "总调用上限须覆盖每题模型上限及一次独立判分。");
  const requestId = text(raw.requestId, 128);
  if (!/^[A-Za-z0-9_-]+$/u.test(requestId)) throw new EvaluationError(400, "REQUEST_ID", "提交编号无效。");
  return { requestId, title: text(raw.title, 100), mode, repetitions, maxModelCalls, maxTotalCalls, confirmPaid: raw.confirmPaid, cases };
}
export function metrics(run: Experiment) {
  const passed = run.trials.filter(t => t.verdict === "passed").length;
  const completeCases = run.spec.cases.filter(c => run.trials.filter(t => t.caseId === c.id).length === run.spec.repetitions);
  const repeatedPass = completeCases.filter(c => run.trials.filter(t => t.caseId === c.id).every(t => t.verdict === "passed")).length;
  const recalls = run.trials.map(t => t.recall).filter((v): v is number => v !== null);
  return { passed, failed: run.trials.filter(t => t.verdict === "failed").length,
    review: run.trials.filter(t => t.verdict === "review" || t.verdict === "judge_error").length,
    notRun: run.planned - run.trials.length,
    verifiedSuccessRate: run.version !== EVALUATOR_VERSION && run.spec.mode === "live" && run.planned ? passed / run.planned : null,
    protocolPassRate: run.spec.mode === "replay" && run.planned ? passed / run.planned : null,
    repeatAllPassRate: run.version === EVALUATOR_VERSION ? null : run.spec.cases.length ? repeatedPass / run.spec.cases.length : 0,
    meanRecall: recalls.length ? recalls.reduce((a, b) => a + b, 0) / recalls.length : null,
    recallSamples: recalls.length, modelCalls: run.trials.reduce((n, t) => n + t.modelCalls, 0),
    judgeCalls: run.trials.reduce((n, t) => n + t.judgeCalls, 0),
    executionCompletionRate: run.planned ? run.trials.filter(trial => trial.runStatus === "completed").length / run.planned : null,
    financialCost: null, evidenceKind: run.version === EVALUATOR_VERSION ? "real-platform-account-runtime"
      : run.spec.mode === "live" ? "real-model-isolated-fixtures" : "scripted-replay-not-model-quality" };
}
