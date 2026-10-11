import type { ToolExecutionRole } from "@daoyin/harness-protocol";

/** Advice from actual balances and obligations; never withholds a tool or adds allowance. */
export function toolBudgetGuidance(input: {
  remaining: number; used: ReadonlyMap<ToolExecutionRole, number>; unresolvedChecks: number;
  unverifiedResources: number; pendingPlanSteps: number; pendingOperations: number;
}): string {
  const checks = input.unresolvedChecks + input.unverifiedResources * 2;
  const observe = input.pendingOperations;
  const closePlan = input.pendingPlanSteps > 0 ? 1 : 0;
  const needed = checks + observe + closePlan;
  if (!input.used.size && !needed) return "";
  const reserved = Math.min(input.remaining, needed);
  return "\n工具分配依据（建议，不是额外额度或权限）：" + JSON.stringify({
    attemptedByRole: Object.fromEntries(input.used), remaining: input.remaining,
    unresolvedChecks: input.unresolvedChecks, unverifiedResources: input.unverifiedResources,
    pendingOperations: input.pendingOperations, pendingPlanSteps: input.pendingPlanSteps,
    suggestedCheckCalls: checks, suggestedOperationReadCalls: observe, suggestedPlanCloseoutCalls: closePlan,
    suggestedReserve: reserved, optionalExplorationAllowance: Math.max(0, input.remaining - reserved),
  }) + "\n先保留结果核对与计划收尾所需的调用，再安排可选探索。修改通常还需检查差异并运行受影响的现有行为；失败检查需要定位、修正并重跑，以上只是下限估计。" +
    (needed >= input.remaining && needed > 0 ? "当前余额不足以保证所有核对完成，优先最必要的真实检查并保存明确的未完成项；不要把剩余额度继续耗在重复读取。" : "") +
    (observe ? "长操作观察同一编号和新 cursor，使用允许的有界等待，复用完成事件；没有新输出时不要反复短轮询，也不要重启操作。" : "") +
    "为责任层定位所必需的读取仍可执行，不强迫修改或创建计划；同一批工具不能超出实际剩余工具额度。";
}
