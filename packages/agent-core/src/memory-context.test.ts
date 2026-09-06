import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentEventType, PendingAgentEvent, SessionCompaction } from "@daoyin/harness-protocol";
import type { SessionEventStore } from "@daoyin/harness-contracts";
import { ToolRegistry, type ToolDefinition } from "@daoyin/harness-tools/registry";
import { AgentEngine, type AgentEngineOptions } from "./agent-engine.js";
import type { AgentMemoryProvider, MemoryContextSnapshot } from "./memory-context.js";
import type { ModelClient } from "./model.js";

// Pure replay fixtures: no network, production stores, provider keys or model charges.
class Events implements SessionEventStore {
  public readonly rows: AgentEvent[] = [];
  public async append<T extends AgentEventType>(event: PendingAgentEvent<T>): Promise<AgentEvent> {
    const row = { ...event, id: `event-${this.rows.length}`, eventSeq: this.rows.length + 1, occurredAt: new Date().toISOString() } as AgentEvent;
    this.rows.push(row); return row;
  }
  public async read(): Promise<AgentEvent[]> { return [...this.rows]; }
}
const input = { accountId: "alice", scopeId: "space", sessionId: "session", turnId: "turn", userMessage: "视频风格" };
const changed = () => Object.assign(new Error("not surfaced raw"), { code: "MEMORY_CONTEXT_CHANGED" });
function fixture(memory: AgentMemoryProvider, options: Partial<AgentEngineOptions> = {}) {
  const events = new Events();
  const complete = vi.fn<ModelClient["complete"]>(async () => ({ kind: "assistant", content: "已完成。" }));
  const execute = vi.fn<ToolDefinition["execute"]>(async () => ({ ok: true, summary: "read", evidence: {
    schemaVersion: 1, toolName: "lookup", result: {}, artifacts: [], diagnostics: [],
  } }));
  const tools = new ToolRegistry([{ name: "lookup", description: "read", category: "extension", mutating: false,
    inputSchema: { type: "object" }, execute }]);
  const engine = new AgentEngine({ model: { complete }, tools, events, memory, ...options });
  return { engine, complete, execute, events };
}
const snapshot = (text = "CONFIRMED_MEMORY: 采用竖屏视频"): MemoryContextSnapshot => ({ text, excludedTurns: [], assertCurrent: async () => undefined });

describe("memory injection and withdrawal in shared AgentEngine", () => {
  it("loads scoped memory each step without requiring a second model agent or copying prompt text into events", async () => {
    const load = vi.fn<AgentMemoryProvider["load"]>(async () => snapshot());
    const f = fixture({ load }); let count = 0;
    f.complete.mockImplementation(async (request) => {
      expect(request.systemPrompt.dynamicText).toContain("采用竖屏视频");
      return count++ === 0 ? { kind: "tool_calls", calls: [{ id: "call", name: "lookup", input: {} }] } : { kind: "assistant", content: "完成。" };
    });
    expect((await f.engine.runTurn(input)).status).toBe("completed");
    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls.map(([request]) => request.step)).toEqual([0, 1]);
    expect(f.execute).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.events.rows)).not.toContain("采用竖屏视频");
  });

  it("discards a model reply and its tool requests when memory is withdrawn during the model call", async () => {
    let valid = true;
    const memory = { load: async () => ({ ...snapshot(), assertCurrent: async () => { if (!valid) throw changed(); } }) };
    const f = fixture(memory);
    f.complete.mockImplementation(async () => {
      valid = false;
      return { kind: "tool_calls", content: "private memory-derived text", calls: [{ id: "call", name: "lookup", input: {} }] };
    });
    expect((await f.engine.runTurn(input)).status).toBe("failed");
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.complete).toHaveBeenCalledOnce();
    expect(f.events.rows.at(-1)).toMatchObject({ type: "turn.failed", payload: { code: "AGENT_MEMORY_CHANGED" } });
    expect(JSON.stringify(f.events.rows)).not.toContain("private memory-derived text");
  });

  it("stops between tools if the first operation invalidates memory consent", async () => {
    let valid = true;
    const f = fixture({ load: async () => ({ ...snapshot(), assertCurrent: async () => { if (!valid) throw changed(); } }) });
    f.complete.mockResolvedValue({ kind: "tool_calls", calls: [
      { id: "first", name: "lookup", input: { value: 1 } }, { id: "second", name: "lookup", input: { value: 2 } },
    ] });
    f.execute.mockImplementation(async () => { valid = false; return { ok: true, summary: "first completed", evidence: {
      schemaVersion: 1, toolName: "lookup", result: {}, artifacts: [], diagnostics: [],
    } }; });
    expect((await f.engine.runTurn(input)).status).toBe("failed");
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.events.rows.some((row) => row.type === "tool.completed")).toBe(true);
  });

  it("fails closed if the memory source is unavailable rather than silently using an old snapshot", async () => {
    const f = fixture({ load: async () => { throw new Error("private database diagnostics"); } });
    expect((await f.engine.runTurn(input)).status).toBe("failed");
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.events.rows.at(-1)).toMatchObject({ payload: { code: "AGENT_MEMORY_UNAVAILABLE" } });
    expect(JSON.stringify(f.events.rows)).not.toContain("private database diagnostics");
  });

  it("excludes influenced old turns and does not reuse unversioned compaction text, without rewriting history", async () => {
    const oldSummary: SessionCompaction = { id: "cmp", sessionId: input.sessionId, sourceStartSeq: 1, sourceEndSeq: 2,
      summary: "WITHDRAWN_BODY", strategy: "legacy", createdAt: new Date().toISOString() };
    const latest = vi.fn(async () => oldSummary);
    const f = fixture({ load: async () => ({ ...snapshot(""), excludedTurns: [{ sessionId: input.sessionId, turnId: "old" }] }) }, {
      compactionStore: { latest, list: async () => [oldSummary], append: async () => oldSummary },
    });
    await f.events.append({ ...input, turnId: "old", type: "turn.started", payload: { status: "running", userMessageId: "u", userMessage: "WITHDRAWN_USER_SOURCE" } });
    await f.events.append({ ...input, turnId: "old", type: "turn.completed", payload: { status: "completed", assistantMessageId: "a", outcomeSummary: "WITHDRAWN_BODY" } });
    const before = JSON.stringify(f.events.rows);
    await f.engine.runTurn(input);
    expect(JSON.stringify(f.complete.mock.calls)).not.toContain("WITHDRAWN");
    expect(latest).not.toHaveBeenCalled();
    expect(JSON.stringify(f.events.rows.slice(0, 2))).toBe(before);
  });
});
