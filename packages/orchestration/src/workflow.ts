import type { GoalRecord, WorkflowRun } from "@daoyin/harness-protocol";
import { ChildAgentRunner } from "./child-agent.js";
import { JsonlOrchestrationStore } from "./store.js";

export interface WorkflowExecutionInput {
  accountId: string;
  resourceScopeId: string;
  parentSessionId: string;
  parentTurnId: string;
  workflowId: string;
  goalId?: string;
  signal: AbortSignal;
}

function errorDetails(error: unknown): { code: string; message: string } {
  const candidate = error as { code?: unknown; message?: unknown };
  return {
    code: typeof candidate.code === "string" ? candidate.code : "CHILD_AGENT_FAILED",
    message: typeof candidate.message === "string" ? candidate.message.slice(0, 2_000) : "Child Agent failed.",
  };
}

export class WorkflowService {
  readonly #store: JsonlOrchestrationStore;
  readonly #children: ChildAgentRunner;

  public constructor(store: JsonlOrchestrationStore, children: ChildAgentRunner) {
    this.#store = store;
    this.#children = children;
  }

  public async run(input: WorkflowExecutionInput): Promise<WorkflowRun> {
    const workflow = await this.#store.getWorkflow(input.accountId, input.resourceScopeId, input.workflowId);
    if (workflow === undefined) throw Object.assign(new Error("Workflow not found in the current account/resource scope."), { code: "WORKFLOW_NOT_FOUND" });
    let linkedGoal: GoalRecord | undefined;
    if (input.goalId !== undefined) {
      linkedGoal = await this.#store.getGoal(input.accountId, input.resourceScopeId, input.parentSessionId, input.goalId);
      if (linkedGoal === undefined) throw Object.assign(new Error("Linked goal not found in the current session scope."), { code: "GOAL_NOT_FOUND" });
    }

    const now = new Date().toISOString();
    let run: WorkflowRun = {
      id: `wfrun_${crypto.randomUUID().replaceAll("-", "")}`,
      workflowId: workflow.id,
      accountId: input.accountId,
      resourceScopeId: input.resourceScopeId,
      parentSessionId: input.parentSessionId,
      parentTurnId: input.parentTurnId,
      goalId: linkedGoal?.id ?? null,
      status: "running",
      steps: workflow.steps.map((step) => ({ stepId: step.id, status: "pending", childRunId: null, summary: "" })),
      createdAt: now,
      updatedAt: now,
    };
    await this.#store.saveWorkflowRun(run);

    for (let index = 0; index < workflow.steps.length; index += 1) {
      const definition = workflow.steps[index];
      const state = run.steps[index];
      if (definition === undefined || state === undefined) continue;
      if (input.signal.aborted) {
        state.status = "cancelled";
        run = { ...run, status: "cancelled", updatedAt: new Date().toISOString(), steps: run.steps.map((step) => ({ ...step })) };
        await this.#store.saveWorkflowRun(run);
        throw Object.assign(new Error("Workflow execution was cancelled."), { code: "TOOL_CANCELLED", details: run });
      }

      state.status = "running";
      run = { ...run, updatedAt: new Date().toISOString(), steps: run.steps.map((step) => ({ ...step })) };
      await this.#store.saveWorkflowRun(run);

      try {
        const child = await this.#children.run({
          accountId: input.accountId,
          resourceScopeId: input.resourceScopeId,
          parentSessionId: input.parentSessionId,
          parentTurnId: input.parentTurnId,
          instruction: definition.instruction,
          signal: input.signal,
        });
        const current = run.steps[index];
        if (current === undefined) continue;
        current.childRunId = child.run.id;
        current.summary = child.result.finalText.slice(0, 2_000);
        current.status = child.result.status === "completed" ? "completed" : child.result.status === "cancelled" ? "cancelled" : "failed";
        if (child.result.status !== "completed") {
          run = {
            ...run,
            status: child.result.status === "cancelled" ? "cancelled" : "failed",
            updatedAt: new Date().toISOString(),
            steps: run.steps.map((step) => ({ ...step })),
          };
          await this.#store.saveWorkflowRun(run);
          if (linkedGoal !== undefined) {
            linkedGoal = await this.#store.updateGoal({
              accountId: input.accountId,
              resourceScopeId: input.resourceScopeId,
              sessionId: input.parentSessionId,
              goalId: linkedGoal.id,
              status: child.result.status === "cancelled" ? "cancelled" : "blocked",
              note: `Workflow ${workflow.name} stopped at ${definition.id}: ${child.result.finalText.slice(0, 1_000)}`,
            });
          }
          throw Object.assign(new Error(`Workflow stopped at ${definition.id}: ${child.result.finalText}`), {
            code: child.result.status === "cancelled" ? "TOOL_CANCELLED" : "WORKFLOW_RUN_FAILED",
            details: run,
          });
        }
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && ((error as { code?: unknown }).code === "WORKFLOW_RUN_FAILED" || (error as { code?: unknown }).code === "TOOL_CANCELLED")) {
          throw error;
        }
        const failure = errorDetails(error);
        const current = run.steps[index];
        if (current !== undefined) {
          current.status = input.signal.aborted ? "cancelled" : "failed";
          current.summary = failure.message;
        }
        run = {
          ...run,
          status: input.signal.aborted ? "cancelled" : "failed",
          updatedAt: new Date().toISOString(),
          steps: run.steps.map((step) => ({ ...step })),
        };
        await this.#store.saveWorkflowRun(run);
        if (linkedGoal !== undefined) {
          await this.#store.updateGoal({
            accountId: input.accountId,
            resourceScopeId: input.resourceScopeId,
            sessionId: input.parentSessionId,
            goalId: linkedGoal.id,
            status: input.signal.aborted ? "cancelled" : "blocked",
            note: `Workflow ${workflow.name} stopped at ${definition.id}: ${failure.message}`,
          });
        }
        throw Object.assign(new Error(`Workflow step ${definition.id} failed: ${failure.message}`), {
          code: input.signal.aborted ? "TOOL_CANCELLED" : "WORKFLOW_RUN_FAILED",
          details: run,
        });
      }
    }

    run = { ...run, status: "completed", updatedAt: new Date().toISOString(), steps: run.steps.map((step) => ({ ...step })) };
    await this.#store.saveWorkflowRun(run);
    if (linkedGoal !== undefined) {
      await this.#store.updateGoal({
        accountId: input.accountId,
        resourceScopeId: input.resourceScopeId,
        sessionId: input.parentSessionId,
        goalId: linkedGoal.id,
        status: "completed",
        note: `Workflow ${workflow.name} completed successfully.`,
      });
    }
    return run;
  }
}
