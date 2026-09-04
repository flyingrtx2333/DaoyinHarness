import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BubblewrapSandboxProvider, discoverSandboxProvider } from "./sandbox.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "daoyin-sandbox-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("sandbox providers", () => {
  it("keeps explicit off mode unavailable instead of pretending isolation exists", async () => {
    const provider = await discoverSandboxProvider("off");
    expect(provider.id).toBe("none");
    expect(provider.status("off")).toMatchObject({
      mode: "off",
      provider: "none",
      available: false,
      osIsolation: "none",
      networkIsolation: "none",
    });
  });

  it("builds a Bubblewrap command around the exact process without shell interpolation", async () => {
    const root = await temporaryDirectory();
    const runtimeRoot = await temporaryDirectory();
    const runtimeExecutable = path.join(runtimeRoot, "runtime-bin");
    await writeFile(runtimeExecutable, "runtime", "utf8");
    const provider = await BubblewrapSandboxProvider.create("/sandbox/bwrap", "/usr/bin/true");

    const wrapped = await provider.wrap({
      executable: runtimeExecutable,
      args: ["--flag", "value with spaces"],
      cwd: root,
      workspaceRoot: root,
      policy: { requested: true, allowNetwork: false, readOnlyPaths: [runtimeExecutable] },
    });

    expect(wrapped).toMatchObject({
      executable: "/sandbox/bwrap",
      provider: "bubblewrap",
      osIsolation: "bubblewrap",
      networkIsolation: "blocked",
      environmentOverrides: { HOME: "/tmp/home", TMPDIR: "/tmp" },
    });
    expect(wrapped.args).toEqual(expect.arrayContaining(["--unshare-all", "--bind", root, root, "--", runtimeExecutable, "--flag", "value with spaces"]));
    expect(wrapped.args).not.toContain("--share-net");
  });

  it("can explicitly share the network only when the runtime-owned policy requests it", async () => {
    const root = await temporaryDirectory();
    const provider = await BubblewrapSandboxProvider.create("/sandbox/bwrap", "/usr/bin/true");
    const wrapped = await provider.wrap({
      executable: "/usr/bin/true",
      args: [],
      cwd: root,
      workspaceRoot: root,
      policy: { requested: true, allowNetwork: true },
    });
    expect(wrapped.args).toContain("--share-net");
    expect(wrapped.networkIsolation).toBe("none");
  });
});
