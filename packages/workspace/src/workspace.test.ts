import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Workspace, WorkspaceError } from "./workspace.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Workspace", () => {
  it("reads, searches, writes, and patches files inside the root", async () => {
    const root = await temporaryDirectory("daoyin-harness-workspace-");
    await writeFile(path.join(root, "README.md"), "hello world\nsecond line\n", "utf8");
    const workspace = await Workspace.open(root);

    expect(await workspace.listFiles()).toEqual(["README.md"]);
    expect(await workspace.readText("README.md")).toContain("hello world");
    expect(await workspace.searchText("second")).toEqual([{ path: "README.md", line: 2, text: "second line" }]);

    await workspace.writeText("src/index.ts", "export const value = 1;\n");
    await workspace.replaceText("src/index.ts", "value = 1", "value = 2");
    expect(await readFile(path.join(root, "src", "index.ts"), "utf8")).toContain("value = 2");
  });

  it.each(["../outside.txt", "C:\\outside.txt", "safe.txt:secret", "CON.txt"])("rejects unsafe path %s", async (unsafePath) => {
    const workspace = await Workspace.open(await temporaryDirectory("daoyin-harness-workspace-"));
    await expect(workspace.writeText(unsafePath, "blocked")).rejects.toBeInstanceOf(WorkspaceError);
  });

  it("rejects writes through a directory link before creating external content", async () => {
    const root = await temporaryDirectory("daoyin-harness-workspace-");
    const outside = await temporaryDirectory("daoyin-harness-outside-");
    await mkdir(path.join(outside, "existing"));
    await symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    const workspace = await Workspace.open(root);

    await expect(workspace.writeText("linked/new/file.txt", "blocked")).rejects.toMatchObject({ code: "WORKSPACE_ESCAPE" });
    await expect(access(path.join(outside, "new"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires patch source text to match exactly once", async () => {
    const root = await temporaryDirectory("daoyin-harness-workspace-");
    await writeFile(path.join(root, "duplicate.txt"), "same same", "utf8");
    const workspace = await Workspace.open(root);
    await expect(workspace.replaceText("duplicate.txt", "same", "new")).rejects.toMatchObject({ code: "WORKSPACE_PATCH_CONFLICT" });
  });
});
