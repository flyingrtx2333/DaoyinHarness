import { describe, expect, it } from "vitest";
import type { ToolDescriptor, ToolSuccess } from "@daoyin/harness-tools/registry";
import { canonicalJson, ToolProgressGuard, validateModelReply } from "./loop-policy.js";

const tool: ToolDescriptor = { name: "write", description: "fixture", inputSchema: { type: "object" }, category: "extension", mutating: true };
const call = { id: "call", name: "write", input: { alpha: 1, beta: 2 } };
const result = (value: number): ToolSuccess => ({ ok: true, summary: "fixture",
  evidence: { schemaVersion: 1, toolName: "write", result: { value }, artifacts: [], diagnostics: [] } });

describe("loop policy (pure validation, no external actions)", () => {
  it("normalizes object ordering without reordering arrays", () => {
    expect(canonicalJson({ b: 2, a: [1, 2] })).toBe(canonicalJson({ a: [1, 2], b: 2 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it.each([undefined, NaN, Infinity, new Date(), { key: undefined }, new Array(2)])("rejects non-JSON inputs", (input) => {
    expect(() => canonicalJson(input)).toThrow();
  });

  it("rejects cyclic and overlong input before dispatch", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => canonicalJson(circular)).toThrow();
    expect(() => validateModelReply({ kind: "tool_calls", calls: [{ ...call, input: { body: "x".repeat(32001) } }] }, new Set())).toThrow();
    expect(() => validateModelReply({ kind: "tool_calls", calls: [call] }, new Set([call.id]))).toThrow();
  });

  it("detaches valid model arguments from provider-owned mutable objects", () => {
    const input = { child: { count: 1 } };
    const parsed = validateModelReply({ kind: "tool_calls", calls: [{ ...call, input }] }, new Set());
    input.child.count = 100;
    expect(parsed.kind === "tool_calls" ? parsed.calls[0]?.input : null).toEqual({ child: { count: 1 } });
  });

  it("allows explicitly repeatable writes but still stops unchanged outcomes", () => {
    const guard = new ToolProgressGuard(2);
    const repeatable = { ...tool, repeatable: true };
    for (let index = 0; index < 2; index += 1) {
      expect(guard.before(call, repeatable)).toBeUndefined();
      guard.started(call, repeatable);
      guard.observe(call, result(1));
    }
    expect(guard.before(call, repeatable)?.code).toBe("TOOL_NO_PROGRESS");
  });

  it("does not treat a new call ID or summary wording as new read progress", () => {
    const guard = new ToolProgressGuard(2);
    const read = { ...tool, mutating: false };
    guard.observe(call, result(1));
    guard.observe({ ...call, id: "different" }, { ...result(1), summary: "different prose" });
    expect(guard.before({ ...call, id: "third", input: { beta: 2, alpha: 1 } }, read)?.code).toBe("TOOL_NO_PROGRESS");
  });

  it("resets stale read observations when an intervening write changes state", () => {
    const guard = new ToolProgressGuard(2);
    const read = { ...tool, mutating: false };
    guard.observe(call, result(1));
    guard.observe(call, result(1));
    expect(guard.before(call, read)).toBeDefined();
    guard.started({ ...call, name: "update", input: { id: 2 } }, tool);
    expect(guard.before(call, read)).toBeUndefined();
  });
});
