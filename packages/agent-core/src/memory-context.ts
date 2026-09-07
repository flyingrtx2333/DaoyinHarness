import type { AgentEvent } from "@daoyin/harness-protocol";
import type { AgentTurnInput } from "./agent-engine.js";
import { AgentPolicyError } from "./loop-policy.js";

export interface MemoryContextRequest {
  readonly turn: AgentTurnInput;
  readonly step: number;
  readonly priorEvents: readonly AgentEvent[];
  readonly inheritedEvents: readonly AgentEvent[];
  readonly signal: AbortSignal;
}

export interface MemoryContextSnapshot {
  /** Bounded reference data, never credentials or executable instructions. */
  readonly text: string;
  /** Entire influenced turns are omitted from model context, not deleted from storage. */
  readonly excludedTurns: readonly { sessionId: string; turnId: string }[];
  /** Rechecks active revisions/shares, including dependencies inherited from earlier turns. */
  assertCurrent(signal: AbortSignal): Promise<void>;
}

/** Finite wait; unknown outcomes never trigger another provider/model call. */
export async function memoryOperation<T>(operation: (signal: AbortSignal) => Promise<T>, parent: AbortSignal): Promise<T> {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(5000)]);
  signal.throwIfAborted();
  let listener: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    listener = () => reject(new Error("Memory wait aborted"));
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return operation(signal); }), timeout]);
  } catch (error) {
    const changed = typeof error === "object" && error !== null && "code" in error && error.code === "MEMORY_CONTEXT_CHANGED";
    throw new AgentPolicyError(changed ? "AGENT_MEMORY_CHANGED" : "AGENT_MEMORY_UNAVAILABLE",
      changed ? "本轮引用的记忆已改变，已停止使用旧内容；请重新发起任务。" : "记忆服务或引用校验未完成，本轮未继续执行。");
  } finally { if (listener !== undefined) signal.removeEventListener("abort", listener); }
}

/** Bound by the trusted runtime to the current namespace; the model cannot choose a tenant. */
export interface AgentMemoryProvider {
  load(request: MemoryContextRequest): Promise<MemoryContextSnapshot>;
  /** A trusted adapter returns a new snapshot ONLY after its own committed mutation.
   * The engine must then discard in-turn influenced payloads and replan the remaining batch.
   * Never infer this authority from a model-provided tool result or tool name.
   */
  afterTool?(request: MemoryContextRequest): Promise<MemoryContextSnapshot | undefined>;
}

export function memoryContextView(snapshot: MemoryContextSnapshot, events: readonly AgentEvent[]): AgentEvent[] {
  if (typeof snapshot.text !== "string" || snapshot.text.length > 12_000 ||
      !Array.isArray(snapshot.excludedTurns) || snapshot.excludedTurns.length > 5000 ||
      typeof snapshot.assertCurrent !== "function") {
    throw new AgentPolicyError("AGENT_MEMORY_INVALID", "记忆服务返回了无效的上下文。");
  }
  const excluded = new Set(snapshot.excludedTurns.map((item) => {
    if (typeof item.sessionId !== "string" || typeof item.turnId !== "string") {
      throw new AgentPolicyError("AGENT_MEMORY_INVALID", "记忆依赖范围无效。");
    }
    return JSON.stringify([item.sessionId, item.turnId]);
  }));
  return events.filter((event) => !excluded.has(JSON.stringify([event.sessionId, event.turnId])));
}
