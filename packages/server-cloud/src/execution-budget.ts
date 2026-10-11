import { CloudError } from "./repository.js";

/** Trusted root allowance. Counts include routing, summaries and all children. */
export interface ExecutionBudget {
  maxModelCalls: number;
  maxToolCalls: number;
  maxActiveMs: number;
}
export const DEFAULT_EXECUTION_BUDGET: Readonly<ExecutionBudget> = Object.freeze({
  maxModelCalls: 24, maxToolCalls: 96, maxActiveMs: 600_000,
});
export interface RunAdmission {
  limits?: Partial<ExecutionBudget>;
  maxModelCalls?: number;
  continueFromRunId?: string;
}
export function executionBudget(value: unknown): ExecutionBudget {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CloudError(400, "BUDGET_INVALID", "执行额度无效。");
  const budget = value as Record<string, unknown>;
  const result = {} as ExecutionBudget;
  for (const name of ["maxModelCalls", "maxToolCalls", "maxActiveMs"] as const) {
    const selected = budget[name];
    if (!Number.isSafeInteger(selected) || Number(selected) < 1 || Number(selected) > DEFAULT_EXECUTION_BUDGET[name]) {
      throw new CloudError(400, "BUDGET_INVALID", "请求额度超过平台或宿主许可。");
    }
    result[name] = Number(selected);
  }
  if (Object.keys(budget).some(name => !Object.hasOwn(result, name))) throw new CloudError(400, "BUDGET_INVALID", "执行额度包含未知字段。");
  return result;
}
export function requestedBudget(input: RunAdmission, hostActiveMs: number): ExecutionBudget {
  if (input.limits !== undefined && input.maxModelCalls !== undefined) throw new CloudError(400, "BUDGET_CONFLICT", "limits 与 maxModelCalls 不能同时提交。");
  const limits = executionBudget({ ...DEFAULT_EXECUTION_BUDGET, ...input.limits,
    ...(input.maxModelCalls === undefined ? {} : { maxModelCalls: input.maxModelCalls }) });
  if (limits.maxActiveMs > hostActiveMs && input.limits?.maxActiveMs !== undefined) throw new CloudError(400, "BUDGET_INVALID", "执行时间超过宿主许可。");
  return { ...limits, maxActiveMs: Math.min(limits.maxActiveMs, hostActiveMs) };
}
export function admissionHashInput(message: string, admission: RunAdmission): string {
  // Preserve historical message-only hashes when the old request has no options.
  if (!Object.keys(admission).length) return message;
  return JSON.stringify([message, admission.maxModelCalls ?? null,
    admission.limits?.maxModelCalls ?? null, admission.limits?.maxToolCalls ?? null,
    admission.limits?.maxActiveMs ?? null, admission.continueFromRunId ?? null]);
}
