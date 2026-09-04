import { describe, expect, it } from "vitest";
import { SystemPromptRegistry, promptSection } from "./prompt-registry.js";

const baseInput = {
  accountId: "account_test",
  scopeId: "scope_test",
  sessionId: "session_test",
  turnId: "turn_test",
  userMessage: "hello",
  step: 0,
  priorEvents: [],
  tools: [],
} as const;

describe("SystemPromptRegistry", () => {
  it("caches stable sections while rebuilding dynamic sections for each Agent step", async () => {
    let stableCalls = 0;
    let dynamicCalls = 0;
    const registry = new SystemPromptRegistry([
      promptSection("stable_probe", "stable", 100, () => {
        stableCalls += 1;
        return "stable";
      }),
      promptSection("dynamic_probe", "dynamic", 200, ({ step }) => {
        dynamicCalls += 1;
        return `step=${String(step)}`;
      }),
    ]);

    const first = await registry.assemble(baseInput);
    const second = await registry.assemble({ ...baseInput, step: 1 });

    expect(stableCalls).toBe(1);
    expect(dynamicCalls).toBe(2);
    expect(first.stableText).toBe(second.stableText);
    expect(first.dynamicText).toContain("step=0");
    expect(second.dynamicText).toContain("step=1");
  });

  it("invalidates the stable cache when a new section is registered", async () => {
    let calls = 0;
    const registry = new SystemPromptRegistry([
      promptSection("first", "stable", 100, () => {
        calls += 1;
        return "first";
      }),
    ]);
    await registry.assemble(baseInput);
    registry.register(promptSection("second", "stable", 110, () => "second"));
    const next = await registry.assemble(baseInput);

    expect(calls).toBe(2);
    expect(next.stableText).toContain("second");
  });
});
