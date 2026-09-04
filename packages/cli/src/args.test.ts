import { describe, expect, it } from "vitest";
import { CliError, parseArgs } from "./args.js";

describe("CLI arguments", () => {
  it("keeps safe startup defaults", () => {
    expect(parseArgs([], "C:/data", "C:/workspace")).toEqual({
      openBrowser: true,
      dataDir: "C:/data",
      workspaceRoot: expect.stringMatching(/workspace$/u),
      sandboxMode: "auto",
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

  it("rejects invalid explicit startup values", () => {
    expect(() => parseArgs(["--port", "0"], "C:/data")).toThrowError(CliError);
    expect(() => parseArgs(["--sandbox", "maybe"], "C:/data")).toThrowError(CliError);
  });
});
