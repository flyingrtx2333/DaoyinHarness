import type { ChildAgentRun } from "@daoyin/harness-protocol";
import { AgentEngine, type AgentRunResult, type ModelClient, type SystemPromptRegistry } from "@daoyin/harness-agent-core";
import type { ToolRegistry } from "@daoyin/harness-tools";
import type { SessionCompactionStore, SessionEventStore } from "@daoyin/harness-workspace";
import { JsonlOrchestrationStore } from "./store.js";

export interface ChildAgentRunnerOptions {
  model: ModelClient | null;
  tools: ToolRegistry;
  events: SessionEventStore;
  promptRegistry: SystemPromptRegistry;
  store: JsonlOrchestrationStore;
  compactionStore?: SessionCompactionStore;
  maxSteps?: number;
  maxToolCalls?: number;
}

export interface ChildAgentInput {
  accountId: string;
  resourceScopeId: string;
  parentSessionId: string;
  parentTurnId: string;
  instruction: string;
  signal: AbortSignal;
}

export interface ChildAgentExecution {
  run: ChildAgentRun;
  result: AgentRunResult;
}

function boundedInstruction(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw Object.assign(new Error("Child-agent instruction cannot be empty."), { code: "ORCHESTRATION_INPUT_INVALID" });
  if (normalized.length > 6_000) throw Object.assign(new Error("Child-agent instruction exceeds 6000 characters."), { code: "ORCHESTRATION_INPUT_INVALID" });
  return normalized;
}

export class ChildAgentRunner {
  readonly #model: ModelClient | null;
  readonly #tools: ToolRegistry;
  readonly #events: SessionEventStore;
  readonly #promptRegistry: SystemPromptRegistry;
  readonly #store: JsonlOrchestrationStore;
  readonly #compactionStore: SessionCompactionStore | undefined;
  readonly #maxSteps: number;
  readonly #maxToolCalls: number;

  public constructor(options: ChildAgentRunnerOptions) {
    this.#model = options.model;
    this.#tools = options.tools;
    this.#events = options.events;
    this.#promptRegistry = options.promptRegistry;
    this.#store = options.store;
    this.#compactionStore = options.compactionStore;
    this.#maxSteps = Math.max(1, Math.min(12, options.maxSteps ?? 8));
    this.#maxToolCalls = Math.max(1, Math.min(24, options.maxToolCalls ?? 16));
  }

  public async run(input: ChildAgentInput): Promise<ChildAgentExecution> {
    if (this.#model === null) throw Object.assign(new Error("Child Agent requires a connected model gateway."), { code: "MODEL_AUTH_REQUIRED" });
    const instruction = boundedInstruction(input.instruction);
    const createdAt = new Date().toISOString();
    const runId = `childrun_${crypto.randomUUID().replaceAll("-", "")}`;
    const childSessionId = `child_${crypto.randomUUID().replaceAll("-", "")}`;
    const childTurnId = `turn_${crypto.randomUUID().replaceAll("-", "")}`;
    const running: ChildAgentRun = {
      id: runId,
      accountId: input.accountId,
      resourceScopeId: input.resourceScopeId,
      parentSessionId: input.parentSessionId,
      parentTurnId: input.parentTurnId,
      childSessionId,
      childTurnId,
      instruction,
      status: "running",
      finalText: "",
      createdAt,
      updatedAt: createdAt,
    };
    await this.#store.saveChildRun(running);

    const engine = new AgentEngine({
      model: this.#model,
      tools: this.#tools,
      events: this.#events,
      promptRegistry: this.#promptRegistry,
      maxSteps: this.#maxSteps,
      maxToolCalls: this.#maxToolCalls,
      ...(this.#compactionStore === undefined ? {} : { compactionStore: this.#compactionStore }),
    });
    const result = await engine.runTurn({
      accountId: input.accountId,
      scopeId: input.resourceScopeId,
      sessionId: childSessionId,
      turnId: childTurnId,
      userMessage: instruction,
      systemInstruction: [
        `You are a bounded child Agent delegated by parent session ${input.parentSessionId} turn ${input.parentTurnId}.`,
        "Complete only the delegated instruction. Do not broaden scope, invent parent decisions, or claim work outside your child tool evidence.",
        "You cannot delegate further because orchestration tools are intentionally not mounted in child runs.",
        "Return a concise factual result that the parent Agent can use as tool evidence.",
      ].join(" "),
      signal: input.signal,
    });
    const finished: ChildAgentRun = {
      ...running,
      status: result.status,
      finalText: result.finalText.slice(0, 12_000),
      updatedAt: new Date().toISOString(),
    };
    await this.#store.saveChildRun(finished);
    return { run: finished, result };
  }
}
