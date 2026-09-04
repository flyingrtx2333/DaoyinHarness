import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlProcessPermissionStore, ProcessService } from "@daoyin/harness-process";
import { Workspace } from "@daoyin/harness-workspace";
import { ToolRegistry, type ToolExecutionContext } from "./registry.js";
import { createProcessTools } from "./process-tools.js";

const temporaryDirectories: string[] = [];
const context: ToolExecutionContext = {
  accountId: "local",
  scopeId: "resource_test",
  sessionId: "session_test",
  turnId: "turn_test",
  sourceEventIds: ["evt_test"],
};

async function fixture(): Promise<{
  root: string;
  registry: ToolRegistry;
  permissions: JsonlProcessPermissionStore;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "daoyin-process-tools-"));
  temporaryDirectories.push(root);
  const workspace = await Workspace.open(root);
  const service = await ProcessService.create(root, { sandboxMode: "off" });
  const permissions = new JsonlProcessPermissionStore(path.join(root, ".permissions.jsonl"));
  const fakeNpm = path.join(root, "fake-npm.mjs");
  await writeFile(fakeNpm, "process.stdout.write(`fake-npm:${process.argv.slice(2).join(':')}`);\n", "utf8");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }), "utf8");
  return {
    root,
    permissions,
    registry: new ToolRegistry(createProcessTools(service, permissions, workspace, { allowedPackageScripts: ["test"], npmCliPath: fakeNpm })),
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("process tools", () => {
  it("runs policy-defined read-only inspection without user approval", async () => {
    const { registry } = await fixture();
    const result = await registry.execute(
      { id: "call_node", name: "process_inspect", input: { operation: "node_version" } },
      new AbortController().signal,
      context,
    );
    expect(result).toMatchObject({ ok: true, evidence: { toolName: "process_inspect", result: { operation: "node_version", risk: "inspect" } } });
  });

  it("requires exact one-shot approval before executing a package script", async () => {
    const { registry, permissions } = await fixture();
    const first = await registry.execute(
      { id: "call_test_first", name: "run_package_script", input: { script: "test" } },
      new AbortController().signal,
      context,
    );
    expect(first).toMatchObject({ ok: false, code: "PROCESS_APPROVAL_REQUIRED", retryable: true });
    if (first.ok) throw new Error("expected approval failure");
    const details = first.details as { permissionRequestId?: unknown };
    expect(typeof details.permissionRequestId).toBe("string");
    await permissions.decide(String(details.permissionRequestId), context.accountId, context.scopeId, true);

    const second = await registry.execute(
      { id: "call_test_second", name: "run_package_script", input: { script: "test" } },
      new AbortController().signal,
      { ...context, turnId: "turn_second" },
    );
    expect(second).toMatchObject({ ok: true, evidence: { toolName: "run_package_script", result: { exitCode: 0 } } });
    if (second.ok) expect(second.evidence.result).toMatchObject({ stdout: expect.stringContaining("fake-npm:run:test") });

    const third = await registry.execute(
      { id: "call_test_third", name: "run_package_script", input: { script: "test" } },
      new AbortController().signal,
      { ...context, turnId: "turn_third" },
    );
    expect(third).toMatchObject({ ok: false, code: "PROCESS_APPROVAL_REQUIRED" });
  });
});
