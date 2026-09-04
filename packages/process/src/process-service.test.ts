import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessService } from "./process-service.js";

const temporaryDirectories: string[] = [];

async function fixture(): Promise<{ root: string; service: ProcessService }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "daoyin-process-"));
  temporaryDirectories.push(root);
  return { root, service: await ProcessService.create(root, { sandboxMode: "off" }) };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ProcessService", () => {
  it("runs an argument-array process with minimal environment and bounded evidence", async () => {
    const { service } = await fixture();
    const result = await service.execute({ executable: process.execPath, args: ["--version"] }, new AbortController().signal);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("v");
    expect(result.cwd).toBe(service.root);
    expect(result.sandboxRequested).toBe(false);
    expect(result.osIsolation).toBe("none");
    expect(result.networkIsolation).toBe("none");
    expect(result.timedOut).toBe(false);
    expect(result.cancelled).toBe(false);
  });

  it("reports explicit permission-only fallback when sandbox is turned off", async () => {
    const { service } = await fixture();
    expect(service.sandboxStatus).toMatchObject({ mode: "off", provider: "none", available: false, osIsolation: "none" });
    const result = await service.execute({
      executable: process.execPath,
      args: ["--version"],
      sandbox: { requested: true, allowNetwork: false },
    }, new AbortController().signal);
    expect(result).toMatchObject({
      sandboxRequested: true,
      sandboxProvider: "none",
      osIsolation: "none",
      networkIsolation: "none",
    });
    expect(result.sandboxReason).toContain("disabled");
  });

  it("confines cwd to an existing directory beneath the selected root", async () => {
    const { root, service } = await fixture();
    await mkdir(path.join(root, "nested"));
    await expect(service.resolveCwd("nested")).resolves.toBe(path.join(root, "nested"));
    await expect(service.resolveCwd("..")).rejects.toMatchObject({ code: "PROCESS_CWD_DENIED" });
  });
});
