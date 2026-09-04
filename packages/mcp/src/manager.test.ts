import { describe, expect, it, vi } from "vitest";
import {
  McpManager,
  namespacedMcpToolName,
  resolveMcpEnvironmentConfig,
  type McpClientAdapter,
  type McpClientFactory,
  type McpListedTool,
} from "./manager.js";

function adapter(options: {
  connect?: () => Promise<void>;
  tools?: McpListedTool[];
  callResult?: unknown;
  serverInfo?: { name?: string; version?: string };
} = {}): McpClientAdapter {
  return {
    connect: vi.fn(async () => options.connect?.()),
    listTools: vi.fn(async () => options.tools ?? []),
    callTool: vi.fn(async () => options.callResult ?? { content: [{ type: "text", text: "ok" }] }),
    serverInfo: () => options.serverInfo,
    close: vi.fn(async () => undefined),
  };
}

describe("MCP configuration", () => {
  it("resolves Bearer tokens only from the named process environment variable", () => {
    expect(resolveMcpEnvironmentConfig(
      { id: "search", url: "https://mcp.example.test/mcp", bearerEnv: "SEARCH_MCP_BEARER" },
      { SEARCH_MCP_BEARER: "bearer_from_environment" },
    )).toMatchObject({
      id: "search",
      url: "https://mcp.example.test/mcp",
      bearerToken: "bearer_from_environment",
    });

    expect(() => resolveMcpEnvironmentConfig(
      { id: "search", url: "https://mcp.example.test/mcp", bearerEnv: "SEARCH_MCP_BEARER" },
      {},
    )).toThrowError(/not set/u);
  });

  it("allows HTTPS remote and explicit loopback HTTP endpoints but rejects unsafe endpoint forms", () => {
    expect(resolveMcpEnvironmentConfig({ id: "remote", url: "https://mcp.example.test/mcp" }, {})).toMatchObject({ id: "remote" });
    expect(resolveMcpEnvironmentConfig({ id: "local", url: "http://127.0.0.1:3456/mcp" }, {})).toMatchObject({ id: "local" });
    expect(() => resolveMcpEnvironmentConfig({ id: "bad", url: "http://mcp.example.test/mcp" }, {})).toThrowError(/HTTPS/u);
    expect(() => resolveMcpEnvironmentConfig({ id: "bad", url: "https://user:pass@mcp.example.test/mcp" }, {})).toThrowError(/credentials/u);
    expect(() => resolveMcpEnvironmentConfig({ id: "bad", url: "https://mcp.example.test/mcp?secret=value" }, {})).toThrowError(/query/u);
  });

  it("creates stable collision-resistant Harness tool names", () => {
    const first = namespacedMcpToolName("server-a", "search/web");
    expect(first).toMatch(/^mcp_server-a_search_web_[a-f0-9]{12}$/u);
    expect(namespacedMcpToolName("server-a", "search/web")).toBe(first);
    expect(namespacedMcpToolName("server-b", "search/web")).not.toBe(first);
  });
});

describe("McpManager", () => {
  it("isolates failed servers while mounting tools from connected servers", async () => {
    const good = adapter({
      tools: [
        {
          name: "lookup",
          description: "Look up a record.",
          inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
          annotations: { readOnlyHint: true },
        },
        {
          name: "update_record",
          description: "Update a record.",
          inputSchema: { type: "object" },
        },
      ],
      serverInfo: { name: "Good MCP", version: "2.1.0" },
      callResult: {
        content: [
          { type: "text", text: "lookup complete" },
          { type: "image", mimeType: "image/png", data: "abcdef" },
        ],
        structuredContent: { value: 42 },
      },
    });
    const bad = adapter({ connect: async () => { throw Object.assign(new Error("offline"), { code: "ECONNREFUSED" }); } });
    const factory: McpClientFactory = (config) => config.id === "good" ? good : bad;
    const manager = await McpManager.connect([
      { id: "good", url: "https://good.example.test/mcp" },
      { id: "bad", url: "https://bad.example.test/mcp" },
    ], { clientVersion: "0.1.0-test", clientFactory: factory });

    expect(manager.configuredCount).toBe(2);
    expect(manager.connectedCount).toBe(1);
    expect(manager.statuses()).toEqual([
      expect.objectContaining({ id: "good", status: "connected", serverName: "Good MCP", serverVersion: "2.1.0", toolCount: 2 }),
      expect.objectContaining({ id: "bad", status: "failed", errorCode: "ECONNREFUSED", toolCount: 0 }),
    ]);

    const tools = manager.tools();
    expect(tools).toHaveLength(2);
    expect(tools.find((tool) => tool.externalName === "lookup")).toMatchObject({ mutating: false, serverId: "good" });
    expect(tools.find((tool) => tool.externalName === "update_record")).toMatchObject({ mutating: true, serverId: "good" });

    const lookup = tools.find((tool) => tool.externalName === "lookup");
    expect(lookup).toBeDefined();
    const execution = await manager.call(lookup?.harnessName ?? "", { id: "record_1" }, new AbortController().signal);
    expect(execution.summary).toBe("lookup complete");
    expect(execution.result).toMatchObject({
      content: [
        { type: "text", text: "lookup complete" },
        { type: "image", mimeType: "image/png", dataOmitted: true, encodedCharacters: 6 },
      ],
      structuredContent: { value: 42 },
    });

    await manager.close();
    expect(good.close).toHaveBeenCalledTimes(1);
  });

  it("turns MCP isError results into stable tool failures with bounded details", async () => {
    const client = adapter({
      tools: [{ name: "fail", inputSchema: { type: "object" } }],
      callResult: { isError: true, content: [{ type: "text", text: "remote rejected request" }] },
    });
    const manager = await McpManager.connect(
      [{ id: "demo", url: "https://demo.example.test/mcp" }],
      { clientVersion: "0.1.0-test", clientFactory: () => client },
    );
    const tool = manager.tools()[0];

    await expect(manager.call(tool?.harnessName ?? "", {}, new AbortController().signal)).rejects.toMatchObject({
      code: "MCP_TOOL_ERROR",
      message: "remote rejected request",
      retryable: false,
    });
    await manager.close();
  });

  it("bounds tool catalogs, oversized input schemas, and aggregate result evidence", async () => {
    const oversizedProperties = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [
      `field_${String(index)}`,
      { type: "string", description: "schema-description-".repeat(700) },
    ]));
    const tools: McpListedTool[] = Array.from({ length: 140 }, (_, index) => ({
      name: `tool_${String(index)}`,
      inputSchema: index === 0
        ? { type: "object", properties: oversizedProperties }
        : { type: "object" },
    }));
    const client = adapter({
      tools,
      callResult: {
        content: Array.from({ length: 20 }, (_, index) => ({
          type: "text",
          text: `block-${String(index)}:` + "x".repeat(60_000),
        })),
      },
    });
    const manager = await McpManager.connect(
      [{ id: "bounded", url: "https://bounded.example.test/mcp" }],
      { clientVersion: "0.1.0-test", clientFactory: () => client },
    );

    expect(manager.statuses()[0]).toMatchObject({ status: "connected", toolCount: 128 });
    expect(manager.tools()).toHaveLength(128);
    const first = manager.tools().find((tool) => tool.externalName === "tool_0");
    expect(first?.inputSchema).toEqual({
      type: "object",
      additionalProperties: true,
      description: "Original MCP input schema exceeded the Harness context limit and was omitted.",
    });

    const execution = await manager.call(first?.harnessName ?? "", {}, new AbortController().signal);
    expect(execution.result).toMatchObject({ truncated: true });
    const preview = (execution.result as { preview?: unknown }).preview;
    expect(typeof preview).toBe("string");
    expect((preview as string).length).toBeLessThanOrEqual(80_000);
    await manager.close();
  });
});
