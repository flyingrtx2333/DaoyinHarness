import type { AgentEvent } from "@daoyin/harness-protocol";
import type { AgentTurnInput } from "./agent-engine.js";

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

function memoryError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Finite wait; unknown outcomes never trigger another provider/model call. */
export async function memoryOperation<T>(operation: (signal: AbortSignal) => Promise<T>, parent: AbortSignal): Promise<T> {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(5_000)]);
  signal.throwIfAborted();
  let listener: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(new Error("Memory wait aborted"));
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return operation(signal); }), interrupted]);
  } catch (error) {
    const changed = typeof error === "object" && error !== null && "code" in error && error.code === "MEMORY_CONTEXT_CHANGED";
    throw memoryError(changed ? "AGENT_MEMORY_CHANGED" : "AGENT_MEMORY_UNAVAILABLE",
      changed ? "The memory context changed; start a new turn." : "The memory service or reference check was unavailable; the turn was not continued.");
  } finally {
    if (listener !== undefined) signal.removeEventListener("abort", listener);
  }
}

/** Bound by the trusted runtime to the current namespace; the model cannot choose a tenant. */
export interface AgentMemoryProvider {
  load(request: MemoryContextRequest): Promise<MemoryContextSnapshot>;
}

export function memoryContextView(snapshot: MemoryContextSnapshot, events: readonly AgentEvent[]): AgentEvent[] {
  if (typeof snapshot.text !== "string" || snapshot.text.length > 12_000 ||
      !Array.isArray(snapshot.excludedTurns) || snapshot.excludedTurns.length > 5_000 ||
      typeof snapshot.assertCurrent !== "function") {
    throw memoryError("AGENT_MEMORY_INVALID", "The memory service returned an invalid context.");
  }
  const excluded = new Set(snapshot.excludedTurns.map((item) => {
    if (typeof item.sessionId !== "string" || typeof item.turnId !== "string") {
      throw memoryError("AGENT_MEMORY_INVALID", "The memory dependency scope was invalid.");
    }
    return JSON.stringify([item.sessionId, item.turnId]);
  }));
  return events.filter((event) => !excluded.has(JSON.stringify([event.sessionId, event.turnId])));
}
