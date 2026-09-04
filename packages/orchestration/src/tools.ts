import type { JsonValue } from "@daoyin/harness-protocol";
import type { ToolDefinition, ToolSuccess } from "@daoyin/harness-tools";
import { ChildAgentRunner } from "./child-agent.js";
import { JsonlOrchestrationStore } from "./store.js";
import { WorkflowService } from "./workflow.js";

const objectSchema = (properties: Record<string, JsonValue>, required: string[]): JsonValue => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

function stringArg(input: Record<string, unknown>, name: string, allowEmpty = false): string {
  const value = input[name];
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    throw Object.assign(new Error(`${name} must be ${allowEmpty ? "a string" : "a non-empty string"}.`), { code: "ORCHESTRATION_INPUT_INVALID" });
  }
  return allowEmpty ? value : value.trim();
}

function optionalString(input: Record<string, unknown>, name: string): string | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw Object.assign(new Error(`${name} must be a string.`), { code: "ORCHESTRATION_INPUT_INVALID" });
  return value;
}

function optionalInteger(input: Record<string, unknown>, name: string): number | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < 1) throw Object.assign(new Error(`${name} must be a positive integer.`), { code: "ORCHESTRATION_INPUT_INVALID" });
  return Number(value);
}

function stringArray(input: Record<string, unknown>, name: string, required: boolean): string[] | undefined {
  const value = input[name];
  if (value === undefined && !required) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw Object.assign(new Error(`${name} must be an array of strings.`), { code: "ORCHESTRATION_INPUT_INVALID" });
  }
  return value as string[];
}

function toJsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 16) return "[depth-limit]";
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.slice(0, 300).map((entry) => toJsonValue(entry, depth + 1));
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value).slice(0, 300)) result[key] = toJsonValue(entry, depth + 1);
    return result;
  }
  return String(value);
}

function success(toolName: string, summary: string, value: unknown): ToolSuccess {
  return {
    ok: true,
    summary,
    evidence: { schemaVersion: 1, toolName, result: toJsonValue(value), artifacts: [], diagnostics: [] },
  };
}

export interface OrchestrationToolsOptions {
  store: JsonlOrchestrationStore;
  children: ChildAgentRunner;
  workflows: WorkflowService;
}

export function createOrchestrationTools(options: OrchestrationToolsOptions): ToolDefinition[] {
  const { store, children, workflows } = options;
  return [
    {
      name: "goal_create",
      description: "Create a persistent, user-visible goal/task artifact for the current session. Goals are explicit task state, not hidden reasoning. Use for multi-step work that benefits from durable progress tracking.",
      category: "system",
      mutating: true,
      inputSchema: objectSchema({
        title: { type: "string", minLength: 1, maxLength: 200 },
        description: { type: "string", maxLength: 4000 },
        steps: { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 1000 } },
      }, ["title"]),
      async execute(input, _signal, context) {
        const description = optionalString(input, "description");
        const steps = stringArray(input, "steps", false);
        const goal = await store.createGoal({
          accountId: context.accountId,
          resourceScopeId: context.scopeId,
          sessionId: context.sessionId,
          title: stringArg(input, "title"),
          ...(description === undefined ? {} : { description }),
          ...(steps === undefined ? {} : { steps }),
        });
        return success("goal_create", `Created goal ${goal.id}: ${goal.title}.`, goal);
      },
    },
    {
      name: "goal_list",
      description: "List the current session's persistent goals with visible steps, statuses, notes and revisions.",
      category: "system",
      mutating: false,
      inputSchema: objectSchema({}, []),
      async execute(_input, _signal, context) {
        const snapshot = await store.snapshot(context.accountId, context.scopeId, context.sessionId);
        return success("goal_list", `Found ${String(snapshot.goals.length)} goals for this session.`, { goals: snapshot.goals });
      },
    },
    {
      name: "goal_update",
      description: "Update visible goal status, note, or one step status. expectedRevision can prevent overwriting newer task-state updates.",
      category: "system",
      mutating: true,
      inputSchema: objectSchema({
        goalId: { type: "string" },
        expectedRevision: { type: "integer", minimum: 1 },
        status: { type: "string", enum: ["active", "blocked", "completed", "cancelled"] },
        note: { type: "string", maxLength: 4000 },
        stepId: { type: "string" },
        stepStatus: { type: "string", enum: ["pending", "in_progress", "completed", "blocked", "cancelled"] },
      }, ["goalId"]),
      async execute(input, _signal, context) {
        const expectedRevision = optionalInteger(input, "expectedRevision");
        const status = optionalString(input, "status");
        const note = optionalString(input, "note");
        const stepId = optionalString(input, "stepId");
        const stepStatus = optionalString(input, "stepStatus");
        if (status === undefined && note === undefined && stepId === undefined && stepStatus === undefined) {
          throw Object.assign(new Error("goal_update requires at least one state change."), { code: "ORCHESTRATION_INPUT_INVALID" });
        }
        const goal = await store.updateGoal({
          accountId: context.accountId,
          resourceScopeId: context.scopeId,
          sessionId: context.sessionId,
          goalId: stringArg(input, "goalId"),
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
          ...(status === undefined ? {} : { status: status as "active" | "blocked" | "completed" | "cancelled" }),
          ...(note === undefined ? {} : { note }),
          ...(stepId === undefined ? {} : { stepId }),
          ...(stepStatus === undefined ? {} : { stepStatus: stepStatus as "pending" | "in_progress" | "completed" | "blocked" | "cancelled" }),
        });
        return success("goal_update", `Updated goal ${goal.id} to revision ${String(goal.revision)}.`, goal);
      },
    },
    {
      name: "workflow_create",
      description: "Create a reusable sequential workflow definition. Each workflow step is a bounded instruction that will execute as a separate auditable child Agent run.",
      category: "system",
      mutating: true,
      inputSchema: objectSchema({
        name: { type: "string", minLength: 1, maxLength: 200 },
        description: { type: "string", maxLength: 4000 },
        steps: { type: "array", minItems: 1, maxItems: 16, items: { type: "string", minLength: 1, maxLength: 4000 } },
      }, ["name", "steps"]),
      async execute(input, _signal, context) {
        const description = optionalString(input, "description");
        const workflowSteps = stringArray(input, "steps", true) ?? [];
        const workflow = await store.createWorkflow({
          accountId: context.accountId,
          resourceScopeId: context.scopeId,
          name: stringArg(input, "name"),
          ...(description === undefined ? {} : { description }),
          steps: workflowSteps,
        });
        return success("workflow_create", `Created workflow ${workflow.id}: ${workflow.name}.`, workflow);
      },
    },
    {
      name: "workflow_list",
      description: "List reusable workflows plus recent workflow and child-Agent runs visible in the current resource/session scope.",
      category: "system",
      mutating: false,
      inputSchema: objectSchema({}, []),
      async execute(_input, _signal, context) {
        const snapshot = await store.snapshot(context.accountId, context.scopeId, context.sessionId);
        return success("workflow_list", `Found ${String(snapshot.workflows.length)} workflows.`, {
          workflows: snapshot.workflows,
          workflowRuns: snapshot.workflowRuns.slice(-20),
          childRuns: snapshot.childRuns.slice(-20),
        });
      },
    },
    {
      name: "delegate_agent",
      description: "Delegate one bounded subtask to an auditable child Agent with a separate child session/turn. Child runs share the parent cancellation signal and cannot recursively delegate further.",
      category: "system",
      mutating: true,
      inputSchema: objectSchema({ instruction: { type: "string", minLength: 1, maxLength: 6000 } }, ["instruction"]),
      async execute(input, signal, context) {
        const child = await children.run({
          accountId: context.accountId,
          resourceScopeId: context.scopeId,
          parentSessionId: context.sessionId,
          parentTurnId: context.turnId,
          instruction: stringArg(input, "instruction"),
          signal,
        });
        if (child.result.status !== "completed") {
          throw Object.assign(new Error(`Child Agent ${child.run.id} ${child.result.status}: ${child.result.finalText}`), {
            code: child.result.status === "cancelled" ? "TOOL_CANCELLED" : "CHILD_AGENT_FAILED",
            details: child.run,
          });
        }
        return success("delegate_agent", `Child Agent ${child.run.id} completed.`, {
          childRun: child.run,
          finalText: child.result.finalText,
          lastEventSeq: child.result.lastEventSeq,
        });
      },
    },
    {
      name: "workflow_run",
      description: "Execute a reusable workflow sequentially. Every step creates an auditable child Agent run. The tool fails if any child step fails or is cancelled, preventing a parent from treating a partial workflow as completed.",
      category: "system",
      mutating: true,
      inputSchema: objectSchema({
        workflowId: { type: "string" },
        goalId: { type: "string" },
      }, ["workflowId"]),
      async execute(input, signal, context) {
        const goalId = optionalString(input, "goalId");
        const run = await workflows.run({
          accountId: context.accountId,
          resourceScopeId: context.scopeId,
          parentSessionId: context.sessionId,
          parentTurnId: context.turnId,
          workflowId: stringArg(input, "workflowId"),
          ...(goalId === undefined ? {} : { goalId }),
          signal,
        });
        return success("workflow_run", `Workflow run ${run.id} completed all ${String(run.steps.length)} steps.`, run);
      },
    },
  ];
}
