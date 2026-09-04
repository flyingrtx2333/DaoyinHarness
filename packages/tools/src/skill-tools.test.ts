import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Workspace } from "@daoyin/harness-workspace";
import { ToolRegistry } from "./registry.js";
import { createSkillTools, discoverWorkspaceSkills } from "./skill-tools.js";

const temporaryDirectories: string[] = [];

async function fixture(): Promise<{ root: string; workspace: Workspace }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "daoyin-skill-test-"));
  temporaryDirectories.push(root);
  return { root, workspace: await Workspace.open(root) };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("workspace skills", () => {
  it("discovers only canonical workspace skill files", async () => {
    const { root, workspace } = await fixture();
    await mkdir(path.join(root, ".daoyin", "skills", "research"), { recursive: true });
    await writeFile(path.join(root, ".daoyin", "skills", "research", "SKILL.md"), "---\ndescription: Research public sources with provenance.\n---\n# Research\n", "utf8");
    await mkdir(path.join(root, "skills", "ignored"), { recursive: true });
    await writeFile(path.join(root, "skills", "ignored", "SKILL.md"), "ignored", "utf8");

    await expect(discoverWorkspaceSkills(workspace)).resolves.toEqual([
      { name: "research", description: "Research public sources with provenance.", path: ".daoyin/skills/research/SKILL.md" },
    ]);
  });

  it("loads a discovered skill through the normal capability registry", async () => {
    const { root, workspace } = await fixture();
    await mkdir(path.join(root, ".daoyin", "skills", "notes"), { recursive: true });
    await writeFile(path.join(root, ".daoyin", "skills", "notes", "SKILL.md"), "# Notes\nKeep concise provenance.\n", "utf8");
    const tools = new ToolRegistry(createSkillTools(workspace));

    const result = await tools.execute(
      { id: "call_skill", name: "load_skill", input: { name: "notes" } },
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      ok: true,
      evidence: { result: { name: "notes", content: expect.stringContaining("Keep concise provenance") } },
    });
  });
});
