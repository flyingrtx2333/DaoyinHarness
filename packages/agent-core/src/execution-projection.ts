import type { SessionEventStore } from "@daoyin/harness-contracts";
import type { AgentEvent, TaskPlan } from "@daoyin/harness-protocol";
import { taskTurnIds } from "./task-scope.js";
import { VerificationState } from "./verification-state.js";

/** A rebuildable in-memory view; the append-only transcript remains canonical. */
export class ExecutionProjection {
  readonly verification: VerificationState;
  readonly #turns: Set<string>;
  #cursor = 0;
  plan: TaskPlan | undefined;

  constructor(events: readonly AgentEvent[], turnId: string) {
    this.#turns = taskTurnIds(events, turnId);
    this.verification = new VerificationState(events, turnId);
    for (const event of events) this.#plan(event);
  }

  #plan(event: AgentEvent): void {
    this.#cursor = Math.max(this.#cursor, event.eventSeq);
    if (event.type === "task_plan.updated" && this.#turns.has(event.turnId)) this.plan = structuredClone(event.payload.plan);
  }

  async refresh(store: SessionEventStore, scope: { accountId: string; scopeId: string; sessionId: string }): Promise<void> {
    const events = await store.read(scope.sessionId, this.#cursor);
    for (const event of events) {
      if (event.accountId !== scope.accountId || event.scopeId !== scope.scopeId || event.sessionId !== scope.sessionId) throw new Error("Execution projection scope mismatch.");
      if (event.eventSeq <= this.#cursor) continue;
      this.verification.observe(event);
      this.#plan(event);
    }
  }
}
