import { appendFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlOrchestrationStore } from "./store.js";

const directories: string[] = [];

async function fixture(): Promise<{ store: JsonlOrchestrationStore; file: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "daoyin-orchestration-store-"));
  directories.push(directory);
  const file = path.join(directory, "orchestration.jsonl");
  return { store: new JsonlOrchestrationStore(file), file };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

describe("JsonlOrchestrationStore", () => {
  it("persists visible goal revisions and rejects stale expected revisions", async () => {
    const { store } = await fixture();
    const goal = await store.createGoal({
      accountId: "account",
      resourceScopeId: "resource",
      sessionId: "session",
      title: "Ship v1",
      description: "Finish the general Agent runtime.",
      steps: ["Implement goals", "Implement workflows"],
    });
    expect(goal.revision).toBe(1);
    expect(goal.steps.map((step) => step.status)).toEqual(["pending", "pending"]);

    const updated = await store.updateGoal({
      accountId: "account",
      resourceScopeId: "resource",
      sessionId: "session",
      goalId: goal.id,
      expectedRevision: 1,
      stepId: "step_1",
      stepStatus: "completed",
      note: "Goals landed.",
    });
    expect(updated.revision).toBe(2);
    expect(updated.steps[0]?.status).toBe("completed");

    await expect(store.updateGoal({
      accountId: "account",
      resourceScopeId: "resource",
      sessionId: "session",
      goalId: goal.id,
      expectedRevision: 1,
      status: "completed",
    })).rejects.toMatchObject({ code: "GOAL_REVISION_CONFLICT", retryable: true });

    const snapshot = await store.snapshot("account", "resource", "session");
    expect(snapshot.goals).toHaveLength(1);
    expect(snapshot.goals[0]?.revision).toBe(2);
  });

  it("scopes goals to sessions while keeping workflow definitions resource-scoped", async () => {
    const { store } = await fixture();
    await store.createGoal({ accountId: "account", resourceScopeId: "resource", sessionId: "session_a", title: "A" });
    await store.createGoal({ accountId: "account", resourceScopeId: "resource", sessionId: "session_b", title: "B" });
    const workflow = await store.createWorkflow({
      accountId: "account",
      resourceScopeId: "resource",
      name: "Research then summarize",
      steps: ["Research the topic", "Summarize the evidence"],
    });

    expect((await store.snapshot("account", "resource", "session_a")).goals.map((goal) => goal.title)).toEqual(["A"]);
    expect((await store.snapshot("account", "resource", "session_b")).goals.map((goal) => goal.title)).toEqual(["B"]);
    expect((await store.snapshot("account", "resource", "session_a")).workflows.map((item) => item.id)).toEqual([workflow.id]);
  });

  it("repairs a truncated journal tail before the next append", async () => {
    const { store, file } = await fixture();
    await store.createGoal({ accountId: "account", resourceScopeId: "resource", sessionId: "session", title: "First" });
    await appendFile(file, "{\"kind\":\"goal\"", "utf8");
    await expect(store.createGoal({ accountId: "account", resourceScopeId: "resource", sessionId: "session", title: "Second" })).resolves.toBeDefined();
    expect((await store.snapshot("account", "resource", "session")).goals.map((goal) => goal.title)).toEqual(["First", "Second"]);
  });
});
