import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@daoyin/harness-protocol";
import type { SessionEventStore } from "@daoyin/harness-contracts";
import { ToolRegistry } from "@daoyin/harness-tools/registry";
import { AgentEngine } from "./agent-engine.js";
import { wireMessages } from "./model-wire.js";

function store() {
  const events: AgentEvent[] = [];
  const repository: SessionEventStore = {
    read: async () => [...events],
    append: async (pending) => {
      const event = { ...pending, id: `evt_${events.length + 1}`, eventSeq: events.length + 1, occurredAt: new Date().toISOString() } as AgentEvent;
      events.push(event); return event;
    },
  };
  return { events, repository };
}
const turn = { accountId: "local", scopeId: "workspace", sessionId: "session", turnId: "turn", userMessage: "测试文本流" };

describe("P0 shared core (real engine, in-memory events, mocked model)", () => {
  it("persists coalesced text before success, preserving the complete answer", async () => {
    const f = store(); const text = "x".repeat(4000);
    const engine = new AgentEngine({ tools: new ToolRegistry(), events: f.repository, model: {
      complete: async (request) => {
        for (const delta of text) await request.onTextDelta?.(delta);
        return { kind: "assistant", content: text };
      },
    } });
    expect((await engine.runTurn(turn)).status).toBe("completed");
    const deltas = f.events.filter((event) => event.type === "assistant.delta");
    expect(deltas.map((event) => event.payload.delta).join("")).toBe(text);
    expect(deltas.length).toBeLessThan(8);
    expect(f.events.at(-1)?.type).toBe("turn.completed");
    const count = f.events.length;
    expect((await engine.runTurn(turn)).status).toBe("completed");
    expect(f.events).toHaveLength(count);
  });
  it("discards unsaved text on cancellation and never lets late callbacks append", async () => {
    const f = store(); const controller = new AbortController();
    let late: ((text: string) => Promise<void>) | undefined;
    const engine = new AgentEngine({ tools: new ToolRegistry(), events: f.repository, model: {
      complete: async (request) => {
        late = request.onTextDelta;
        await request.onTextDelta?.("saved"); await request.onTextDelta?.("discarded");
        controller.abort("user");
        return { kind: "assistant", content: "saveddiscarded" };
      },
    } });
    expect((await engine.runTurn({ ...turn, signal: controller.signal })).status).toBe("cancelled");
    const count = f.events.length;
    await expect(late!("late")).rejects.toThrow();
    expect(f.events).toHaveLength(count);
    expect(JSON.stringify(f.events)).not.toContain("discarded");
    expect(f.events.at(-1)?.type).toBe("turn.cancelled");
  });
  it("removes only complete system mirrors from wire messages", () => {
    const prompt = { stableText: "stable", dynamicText: "dynamic", sections: [] };
    const messages = [
      { role: "system" as const, content: "stable\r\n\r\ndynamic" },
      { role: "system" as const, content: "stable extra instruction" },
      { role: "user" as const, content: "stable\n\ndynamic" },
      { role: "tool" as const, toolCallId: "call", toolName: "tool", content: "dynamic" },
    ];
    expect(wireMessages({ messages, systemPrompt: prompt })).toEqual(messages.slice(1));
    expect(wireMessages({ messages, systemPrompt: { ...prompt, stableText: "", dynamicText: "" } })).toEqual(messages);
  });
});
