import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserService, browserExecutableCandidates, discoverBrowserExecutable } from "./browser-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

async function executableFixture(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "daoyin-browser-executable-"));
  temporaryDirectories.push(directory);
  const executable = path.join(directory, "browser-fixture");
  await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(executable, 0o700);
  return executable;
}

describe("BrowserService discovery", () => {
  it("discovers only executable fixed candidates", async () => {
    const executable = await executableFixture();
    await expect(discoverBrowserExecutable([path.join(path.dirname(executable), "missing"), executable])).resolves.toBe(executable);
  });

  it("reports unavailable without launching when the configured executable does not exist", async () => {
    const service = await BrowserService.create({ executablePath: path.join(os.tmpdir(), "definitely-missing-daoyin-browser") });
    expect(service.status).toMatchObject({ available: false, executablePath: null });
    await service.close();
  });

  it("reports an explicit executable as available without starting a browser process", async () => {
    const executable = await executableFixture();
    const service = await BrowserService.create({ executablePath: executable });
    expect(service.status).toMatchObject({ available: true, executablePath: executable });
    await service.close();
  });

  it("includes the environment override before platform defaults", () => {
    const candidates = browserExecutableCandidates({ DAOYIN_HARNESS_BROWSER_EXECUTABLE: "/custom/browser" }, "linux");
    expect(candidates[0]).toBe(path.resolve("/custom/browser"));
    expect(candidates).toContain("/usr/bin/google-chrome");
  });
});
