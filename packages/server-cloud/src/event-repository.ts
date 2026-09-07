import { executionScopeKey, type ExecutionScope } from "@daoyin/harness-contracts";
import type { CloudRepository } from "./repository.js";

/**
 * Adapt async stores (including PostgreSQL) without modifying their transactions.
 * The repository contract resolves mutations after commit. Notify only afterwards.
 * This is single-executor invalidation, NOT cross-worker LISTEN/NOTIFY or an outbox.
 */
export function withCommittedSessionEvents(base: CloudRepository): CloudRepository {
  if (base.subscribeSession !== undefined) return base;
  const listeners = new Map<string, Set<() => void>>();
  const key = (scope: ExecutionScope, sessionId: string): string => JSON.stringify([executionScopeKey(scope), sessionId]);
  const notify = (scope: ExecutionScope, sessionId: string): void => {
    for (const listener of [...(listeners.get(key(scope, sessionId)) ?? [])]) {
      try { listener(); } catch { /* A notification failure cannot undo a commit. */ }
    }
  };
  return {
    ...(base.memory === undefined ? {} : { memory: base.memory }),
    ...(base.checkReadiness === undefined ? {} : { checkReadiness: () => base.checkReadiness!() }),
    assertExecutionOwner: () => base.assertExecutionOwner?.(),
    // The WS route checks getSession before subscription; keys also include scope.
    subscribeSession(scope, sessionId, listener) {
      const id = key(scope, sessionId);
      const subscriptions = listeners.get(id) ?? new Set<() => void>();
      subscriptions.add(listener); listeners.set(id, subscriptions);
      return () => { subscriptions.delete(listener); if (!subscriptions.size) listeners.delete(id); };
    },
    createSession: (scope, input) => base.createSession(scope, input),
    listSessions: (scope) => base.listSessions(scope),
    getSession: (scope, sessionId) => base.getSession(scope, sessionId),
    ...(base.manageSession === undefined ? {} : {
      async manageSession(scope: ExecutionScope, sessionId: string, action: import("./repository.js").SessionAction) {
        const result = await base.manageSession!(scope, sessionId, action);
        notify(scope, sessionId);
        return result;
      },
    }),
    getRun: (scope, runId) => base.getRun(scope, runId),
    findRequest: (scope, sessionId, requestId) => base.findRequest(scope, sessionId, requestId),
    listRuns: (scope, sessionId) => base.listRuns(scope, sessionId),
    readEvents: (scope, sessionId, after, limit) => base.readEvents(scope, sessionId, after, limit),
    async acceptRun(identity, sessionId, requestId, message) {
      const result = await base.acceptRun(identity, sessionId, requestId, message);
      if (result.created) notify(identity, sessionId);
      return result;
    },
    async bindRun(scope, sessionId, runId): Promise<import("./repository.js").BoundRunStores> {
      const stores = await base.bindRun(scope, sessionId, runId);
      return { ...stores, events: {
        read: (session, after) => stores.events.read(session, after),
        append: async (pending) => {
          const event = await stores.events.append(pending);
          notify(scope, sessionId);
          return event;
        },
      } };
    },
    async requestCancellation(scope, runId) {
      const result = await base.requestCancellation(scope, runId);
      notify(scope, result.sessionId);
      return result;
    },
    async interruptRun(scope, runId, reason) {
      const run = await base.getRun(scope, runId);
      await base.interruptRun(scope, runId, reason);
      notify(scope, run.sessionId);
    },
  };
}
