import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Workspace } from "@daoyin/harness-workspace";
import { ToolRegistry } from "./registry.js";
import { createWorkspaceTools } from "./workspace-tools.js";

const temporaryDirectories: string[] = [];
const testContext = { accountId: "test-account", scopeId: "test-scope", sessionId: "test-session", turnId: "test-turn", sourceEventIds: [] };

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "daoyin-harness-tools-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("workspace tools", () => {
  it("reads, writes and patches files through the confined workspace service", async () => {
    const root = await temporaryDirectory();
    await writeFile(path.join(root, "notes.txt"), "alpha\n", "utf8");
    const workspace = await Workspace.open(root);
    const registry = new ToolRegistry(createWorkspaceTools(workspace));

    const read = await registry.execute({ id: "call_read", name: "read_file", input: { path: "notes.txt" } }, new AbortController().signal, testContext);
    expect(read).toMatchObject({ ok: true, evidence: { result: { content: "alpha\n" } } });

    const write = await registry.execute({ id: "call_write", name: "write_file", input: { path: "created.txt", content: "hello\n" } }, new AbortController().signal, testContext);
    expect(write).toMatchObject({ ok: true });
    await expect(readFile(path.join(root, "created.txt"), "utf8")).resolves.toBe("hello\n");

    const patch = await registry.execute({ id: "call_patch", name: "apply_patch", input: { path: "created.txt", expected: "hello", replacement: "updated" } }, new AbortController().signal, testContext);
    expect(patch).toMatchObject({ ok: true });
    await expect(readFile(path.join(root, "created.txt"), "utf8")).resolves.toBe("updated\n");
  });

  it("does not expose process execution from the workspace pack", async () => {
    const root = await temporaryDirectory();
    const workspace = await Workspace.open(root);
    const registry = new ToolRegistry(createWorkspaceTools(workspace));

    const result = await registry.execute({ id: "call_process", name: "run_package_script", input: { script: "test" } }, new AbortController().signal, testContext);
    expect(result).toMatchObject({ ok: false, code: "TOOL_NOT_FOUND" });
  });

  it("returns a stable failure for unknown tools", async () => {
    const registry = new ToolRegistry();
    const result = await registry.execute({ id: "call_unknown", name: "unknown", input: {} }, new AbortController().signal, testContext);
    expect(result).toMatchObject({ ok: false, code: "TOOL_NOT_FOUND" });
  });
});
