import { describe, expect, it } from "vitest";
import type { JsonValue } from "@daoyin/harness-protocol";
import type { ToolSuccess } from "@daoyin/harness-tools";
import { MAX_MODEL_TOOL_RESULT_CHARACTERS, modelToolResult } from "./model-tool-result.js";

function success(result: JsonValue): ToolSuccess {
  return { ok: true, summary: "Read local evidence.", evidence: { schemaVersion: 1, toolName: "read_file", result, artifacts: [], diagnostics: [] } };
}

describe("derived model tool results", () => {
  it("leaves small results and exact-budget results unchanged", () => {
    const result = success({ files: ["README.md"] });
    expect(modelToolResult(result)).toBe(JSON.stringify({ ok: true, summary: result.summary, result: result.evidence.result }));
    const empty = success("");
    const overhead = modelToolResult(empty).length;
    const exact = success("x".repeat(MAX_MODEL_TOOL_RESULT_CHARACTERS - overhead));
    expect(modelToolResult(exact)).toHaveLength(MAX_MODEL_TOOL_RESULT_CHARACTERS);
    expect(JSON.parse(modelToolResult(exact))).not.toHaveProperty("modelContext");
  });

  it("keeps complete file paths in a valid JSON prefix and does not mutate evidence", () => {
    const files = Array.from({ length: 2000 }, (_, index) => `docs/${String(index).padStart(4, "0")}/${"directory-".repeat(7)}file.md`);
    const result = success({ files });
    const before = JSON.stringify(result);
    const output = modelToolResult(result);
    const preview = JSON.parse(output) as { result: { files: string[] }; modelContext: { truncated: boolean; originalCharacters: number } };
    expect(output.length).toBeLessThanOrEqual(MAX_MODEL_TOOL_RESULT_CHARACTERS);
    expect(preview.result.files.length).toBeGreaterThan(0);
    expect(preview.result.files).toEqual(files.slice(0, preview.result.files.length));
    expect(preview.result.files.length).toBeLessThan(files.length);
    expect(preview.modelContext).toMatchObject({ truncated: true });
    expect(preview.modelContext.originalCharacters).toBeGreaterThan(100_000);
    expect(JSON.stringify(result)).toBe(before);
  });

  it("budgets escaped text and astral Unicode by serialized size without broken characters", () => {
    const result = success({ path: "notes.md", content: ('🚀中文\n"\\\u0000').repeat(20_000) });
    const output = modelToolResult(result);
    const preview = JSON.parse(output) as { result: { path: string; content: string } };
    expect(output.length).toBeLessThanOrEqual(MAX_MODEL_TOOL_RESULT_CHARACTERS);
    expect(preview.result.path).toBe("notes.md");
    expect(preview.result.content.endsWith("…[truncated]")).toBe(true);
    expect(preview.result.content).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  });

  it("keeps failure identity and retry policy when error details are oversized", () => {
    const output = modelToolResult({ ok: false, code: "PROCESS_PERMISSION_REQUIRED", message: "Permission needed.", retryable: false, details: { requestId: "permission_1", reason: "x".repeat(150_000) } });
    expect(output.length).toBeLessThanOrEqual(MAX_MODEL_TOOL_RESULT_CHARACTERS);
    expect(JSON.parse(output)).toMatchObject({ ok: false, code: "PROCESS_PERMISSION_REQUIRED", message: "Permission needed.", retryable: false, modelContext: { truncated: true }, details: { requestId: "permission_1" } });
  });

  it("bounds oversized summaries, keys, nested arrays and permission messages", () => {
    const cases = [
      { ...success({ files: ["x".repeat(200_000)] }), summary: "x".repeat(150_000) },
      success({ ["long-key".repeat(20_000)]: "value" }),
      success({ rows: [["x".repeat(150_000)]] }),
      { ok: false as const, code: "failure".repeat(20_000), message: "x".repeat(150_000), retryable: true },
    ];
    for (const result of cases) {
      const output = modelToolResult(result);
      expect(output.length).toBeLessThanOrEqual(MAX_MODEL_TOOL_RESULT_CHARACTERS);
      expect(JSON.parse(output)).toHaveProperty("modelContext.truncated", true);
    }
  });
});
