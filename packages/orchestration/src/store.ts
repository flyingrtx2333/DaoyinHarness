import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  ChildAgentRun,
  GoalRecord,
  GoalStatus,
  OrchestrationSnapshot,
  WorkflowDefinition,
  WorkflowRun,
} from "@daoyin/harness-protocol";

const MAX_GOAL_STEPS = 32;
const MAX_WORKFLOW_STEPS = 16;

type GoalStepStatus = GoalRecord["steps"][number]["status"];

type JournalRecord =
  | { kind: "goal"; value: GoalRecord }
  | { kind: "workflow"; value: WorkflowDefinition }
  | { kind: "workflow_run"; value: WorkflowRun }
  | { kind: "child_run"; value: ChildAgentRun };

export interface CreateGoalInput {
  accountId: string;
  resourceScopeId: string;
  sessionId: string;
  title: string;
  description?: string;
  steps?: string[];
}

export interface UpdateGoalInput {
  accountId: string;
  resourceScopeId: string;
  sessionId: string;
  goalId: string;
  expectedRevision?: number;
  status?: GoalStatus;
  note?: string;
  stepId?: string;
  stepStatus?: GoalStepStatus;
}

export interface CreateWorkflowInput {
  accountId: string;
  resourceScopeId: string;
  name: string;
  description?: string;
  steps: string[];
}

interface ParsedJournal {
  records: JournalRecord[];
  validText: string;
  truncatedTail: boolean;
}

function boundedText(value: string | undefined, max: number, label: string, allowEmpty = false): string {
  const normalized = (value ?? "").trim();
  if (!allowEmpty && normalized.length === 0) throw Object.assign(new Error(`${label} cannot be empty.`), { code: "ORCHESTRATION_INPUT_INVALID" });
  if (normalized.length > max) throw Object.assign(new Error(`${label} exceeds ${String(max)} characters.`), { code: "ORCHESTRATION_INPUT_INVALID" });
  return normalized;
}

function assertScope(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{1,160}$/u.test(value)) {
    throw Object.assign(new Error(`${label} is invalid.`), { code: "ORCHESTRATION_SCOPE_INVALID" });
  }
}

function parseJournal(text: string): ParsedJournal {
  const lines = text.split("\n");
  const records: JournalRecord[] = [];
  let validCharacterCount = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.length === 0) {
      if (line === "" && index < lines.length - 1) validCharacterCount += 1;
      continue;
    }
    try {
      records.push(JSON.parse(line) as JournalRecord);
      validCharacterCount += line.length;
      if (index < lines.length - 1) validCharacterCount += 1;
    } catch (error) {
      if (index === lines.length - 1 && !text.endsWith("\n")) {
        return { records, validText: text.slice(0, validCharacterCount), truncatedTail: true };
      }
      throw new Error(`Orchestration journal contains invalid JSON at line ${String(index + 1)}.`, { cause: error });
    }
  }
  return { records, validText: text, truncatedTail: false };
}

function latestById<T extends { id: string }>(values: T[]): T[] {
  const latest = new Map<string, T>();
  for (const value of values) latest.set(value.id, value);
  return [...latest.values()];
}

export class JsonlOrchestrationStore {
  readonly #filePath: string;
  #queue: Promise<void> = Promise.resolve();

  public constructor(filePath: string) {
    this.#filePath = path.resolve(filePath);
  }

  public async createGoal(input: CreateGoalInput): Promise<GoalRecord> {
    assertScope(input.accountId, "accountId");
    assertScope(input.resourceScopeId, "resourceScopeId");
    assertScope(input.sessionId, "sessionId");
    const title = boundedText(input.title, 200, "goal title");
    const description = boundedText(input.description, 4_000, "goal description", true);
    const rawSteps = input.steps ?? [];
    if (rawSteps.length > MAX_GOAL_STEPS) throw Object.assign(new Error(`A goal can have at most ${String(MAX_GOAL_STEPS)} steps.`), { code: "ORCHESTRATION_INPUT_INVALID" });
    const createdAt = new Date().toISOString();
    const goal: GoalRecord = {
      id: `goal_${crypto.randomUUID().replaceAll("-", "")}`,
      accountId: input.accountId,
      resourceScopeId: input.resourceScopeId,
      sessionId: input.sessionId,
      title,
      description,
      status: "active",
      steps: rawSteps.map((text, index) => ({ id: `step_${String(index + 1)}`, text: boundedText(text, 1_000, "goal step"), status: "pending" })),
      note: "",
      revision: 1,
      createdAt,
      updatedAt: createdAt,
    };
    await this.#append({ kind: "goal", value: goal });
    return goal;
  }

  public async updateGoal(input: UpdateGoalInput): Promise<GoalRecord> {
    const goal = await this.getGoal(input.accountId, input.resourceScopeId, input.sessionId, input.goalId);
    if (goal === undefined) throw Object.assign(new Error("Goal not found in the current account/resource/session scope."), { code: "GOAL_NOT_FOUND" });
    if (input.expectedRevision !== undefined && input.expectedRevision !== goal.revision) {
      throw Object.assign(new Error(`Goal revision changed; expected ${String(input.expectedRevision)}, current ${String(goal.revision)}.`), { code: "GOAL_REVISION_CONFLICT", retryable: true });
    }
    if ((input.stepId === undefined) !== (input.stepStatus === undefined)) {
      throw Object.assign(new Error("stepId and stepStatus must be provided together."), { code: "ORCHESTRATION_INPUT_INVALID" });
    }
    const steps = goal.steps.map((step) => ({ ...step }));
    if (input.stepId !== undefined && input.stepStatus !== undefined) {
      const step = steps.find((candidate) => candidate.id === input.stepId);
      if (step === undefined) throw Object.assign(new Error("Goal step not found."), { code: "GOAL_STEP_NOT_FOUND" });
      step.status = input.stepStatus;
    }
    const next: GoalRecord = {
      ...goal,
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.note === undefined ? {} : { note: boundedText(input.note, 4_000, "goal note", true) }),
      steps,
      revision: goal.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.#append({ kind: "goal", value: next });
    return next;
  }

  public async getGoal(accountId: string, resourceScopeId: string, sessionId: string, goalId: string): Promise<GoalRecord | undefined> {
    return (await this.snapshot(accountId, resourceScopeId, sessionId)).goals.find((goal) => goal.id === goalId);
  }

  public async createWorkflow(input: CreateWorkflowInput): Promise<WorkflowDefinition> {
    assertScope(input.accountId, "accountId");
    assertScope(input.resourceScopeId, "resourceScopeId");
    if (input.steps.length === 0 || input.steps.length > MAX_WORKFLOW_STEPS) {
      throw Object.assign(new Error(`Workflow steps must contain 1..${String(MAX_WORKFLOW_STEPS)} items.`), { code: "ORCHESTRATION_INPUT_INVALID" });
    }
    const workflow: WorkflowDefinition = {
      id: `workflow_${crypto.randomUUID().replaceAll("-", "")}`,
      accountId: input.accountId,
      resourceScopeId: input.resourceScopeId,
      name: boundedText(input.name, 200, "workflow name"),
      description: boundedText(input.description, 4_000, "workflow description", true),
      steps: input.steps.map((instruction, index) => ({ id: `step_${String(index + 1)}`, instruction: boundedText(instruction, 4_000, "workflow instruction") })),
      createdAt: new Date().toISOString(),
    };
    await this.#append({ kind: "workflow", value: workflow });
    return workflow;
  }

  public async getWorkflow(accountId: string, resourceScopeId: string, workflowId: string): Promise<WorkflowDefinition | undefined> {
    return (await this.snapshot(accountId, resourceScopeId)).workflows.find((workflow) => workflow.id === workflowId);
  }

  public async saveWorkflowRun(run: WorkflowRun): Promise<void> {
    await this.#append({ kind: "workflow_run", value: run });
  }

  public async saveChildRun(run: ChildAgentRun): Promise<void> {
    await this.#append({ kind: "child_run", value: run });
  }

  public async snapshot(accountId: string, resourceScopeId: string, sessionId?: string): Promise<OrchestrationSnapshot> {
    assertScope(accountId, "accountId");
    assertScope(resourceScopeId, "resourceScopeId");
    if (sessionId !== undefined) assertScope(sessionId, "sessionId");
    const records = (await this.#read()).records;
    const goals = latestById(records.filter((record): record is Extract<JournalRecord, { kind: "goal" }> => record.kind === "goal").map((record) => record.value))
      .filter((goal) => goal.accountId === accountId && goal.resourceScopeId === resourceScopeId && (sessionId === undefined || goal.sessionId === sessionId));
    const workflows = latestById(records.filter((record): record is Extract<JournalRecord, { kind: "workflow" }> => record.kind === "workflow").map((record) => record.value))
      .filter((workflow) => workflow.accountId === accountId && workflow.resourceScopeId === resourceScopeId);
    const workflowRuns = latestById(records.filter((record): record is Extract<JournalRecord, { kind: "workflow_run" }> => record.kind === "workflow_run").map((record) => record.value))
      .filter((run) => run.accountId === accountId && run.resourceScopeId === resourceScopeId && (sessionId === undefined || run.parentSessionId === sessionId));
    const childRuns = latestById(records.filter((record): record is Extract<JournalRecord, { kind: "child_run" }> => record.kind === "child_run").map((record) => record.value))
      .filter((run) => run.accountId === accountId && run.resourceScopeId === resourceScopeId && (sessionId === undefined || run.parentSessionId === sessionId));
    return { goals, workflows, workflowRuns, childRuns };
  }

  async #append(record: JournalRecord): Promise<void> {
    const prior = this.#queue;
    const operation = prior.then(async () => {
      const parsed = await this.#read();
      if (parsed.truncatedTail) {
        const handle = await open(this.#filePath, "r+");
        try {
          await handle.truncate(Buffer.byteLength(parsed.validText, "utf8"));
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      await mkdir(path.dirname(this.#filePath), { recursive: true });
      const handle = await open(this.#filePath, "a", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    this.#queue = operation.catch(() => undefined);
    await operation;
  }

  async #read(): Promise<ParsedJournal> {
    try {
      return parseJournal(await readFile(this.#filePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], validText: "", truncatedTail: false };
      throw error;
    }
  }
}
