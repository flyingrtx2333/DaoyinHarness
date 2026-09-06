import type { AgentEvent } from "@daoyin/harness-protocol";
import { CloudError } from "./repository.js";

/** Admission bounds, not a retention policy. Nothing here deletes old events. */
export const HISTORY_LIMITS = Object.freeze({
  runs: 100, events: 16_000, bytes: 16 * 1024 * 1024,
  replayEvents: 24_000, replayBytes: 32 * 1024 * 1024,
  pageBytes: 512 * 1024, pageSize: 200,
});
export function assertHistoryAdmission(usage: { runs: number; events: number; bytes: number }): void {
  if (Object.values(usage).some((value) => !Number.isSafeInteger(value) || value < 0)) throw new CloudError(503, "HISTORY_USAGE_INVALID", "无法核对历史容量。");
  if (usage.runs >= HISTORY_LIMITS.runs || usage.events >= HISTORY_LIMITS.events || usage.bytes >= HISTORY_LIMITS.bytes) {
    throw new CloudError(409, "SESSION_HISTORY_LIMIT", "本会话已达到回合或历史容量上限，请新建会话；原记录仍可查看。");
  }
}

/** Complete, bounded engine history. No silently truncated tool/result or terminal pair. */
export async function readCompleteHistory(sessionId: string, after: number,
  readPage: (after: number, limit: number) => Promise<AgentEvent[]>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  let cursor = after;
  let bytes = 0;
  for (;;) {
    const page = await readPage(cursor, HISTORY_LIMITS.pageSize);
    if (!page.length) return result;
    for (const event of page) {
      if (event.sessionId !== sessionId || event.eventSeq !== cursor + 1) throw new CloudError(409, "HISTORY_EVENT_GAP", "历史事件不连续，未将不完整记录交给模型。");
      bytes += Buffer.byteLength(JSON.stringify(event), "utf8");
      if (result.length >= HISTORY_LIMITS.replayEvents || bytes > HISTORY_LIMITS.replayBytes) {
        throw new CloudError(409, "SESSION_CONTEXT_LIMIT", "完整历史超过本次执行读取上限，请新建会话；原记录仍可分页查看。");
      }
      result.push(event); cursor = event.eventSeq;
    }
    if (page.length < HISTORY_LIMITS.pageSize) return result;
  }
}

/** BFFs bound response bytes. A byte-limited page still advertises hasMore correctly. */
export function eventPage(rows: AgentEvent[], after: number): { events: AgentEvent[]; nextEventSeq: number; hasMore: boolean } {
  const events: AgentEvent[] = [];
  let bytes = 256;
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
    if (bytes + size > HISTORY_LIMITS.pageBytes) {
      if (!events.length) throw new CloudError(413, "EVENT_TOO_LARGE", "单条事件超过回放限制。");
      break;
    }
    events.push(row); bytes += size;
  }
  return { events, nextEventSeq: events.at(-1)?.eventSeq ?? after,
    hasMore: events.length < rows.length || rows.length === HISTORY_LIMITS.pageSize };
}
