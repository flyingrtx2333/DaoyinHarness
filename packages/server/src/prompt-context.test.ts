import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Workspace } from "@daoyin/harness-workspace";
import { createLocalPromptRegistry } from "./prompt-context.js";

const temporaryDirectories: string[] = [];

async function temporaryWorkspace(): Promise<{ root: string; workspace: Workspace }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "daoyin-prompt-context-"));
  temporaryDirectories.push(root);
  return { root, workspace: await Workspace.open(root) };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("local prompt context", () => {
  it("assembles runtime, workspace guidance, skill catalog, visible orchestration state and memory as dynamic sections", async () => {
    const { root, workspace } = await temporaryWorkspace();
    await writeFile(path.join(root, "AGENTS.md"), "Keep workspace changes focused.\n", "utf8");
    await mkdir(path.join(root, ".daoyin", "skills", "research"), { recursive: true });
    await writeFile(
      path.join(root, ".daoyin", "skills", "research", "SKILL.md"),
      "---\ndescription: Research with cited public evidence.\n---\n# Research\n",
      "utf8",
    );
    const registry = createLocalPromptRegistry({
      workspace,
      workspaceSummary: { name: "demo", root, fileCount: 2 },
      orchestrationContextProvider: ({ sessionId }) => JSON.stringify({ goals: [{ id: "goal_visible", title: "Visible goal", sessionId }] }),
      memoryContextProvider: ({ userMessage }) => `Remembered preference related to: ${userMessage}`,
    });

    const assembled = await registry.assemble({
      accountId: "account_test",
      scopeId: "scope_test",
      sessionId: "session_test",
      turnId: "turn_test",
      userMessage: "research this",
      step: 0,
      priorEvents: [],
      tools: [],
    });

    expect(assembled.dynamicText).toContain("runtime_context");
    expect(assembled.dynamicText).toContain("workspace_context");
    expect(assembled.dynamicText).toContain("Keep workspace changes focused");
    expect(assembled.dynamicText).toContain("skill_catalog");
    expect(assembled.dynamicText).toContain("Research with cited public evidence");
    expect(assembled.dynamicText).toContain("orchestration_state");
    expect(assembled.dynamicText).toContain("Visible goal");
    expect(assembled.dynamicText).toContain("memory");
    expect(assembled.dynamicText).toContain("Remembered preference related to: research this");
  });
});
