import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentEventType, PendingAgentEvent, SessionCompaction } from "@daoyin/harness-protocol";
import type { SessionCompactionStore } from "@daoyin/harness-contracts";
import { ContextCompactor } from "./context-compactor.js";
import { sessionEvidence } from "./session-context.js";

function fixture() {
  const events: AgentEvent[] = [];
  const summaries: SessionCompaction[] = [];
  const store: SessionCompactionStore = {
    latest: async () => summaries.at(-1), list: async () => summaries,
    append: async (input) => {
      const record: SessionCompaction = { ...input, id: `cmp-${summaries.length}`, createdAt: "2026-09-06" };
      summaries.push(record);
      return record;
    },
  };
  function event<T extends AgentEventType>(turnId: string, type: T, payload: PendingAgentEvent<T>["payload"]): void {
    events.push({ id: `e-${events.length}`, eventSeq: events.length + 1, occurredAt: "2026-09-06",
      accountId: "a", scopeId: "r", sessionId: "s", turnId, type, payload } as AgentEvent);
  }
  const begin = (turn: string, text = turn): void => event(turn, "turn.started", { status: "running", userMessageId: `m-${turn}`, userMessage: text });
  const end = (turn: string): void => event(turn, "turn.completed", { status: "completed", assistantMessageId: `a-${turn}`, outcomeSummary: `answer-${turn}` });
  const compactor = new ContextCompactor({ store, retainRecentTurns: 1, triggerUncompactedTurns: 2, maxSummaryCharacters: 2000 });
  return { events, summaries, compactor, event, begin, end };
}

describe("compaction and execution evidence recovery (pure event replay)", () => {
  it("does not advance a watermark across an unfinished earlier turn", async () => {
    const f = fixture();
    f.begin("unfinished");
    for (const turn of ["later-1", "later-2", "later-3"]) { f.begin(turn); f.end(turn); }
    expect(await f.compactor.compactIfNeeded("s", f.events)).toBeUndefined();
    expect(f.summaries).toHaveLength(0);
  });

  it("does not partially summarize interleaved turns with a scalar source boundary", async () => {
    const f = fixture();
    f.begin("a"); f.begin("b"); f.end("a"); f.end("b");
    f.begin("c"); f.end("c");
    expect(await f.compactor.compactIfNeeded("s", f.events)).toBeUndefined();
  });

  it("keeps bounded parseable summaries across repeated compaction and retains raw evidence", async () => {
    const f = fixture();
    for (let index = 0; index < 12; index += 1) {
      const turn = `turn-${index}`;
      f.begin(turn, `${turn}:` + "超长正文".repeat(3000));
      f.event(turn, "tool.started", { toolCallId: "reused-id", toolName: "lookup", displayText: "query", input: { query: turn } });
      f.event(turn, "tool.completed", { toolCallId: "reused-id", toolName: "lookup", summary: turn, evidence: {
        schemaVersion: 1, toolName: "lookup", result: { selected: turn, content: "text".repeat(4000) }, artifacts: [], diagnostics: [],
      } });
      f.end(turn);
      if (index >= 2) {
        const before = JSON.stringify(f.events);
        const summary = await f.compactor.compactIfNeeded("s", f.events);
        expect(summary?.summary.length).toBeLessThanOrEqual(2000);
        const parsed = JSON.parse(summary?.summary ?? "{}");
        expect(parsed.schemaVersion).toBe(2);
        expect(parsed.order).toBe("newest_first");
        expect(summary?.summary).toContain(`turn-${index - 1}`);
        expect(JSON.stringify(f.events)).toBe(before);
      }
    }
    expect(f.summaries.length).toBeGreaterThan(2);
  });

  it("associates reused tool IDs with the correct turn and exposes orphaned starts as unknown", () => {
    const f = fixture();
    f.begin("a");
    f.event("a", "tool.started", { toolCallId: "same", toolName: "write", displayText: "write", input: { target: "a" } });
    f.end("a");
    f.begin("b");
    f.event("b", "tool.started", { toolCallId: "same", toolName: "write", displayText: "write", input: { target: "b" } });
    f.event("b", "tool.completed", { toolCallId: "same", toolName: "write", summary: "completed b", evidence: {
      schemaVersion: 1, toolName: "write", result: {}, artifacts: [], diagnostics: [],
    } });
    f.end("b");
    expect(sessionEvidence(f.events)).toEqual(expect.arrayContaining([
      expect.objectContaining({ turnId: "a", status: "outcome_unknown", input: { target: "a" } }),
      expect.objectContaining({ turnId: "b", status: "completed", input: { target: "b" } }),
    ]));
  });

  it("refuses a compaction store or transcript from another session", async () => {
    const f = fixture();
    f.begin("a"); f.end("a");
    await expect(f.compactor.compactIfNeeded("other", f.events)).rejects.toMatchObject({ code: "AGENT_HISTORY_SCOPE_MISMATCH" });
  });
});
