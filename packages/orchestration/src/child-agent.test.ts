import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultPromptRegistry, type ModelClient } from "@daoyin/harness-agent-core";
import { ToolRegistry } from "@daoyin/harness-tools";
import { JsonlCompactionStore, JsonlSessionStore } from "@daoyin/harness-workspace";
import { ChildAgentRunner } from "./child-agent.js";
import { JsonlOrchestrationStore } from "./store.js";

const directories: string[] = [];

async function fixture(model: ModelClient): Promise<{ runner: ChildAgentRunner; store: JsonlOrchestrationStore; events: JsonlSessionStore }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "daoyin-child-agent-"));
  directories.push(directory);
  const store = new JsonlOrchestrationStore(path.join(directory, "orchestration.jsonl"));
  const events = new JsonlSessionStore(path.join(directory, "transcripts"));
  const runner = new ChildAgentRunner({
    model,
    tools: new ToolRegistry(),
    events,
    promptRegistry: createDefaultPromptRegistry(),
    store,
    compactionStore: new JsonlCompactionStore(path.join(directory, "compactions")),
  });
  return { runner, store, events };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

describe("ChildAgentRunner", () => {
  it("persists parent/child links and a separate child trajectory", async () => {
    const model: ModelClient = {
      async complete(request) {
        expect(request.messages.some((message) => message.role === "system" && message.content.includes("bounded child Agent"))).toBe(true);
        return { kind: "assistant", content: "Child result." };
      },
    };
    const { runner, store, events } = await fixture(model);
    const execution = await runner.run({
      accountId: "account",
      resourceScopeId: "resource",
      parentSessionId: "session_parent",
      parentTurnId: "turn_parent",
      instruction: "Inspect one bounded subtask.",
      signal: new AbortController().signal,
    });

    expect(execution.run).toMatchObject({
      parentSessionId: "session_parent",
      parentTurnId: "turn_parent",
      status: "completed",
      finalText: "Child result.",
    });
    expect(execution.run.childSessionId).not.toBe("session_parent");
    expect((await events.read(execution.run.childSessionId)).map((event) => event.type)).toEqual([
      "turn.started",
      "assistant.delta",
      "turn.completed",
    ]);
    const snapshot = await store.snapshot("account", "resource", "session_parent");
    expect(snapshot.childRuns).toEqual([expect.objectContaining({ id: execution.run.id, status: "completed" })]);
  });

  it("refuses delegation when no real model is available", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "daoyin-child-agent-no-model-"));
    directories.push(directory);
    const store = new JsonlOrchestrationStore(path.join(directory, "orchestration.jsonl"));
    const runner = new ChildAgentRunner({
      model: null,
      tools: new ToolRegistry(),
      events: new JsonlSessionStore(path.join(directory, "transcripts")),
      promptRegistry: createDefaultPromptRegistry(),
      store,
    });
    await expect(runner.run({
      accountId: "account",
      resourceScopeId: "resource",
      parentSessionId: "session_parent",
      parentTurnId: "turn_parent",
      instruction: "Do work.",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "MODEL_AUTH_REQUIRED" });
  });
});
