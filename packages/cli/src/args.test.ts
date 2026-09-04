import { describe, expect, it } from "vitest";
import { CliError, parseArgs } from "./args.js";

describe("CLI arguments", () => {
  it("keeps safe startup defaults", () => {
    expect(parseArgs([], "C:/data", "C:/workspace")).toEqual({
      openBrowser: true,
      dataDir: "C:/data",
      workspaceRoot: expect.stringMatching(/workspace$/u),
      sandboxMode: "auto",
      mcpServers: [],
      logLevel: "info",
      help: false,
      version: false,
    });
  });

  it("parses the documented P1 flags", () => {
    const result = parseArgs(
      ["--port", "4680", "--no-open", "--data-dir", "./runtime-data", "--workspace", "./demo-project", "--sandbox", "required", "--log-level", "debug"],
      "C:/default",
      "C:/workspace",
    );

    expect(result.port).toBe(4680);
    expect(result.openBrowser).toBe(false);
    expect(result.sandboxMode).toBe("required");
    expect(result.logLevel).toBe("debug");
    expect(result.dataDir).toMatch(/runtime-data$/u);
    expect(result.workspaceRoot).toMatch(/demo-project$/u);
  });

  it("parses explicit remote MCP servers and environment-backed Bearer tokens", () => {
    const result = parseArgs([
      "--mcp", "search=https://mcp.example.test/mcp",
      "--mcp", "local=http://127.0.0.1:3456/mcp",
      "--mcp-bearer-env", "search=DAOYIN_SEARCH_MCP_BEARER",
    ], "C:/data", "C:/workspace");

    expect(result.mcpServers).toEqual([
      { id: "search", url: "https://mcp.example.test/mcp", bearerEnv: "DAOYIN_SEARCH_MCP_BEARER" },
      { id: "local", url: "http://127.0.0.1:3456/mcp" },
    ]);
  });

  it("rejects duplicate or orphan MCP startup configuration", () => {
    expect(() => parseArgs(["--mcp", "demo=https://example.test/mcp", "--mcp", "demo=https://other.test/mcp"], "C:/data")).toThrowError(CliError);
    expect(() => parseArgs(["--mcp-bearer-env", "missing=SOME_ENV"], "C:/data")).toThrowError(CliError);
    expect(() => parseArgs(["--mcp", "bad id=https://example.test/mcp"], "C:/data")).toThrowError(CliError);
  });

  it("rejects invalid explicit startup values", () => {
    expect(() => parseArgs(["--port", "0"], "C:/data")).toThrowError(CliError);
    expect(() => parseArgs(["--sandbox", "maybe"], "C:/data")).toThrowError(CliError);
  });
});
