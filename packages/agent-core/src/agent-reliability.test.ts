import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentEventType, PendingAgentEvent, SessionCompaction } from "@daoyin/harness-protocol";
import type { SessionCompactionStore, SessionEventStore } from "@daoyin/harness-contracts";
import { ToolRegistry, type ToolDefinition, type ToolSuccess } from "@daoyin/harness-tools/registry";
import { AgentEngine, type AgentEngineOptions, type AgentTurnInput } from "./agent-engine.js";
import type { ModelClient, ModelReply, ModelRequest } from "./model.js";

/** Replay-only fixtures: no provider, process or business writes. */
class MemoryEvents implements SessionEventStore {
  public readonly events: AgentEvent[] = [];
  public async append<T extends AgentEventType>(pending: PendingAgentEvent<T>): Promise<AgentEvent> {
    const event = { ...pending, id: `event-${this.events.length + 1}`, eventSeq: this.events.length + 1, occurredAt: new Date().toISOString() } as AgentEvent;
    this.events.push(event);
    return event;
  }
  public async read(sessionId: string, after = 0): Promise<AgentEvent[]> {
    return this.events.filter((event) => event.sessionId === sessionId && event.eventSeq > after);
  }
}
const input: AgentTurnInput = { accountId: "alice", scopeId: "resource-a", sessionId: "session-a", turnId: "turn-a", userMessage: "处理当前任务" };
const success = (name: string, result = 1): ToolSuccess => ({ ok: true, summary: "recorded outcome",
  evidence: { schemaVersion: 1, toolName: name, result: { value: result }, artifacts: [], diagnostics: [] } });
const calls = (id: string, name = "lookup", args: Record<string, unknown> = {}): ModelReply => ({ kind: "tool_calls", calls: [{ id, name, input: args }] });
function fixture(replies: unknown[] = [], options: Partial<AgentEngineOptions> = {}) {
  const events = new MemoryEvents();
  const execute = vi.fn<ToolDefinition["execute"]>(async () => success("lookup"));
  const write = vi.fn<ToolDefinition["execute"]>(async () => success("write"));
  const definitions: ToolDefinition[] = [
    { name: "lookup", description: "read fixture", mutating: false, category: "extension", inputSchema: { type: "object" }, execute },
    { name: "write", description: "write fixture", mutating: true, category: "extension", inputSchema: { type: "object" }, execute: write },
  ];
  const complete = vi.fn<ModelClient["complete"]>(async () => replies.shift() as ModelReply);
  const engine = new AgentEngine({ events, tools: new ToolRegistry(definitions), model: { complete }, ...options });
  return { engine, events, execute, write, complete };
}

const terminalCode = (events: MemoryEvents): string | undefined => {
  const last = events.events.at(-1);
  return last?.type === "turn.failed" ? last.payload.code : undefined;
};

describe("shared AgentEngine reliability (replay model and isolated memory events)", () => {
  it.each([null, { id: "broken", name: "write", input: [] }, { id: "first", name: "write", input: {} }])(
    "validates a whole tool batch before performing its valid first operation", async (invalid) => {
      const { engine, write, events } = fixture([{ kind: "tool_calls", calls: [{ id: "first", name: "write", input: {} }, invalid] }]);
      expect((await engine.runTurn(input)).status).toBe("failed");
      expect(write).not.toHaveBeenCalled();
      expect(events.events.map((event) => event.type)).toEqual(["turn.started", "assistant.delta", "turn.failed"]);
    },
  );

  it("rejects an oversized batch rather than partially consuming the remaining call budget", async () => {
    const { engine, write, events } = fixture([{ kind: "tool_calls", calls: [
      { id: "a", name: "write", input: {} }, { id: "b", name: "write", input: { value: 2 } },
    ] }], { maxToolCalls: 1 });
    await engine.runTurn(input);
    expect(write).not.toHaveBeenCalled();
    expect(terminalCode(events)).toBe("AGENT_TOOL_LIMIT");
  });

  it("does not perform the same write twice under reordered arguments and a different call ID", async () => {
    const { engine, write, complete, events } = fixture([
      calls("first", "write", { a: 1, b: 2 }), calls("second", "write", { b: 2, a: 1 }),
      { kind: "assistant", content: "已保留第一次操作结果，未重复提交。" },
    ]);
    expect((await engine.runTurn(input)).status).toBe("completed");
    expect(write).toHaveBeenCalledOnce();
    expect(complete.mock.calls[2]?.[0].messages.at(-1)?.content).toContain("TOOL_NO_PROGRESS");
    expect(events.events.filter((event) => event.type === "tool.completed")).toHaveLength(1);
  });

  it("does not repeat a write with an unknown result even when the tool error says retryable", async () => {
    const current = fixture([calls("a", "write"), calls("b", "write"), { kind: "assistant", content: "需要核对原操作结果。" }]);
    current.write.mockRejectedValue(Object.assign(new Error("response lost"), { retryable: true }));
    await current.engine.runTurn(input);
    expect(current.write).toHaveBeenCalledOnce();
  });

  it("allows polling when the observed state actually changes", async () => {
    const current = fixture([...Array.from({ length: 5 }, (_, index) => calls(`poll-${index}`)), { kind: "assistant", content: "状态持续变化。" }]);
    let state = 0;
    current.execute.mockImplementation(async () => success("lookup", ++state));
    expect((await current.engine.runTurn(input)).status).toBe("completed");
    expect(current.execute).toHaveBeenCalledTimes(5);
  });

  it("stops unchanged polling and performs one tool-free summary within the original step budget", async () => {
    const current = fixture();
    let sequence = 0;
    current.complete.mockImplementation(async (request) => request.tools.length ? calls(`poll-${++sequence}`) : { kind: "assistant", content: "状态没有变化，尚未完成。" });
    expect((await current.engine.runTurn(input)).status).toBe("failed");
    expect(current.execute).toHaveBeenCalledTimes(3);
    expect(current.complete).toHaveBeenCalledTimes(6);
    expect(current.complete.mock.calls.at(-1)?.[0].tools).toEqual([]);
    expect(terminalCode(current.events)).toBe("AGENT_NO_PROGRESS");
  });

  it("returns a cancelled terminal state without waiting for an uncooperative model or accepting its late tools", async () => {
    let finish: ((value: ModelReply) => void) | undefined;
    const pending = new Promise<ModelReply>((resolve) => { finish = resolve; });
    const current = fixture();
    current.complete.mockImplementation(async () => pending);
    const controller = new AbortController();
    const result = current.engine.runTurn({ ...input, signal: controller.signal });
    await vi.waitFor(() => expect(current.complete).toHaveBeenCalledOnce());
    controller.abort();
    expect((await result).status).toBe("cancelled");
    finish?.(calls("late-write", "write"));
    await Promise.resolve();
    expect(current.write).not.toHaveBeenCalled();
    expect(current.events.events.at(-1)?.type).toBe("turn.cancelled");
  });

  it("retains the completed first tool but stops the remainder of a cancelled batch", async () => {
    const controller = new AbortController();
    const current = fixture([{ kind: "tool_calls", calls: [
      { id: "first", name: "write", input: {} }, { id: "second", name: "lookup", input: {} },
    ] }]);
    current.write.mockImplementation(async () => { controller.abort(); return success("write"); });
    expect((await current.engine.runTurn({ ...input, signal: controller.signal })).status).toBe("cancelled");
    expect(current.execute).not.toHaveBeenCalled();
    expect(current.events.events.some((event) => event.type === "tool.completed" && event.payload.toolCallId === "first")).toBe(true);
  });

  it("times out a model without issuing a second potentially billable request", async () => {
    const current = fixture([], { modelTimeoutMs: 20 });
    current.complete.mockImplementation(async () => new Promise<ModelReply>(() => undefined));
    expect((await current.engine.runTurn(input)).status).toBe("failed");
    expect(current.complete).toHaveBeenCalledOnce();
    expect(terminalCode(current.events)).toBe("MODEL_TIMEOUT");
  });

  it("reuses a persisted terminal result and rejects changed content for its turn ID", async () => {
    const current = fixture([{ kind: "assistant", content: "完成。" }]);
    const first = await current.engine.runTurn(input);
    const count = current.events.events.length;
    expect(await current.engine.runTurn(input)).toEqual(first);
    expect(current.events.events).toHaveLength(count);
    expect(current.complete).toHaveBeenCalledOnce();
    await expect(current.engine.runTurn({ ...input, userMessage: "different" })).rejects.toMatchObject({ code: "AGENT_TURN_CONFLICT" });
  });

  it("does not re-execute interrupted work; a new turn sees its unknown outcome", async () => {
    const current = fixture([{ kind: "assistant", content: "先核对原操作。" }], { systemPrompt: "Custom cloud profile" });
    await current.events.append({ ...input, type: "turn.started", payload: { status: "running", userMessageId: "m", userMessage: input.userMessage } });
    await current.events.append({ ...input, type: "tool.started", payload: { toolCallId: "unknown-write", toolName: "write", displayText: "writing" } });
    await current.events.append({ ...input, type: "turn.interrupted", payload: { status: "interrupted", reason: "runtime_restart", lastCompletedEventSeq: 1 } });
    await expect(current.engine.runTurn(input)).rejects.toMatchObject({ code: "AGENT_TURN_REPLAY_BLOCKED" });
    await current.engine.runTurn({ ...input, turnId: "new-turn", userMessage: "继续处理" });
    const prompt = current.complete.mock.calls[0]?.[0].messages[0]?.content ?? "";
    expect(prompt).toContain("session_recovery");
    expect(prompt).toContain("outcome_unknown");
    expect(current.write).not.toHaveBeenCalled();
  });

  it("includes compacted context even with a custom cloud system prompt", async () => {
    const summary: SessionCompaction = { id: "cmp", sessionId: input.sessionId, sourceStartSeq: 1, sourceEndSeq: 3,
      summary: "Durable user preference: prefer portrait videos.", strategy: "fixture", createdAt: new Date().toISOString() };
    const compactionStore: SessionCompactionStore = { append: async () => summary, list: async () => [summary], latest: async () => summary };
    const current = fixture([{ kind: "assistant", content: "收到。" }], { systemPrompt: "Custom cloud profile", compactionStore });
    await current.events.append({ ...input, type: "turn.started", payload: { status: "running", userMessageId: "m", userMessage: input.userMessage } });
    await current.events.append({ ...input, type: "assistant.delta", payload: { contentBlockId: "b", delta: "Old answer" } });
    await current.events.append({ ...input, type: "turn.completed", payload: { status: "completed", assistantMessageId: "m2", outcomeSummary: "Old answer" } });
    await current.engine.runTurn({ ...input, turnId: "next", userMessage: "接着做" });
    const request: ModelRequest | undefined = current.complete.mock.calls[0]?.[0];
    expect(request?.systemPrompt.dynamicText).toContain(summary.summary);
    expect(request?.messages[0]?.content).toContain("session_compaction");
  });

  it("rejects cross-scope history before making a model call or appending new events", async () => {
    const current = fixture();
    await current.events.append({ ...input, accountId: "bob", type: "turn.started", payload: { status: "running", userMessageId: "m", userMessage: "private" } });
    await expect(current.engine.runTurn(input)).rejects.toMatchObject({ code: "AGENT_HISTORY_SCOPE_MISMATCH" });
    expect(current.complete).not.toHaveBeenCalled();
    expect(current.events.events).toHaveLength(1);
  });
});
