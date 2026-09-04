import type { McpManager } from "@daoyin/harness-mcp";
import type { JsonValue } from "@daoyin/harness-protocol";
import type { ToolDefinition, ToolSuccess } from "./registry.js";

function toJsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 16) return "[depth-limit]";
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.slice(0, 300).map((entry) => toJsonValue(entry, depth + 1));
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value).slice(0, 300)) result[key] = toJsonValue(entry, depth + 1);
    return result;
  }
  return String(value);
}

function schemaValue(value: unknown): JsonValue {
  const converted = toJsonValue(value);
  if (typeof converted === "object" && converted !== null && !Array.isArray(converted)) return converted;
  return { type: "object", additionalProperties: true };
}

function auditShape(input: Record<string, unknown>): JsonValue {
  return {
    redacted: true,
    keys: Object.keys(input).slice(0, 100),
    keyCount: Object.keys(input).length,
  };
}

export function createMcpTools(manager: McpManager): ToolDefinition[] {
  return manager.tools().map((tool) => ({
    name: tool.harnessName,
    description: tool.description,
    category: "extension",
    mutating: tool.mutating,
    inputSchema: schemaValue(tool.inputSchema),
    auditInput: auditShape,
    async execute(input, signal): Promise<ToolSuccess> {
      const result = await manager.call(tool.harnessName, input, signal);
      return {
        ok: true,
        summary: result.summary,
        evidence: {
          schemaVersion: 1,
          toolName: tool.harnessName,
          result: toJsonValue(result.result),
          artifacts: [],
          diagnostics: [`MCP_SOURCE: server=${tool.serverId}; externalTool=${tool.externalName}`],
        },
      };
    },
  }));
}
