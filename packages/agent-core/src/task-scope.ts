import type { AgentEvent } from "@daoyin/harness-protocol";

/** Only trusted, persisted explicit continuations share task obligations. */
export function taskTurnIds(events: readonly AgentEvent[], turnId: string): Set<string> {
  const links = new Map(events.flatMap(event => event.type === "turn.started" && event.payload.continueFromTurnId
    ? [[event.turnId, event.payload.continueFromTurnId] as const] : []));
  const result = new Set<string>();
  let cursor: string | undefined = turnId;
  while (cursor !== undefined && !result.has(cursor)) {
    result.add(cursor);
    cursor = links.get(cursor);
  }
  return result;
}
