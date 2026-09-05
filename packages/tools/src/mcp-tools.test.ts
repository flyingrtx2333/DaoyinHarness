import { describe, expect, it, vi } from "vitest";
import type { McpManager } from "@daoyin/harness-mcp";
import { createMcpTools } from "./mcp-tools.js";
import { ToolRegistry } from "./registry.js";

describe("MCP tool adapter", () => {
  it("mounts namespaced extension tools and redacts argument values from audit input", async () => {
    const call = vi.fn(async () => ({ summary: "remote complete", result: { answer: 42 } }));
    const manager = {
      tools: () => [{
        harnessName: "mcp_demo_lookup_abcd1234",
        serverId: "demo",
        externalName: "lookup",
        description: "MCP server demo: lookup.",
        inputSchema: { type: "object", properties: { secret: { type: "string" } } },
        mutating: false,
      }],
      call,
    } as unknown as McpManager;
    const registry = new ToolRegistry(createMcpTools(manager));

    expect(registry.descriptors()).toEqual([
      expect.objectContaining({
        name: "mcp_demo_lookup_abcd1234",
        category: "extension",
        mutating: false,
      }),
    ]);
    expect(registry.auditInput("mcp_demo_lookup_abcd1234", { secret: "should not persist", id: "record_1" })).toEqual({
      redacted: true,
      keys: ["secret", "id"],
      keyCount: 2,
    });

    const result = await registry.execute(
      { id: "call_1", name: "mcp_demo_lookup_abcd1234", input: { secret: "should reach MCP only" } },
      new AbortController().signal,
      { accountId: "test-account", scopeId: "test-scope", sessionId: "test-session", turnId: "test-turn", sourceEventIds: [] },
    );

    expect(result).toMatchObject({
      ok: true,
      summary: "remote complete",
      evidence: {
        result: { answer: 42 },
        diagnostics: ["MCP_SOURCE: server=demo; externalTool=lookup"],
      },
    });
    expect(call).toHaveBeenCalledWith("mcp_demo_lookup_abcd1234", { secret: "should reach MCP only" }, expect.any(AbortSignal));
  });
});
