import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRunResult } from "@daoyin/harness-agent-core";
import type { ChildAgentExecution } from "./child-agent.js";
import { JsonlOrchestrationStore } from "./store.js";
import { WorkflowService } from "./workflow.js";

const directories: string[] = [];

async function fixture(): Promise<{ store: JsonlOrchestrationStore; directory: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "daoyin-workflow-"));
  directories.push(directory);
  return { store: new JsonlOrchestrationStore(path.join(directory, "orchestration.jsonl")), directory };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

function childExecution(index: number, status: AgentRunResult["status"] = "completed"): ChildAgentExecution {
  const finalText = status === "completed" ? `step ${String(index)} complete` : `step ${String(index)} failed`;
  return {
    run: {
      id: `childrun_${String(index)}`,
      accountId: "account",
      resourceScopeId: "resource",
      parentSessionId: "session",
      parentTurnId: "turn",
      childSessionId: `child_${String(index)}`,
      childTurnId: `turn_child_${String(index)}`,
      instruction: `step ${String(index)}`,
      status,
      finalText,
      createdAt: "2026-09-04T00:00:00.000Z",
      updatedAt: "2026-09-04T00:00:01.000Z",
    },
    result: { status, finalText, lastEventSeq: 3 },
  };
}

describe("WorkflowService", () => {
  it("runs sequential child steps and completes a linked visible goal", async () => {
    const { store } = await fixture();
    const workflow = await store.createWorkflow({ accountId: "account", resourceScopeId: "resource", name: "Two steps", steps: ["one", "two"] });
    const goal = await store.createGoal({ accountId: "account", resourceScopeId: "resource", sessionId: "session", title: "Linked goal" });
    let index = 0;
    const children = { run: async () => childExecution(++index) };
    const service = new WorkflowService(store, children as never);

    const run = await service.run({
      accountId: "account",
      resourceScopeId: "resource",
      parentSessionId: "session",
      parentTurnId: "turn",
      workflowId: workflow.id,
      goalId: goal.id,
      signal: new AbortController().signal,
    });

    expect(run.status).toBe("completed");
    expect(run.steps.map((step) => step.status)).toEqual(["completed", "completed"]);
    expect(run.steps.map((step) => step.childRunId)).toEqual(["childrun_1", "childrun_2"]);
    const snapshot = await store.snapshot("account", "resource", "session");
    expect(snapshot.workflowRuns).toEqual([expect.objectContaining({ id: run.id, status: "completed" })]);
    expect(snapshot.goals[0]).toMatchObject({ id: goal.id, status: "completed", revision: 2 });
  });

  it("persists failed workflow state and blocks the linked goal when a child fails", async () => {
    const { store } = await fixture();
    const workflow = await store.createWorkflow({ accountId: "account", resourceScopeId: "resource", name: "Failing flow", steps: ["one", "two", "three"] });
    const goal = await store.createGoal({ accountId: "account", resourceScopeId: "resource", sessionId: "session", title: "Linked goal" });
    let index = 0;
    const children = { run: async () => childExecution(++index, index === 2 ? "failed" : "completed") };
    const service = new WorkflowService(store, children as never);

    await expect(service.run({
      accountId: "account",
      resourceScopeId: "resource",
      parentSessionId: "session",
      parentTurnId: "turn",
      workflowId: workflow.id,
      goalId: goal.id,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "WORKFLOW_RUN_FAILED" });

    const snapshot = await store.snapshot("account", "resource", "session");
    expect(snapshot.workflowRuns).toEqual([
      expect.objectContaining({
        status: "failed",
        steps: [
          expect.objectContaining({ status: "completed" }),
          expect.objectContaining({ status: "failed" }),
          expect.objectContaining({ status: "pending" }),
        ],
      }),
    ]);
    expect(snapshot.goals[0]).toMatchObject({ status: "blocked" });
  });
});
