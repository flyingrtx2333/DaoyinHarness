import { describe, expect, it } from "vitest";
import type { ModelConversationItem } from "./model.js";
import { boundModelContext, type ModelContextBudget } from "./context-budget.js";
import { ContextAssembler } from "./context-assembler.js";
import { SystemPromptRegistry } from "./prompt-registry.js";
import type { AgentEvent } from "@daoyin/harness-protocol";

const base: ModelContextBudget = { systemMessage: { role: "system", content: "runtime policy" }, history: [],
  current: [{ role: "user", content: "CURRENT_GOAL_MUST_SURVIVE" }], overheadCharacters: 200, maxCharacters: 8000, maxMessages: 12 };
function group(index: number, characters = 3000): ModelConversationItem[] {
  const id = `call-${index}`;
  return [
    { role: "assistant_tool_calls", content: "", calls: [{ id, name: "lookup", input: { index } }] },
    { role: "tool", toolCallId: id, toolName: "lookup", content: JSON.stringify({ ok: true, summary: `observed-${index}`, result: "x".repeat(characters) }) },
  ];
}
function assertPairs(messages: readonly ModelConversationItem[]): void {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant_tool_calls") for (const call of message.calls) pending.add(call.id);
    else if (message.role === "tool") expect(pending.delete(message.toolCallId)).toBe(true);
    else expect(pending.size).toBe(0);
  }
  expect(pending.size).toBe(0);
}

describe("model context budgeting (pure projections; no model calls)", () => {
  it("retains the current goal and latest whole batch within both limits", () => {
    const current = [...base.current, ...Array.from({ length: 15 }, (_, index) => group(index)).flat()];
    const history: ModelConversationItem[] = Array.from({ length: 30 }, (_, index) => [
      { role: "user" as const, content: `history-${index}` }, { role: "assistant" as const, content: "answer".repeat(100) },
    ]).flat();
    const before = JSON.stringify({ current, history });
    const messages = boundModelContext({ ...base, current, history });
    expect(messages.length).toBeLessThanOrEqual(base.maxMessages);
    expect(JSON.stringify(messages).length + base.overheadCharacters).toBeLessThanOrEqual(base.maxCharacters);
    expect(messages).toContainEqual(base.current[0]);
    expect(messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "call-14" });
    expect(messages.some((message) => message.content.includes("omittedToolBatches"))).toBe(true);
    assertPairs(messages);
    expect(JSON.stringify({ current, history })).toBe(before);
  });

  it("shrinks one oversized result without cutting JSON or removing its request", () => {
    const messages = boundModelContext({ ...base, current: [...base.current, ...group(1, 70_000)] });
    const last = messages.at(-1);
    expect(last).toMatchObject({ role: "tool", toolCallId: "call-1" });
    expect(() => JSON.parse(last?.content ?? "")).not.toThrow();
    expect(last?.content).toContain("truncated");
    expect(JSON.stringify(messages).length + base.overheadCharacters).toBeLessThanOrEqual(base.maxCharacters);
    assertPairs(messages);
  });

  it("never silently truncates the current user goal or executable arguments", () => {
    expect(() => boundModelContext({ ...base, current: [{ role: "user", content: "x".repeat(9000) }] }))
      .toThrow(expect.objectContaining({ code: "AGENT_CONTEXT_LIMIT" }));
    expect(() => boundModelContext({ ...base, current: [base.current[0]!,
      { role: "assistant_tool_calls", content: "", calls: [{ id: "large", name: "write", input: { content: "x".repeat(9000) } }] },
      { role: "tool", toolCallId: "large", toolName: "write", content: "{}" },
    ] })).toThrow(expect.objectContaining({ code: "AGENT_CONTEXT_LIMIT" }));
  });

  it("rejects orphaned or mismatched tool results", () => {
    expect(() => boundModelContext({ ...base, current: [...base.current, group(1)[0]!] })).toThrow();
    expect(() => boundModelContext({ ...base, current: [...base.current, group(1)[0]!, group(2)[1]!] })).toThrow();
  });

  it("bounds even a single enormous historical turn", () => {
    const events: AgentEvent[] = [
      { id: "e1", eventSeq: 1, type: "turn.started", accountId: "a", scopeId: "s", sessionId: "session", turnId: "t", occurredAt: "2026-09-06", payload: { status: "running", userMessageId: "m", userMessage: "u".repeat(3000) } },
      { id: "e2", eventSeq: 2, type: "assistant.delta", accountId: "a", scopeId: "s", sessionId: "session", turnId: "t", occurredAt: "2026-09-06", payload: { contentBlockId: "b", delta: "a".repeat(5000) } },
    ];
    const context = new ContextAssembler({ promptRegistry: new SystemPromptRegistry(), historyMaxCharacters: 1024 });
    const history = context.historicalDialogue(events);
    expect(history.reduce((sum, item) => sum + item.content.length, 0)).toBeLessThanOrEqual(1024);
    expect(history.map((item) => item.role)).toEqual(["user", "assistant"]);
    expect(history.some((item) => item.content.includes("truncated"))).toBe(true);
  });
});
