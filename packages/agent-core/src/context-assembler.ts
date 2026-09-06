import type { AgentEvent, SessionCompaction } from "@daoyin/harness-protocol";
import type { ToolDescriptor } from "@daoyin/harness-tools";
import type { AgentTurnInput } from "./agent-engine.js";
import type { ModelConversationItem } from "./model.js";
import { SystemPromptRegistry, type PromptAssembly } from "./prompt-registry.js";
import { sessionContextSections } from "./session-context.js";

export interface ContextAssemblerOptions {
  promptRegistry: SystemPromptRegistry;
  historyMaxTurns?: number;
  historyMaxCharacters?: number;
}

export interface StepContextInput {
  turn: AgentTurnInput;
  priorEvents: readonly AgentEvent[];
  inheritedEvents?: readonly AgentEvent[];
  compaction?: SessionCompaction;
  step: number;
  tools: readonly ToolDescriptor[];
}

export interface StepContextAssembly {
  prompt: PromptAssembly;
  systemMessage: ModelConversationItem;
}

interface HistoricalTurn { user: string; assistant: string }

function clip(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const suffix = "\n[Historical text truncated; original transcript retained.]";
  const end = Math.max(0, budget - suffix.length);
  const code = text.charCodeAt(end - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? end - 1 : end) + suffix;
}

export class ContextAssembler {
  readonly #promptRegistry: SystemPromptRegistry;
  readonly #historyMaxTurns: number;
  readonly #historyMaxCharacters: number;

  public constructor(options: ContextAssemblerOptions) {
    this.#promptRegistry = options.promptRegistry;
    // Profiles may replace behavior, but must not accidentally discard persisted session context.
    for (const section of sessionContextSections()) {
      if (!this.#promptRegistry.hasSection(section.id)) this.#promptRegistry.register(section);
    }
    if (!this.#promptRegistry.hasSection("turn_instruction")) this.#promptRegistry.register({
      id: "turn_instruction", kind: "dynamic", priority: 1900,
      render: ({ systemInstruction }) => systemInstruction?.trim() || null,
    });
    this.#historyMaxTurns = options.historyMaxTurns ?? 24;
    this.#historyMaxCharacters = options.historyMaxCharacters ?? 48_000;
    if (!Number.isSafeInteger(this.#historyMaxTurns) || this.#historyMaxTurns < 1 || this.#historyMaxTurns > 100 ||
        !Number.isSafeInteger(this.#historyMaxCharacters) || this.#historyMaxCharacters < 1024 || this.#historyMaxCharacters > 200_000) {
      throw new Error("Invalid historical context limits.");
    }
  }

  #historicalTurns(events: readonly AgentEvent[], compaction?: SessionCompaction): HistoricalTurn[] {
    const turns = new Map<string, HistoricalTurn>();
    const minimumSeq = compaction?.sourceEndSeq ?? 0;
    for (const event of events) {
      if (event.eventSeq <= minimumSeq) continue;
      const key = JSON.stringify([event.sessionId, event.turnId]);
      if (event.type === "turn.started") {
        if (!turns.has(key)) turns.set(key, { user: event.payload.userMessage, assistant: "" });
        continue;
      }
      const turn = turns.get(key);
      if (turn === undefined) continue;
      if (event.type === "assistant.delta") turn.assistant += event.payload.delta;
      else if (event.type === "turn.completed" || event.type === "turn.failed") {
        if (!turn.assistant.trim()) turn.assistant = event.payload.outcomeSummary;
        if (event.type === "turn.failed") turn.assistant += `\n[Recorded turn status: failed; code=${event.payload.code}]`;
      } else if (event.type === "turn.cancelled" || event.type === "turn.interrupted") {
        turn.assistant += `\n[Recorded turn status: ${event.payload.status}. Partial output is not proof of completion; do not automatically repeat external work.]`;
      }
    }
    return [...turns.values()];
  }

  #boundedDialogue(turns: readonly HistoricalTurn[]): ModelConversationItem[] {
    const selected: HistoricalTurn[] = [];
    let characters = 0;
    for (let index = turns.length - 1; index >= 0 && selected.length < this.#historyMaxTurns; index -= 1) {
      const turn = turns[index];
      if (turn === undefined) continue;
      const size = turn.user.length + turn.assistant.length;
      if (characters + size > this.#historyMaxCharacters) {
        if (!selected.length) {
          const userBudget = Math.min(turn.user.length, Math.floor(this.#historyMaxCharacters / 2));
          selected.push({ user: clip(turn.user, userBudget), assistant: clip(turn.assistant, this.#historyMaxCharacters - userBudget) });
        }
        break;
      }
      selected.push(turn);
      characters += size;
    }
    const messages: ModelConversationItem[] = [];
    for (const turn of selected.reverse()) {
      messages.push({ role: "user", content: turn.user });
      if (turn.assistant.trim()) messages.push({ role: "assistant", content: turn.assistant });
    }
    return messages;
  }

  public historicalDialogue(events: readonly AgentEvent[], compaction?: SessionCompaction): ModelConversationItem[] {
    return this.#boundedDialogue(this.#historicalTurns(events, compaction));
  }

  public historicalDialogueSources(sources: readonly { events: readonly AgentEvent[]; compaction?: SessionCompaction }[]): ModelConversationItem[] {
    return this.#boundedDialogue(sources.flatMap((source) => this.#historicalTurns(source.events, source.compaction)));
  }

  public async assembleStep(input: StepContextInput): Promise<StepContextAssembly> {
    const prompt = await this.#promptRegistry.assemble({
      accountId: input.turn.accountId, scopeId: input.turn.scopeId,
      sessionId: input.turn.sessionId, turnId: input.turn.turnId, userMessage: input.turn.userMessage,
      ...(input.turn.systemInstruction === undefined ? {} : { systemInstruction: input.turn.systemInstruction }),
      step: input.step, priorEvents: input.priorEvents,
      ...(input.inheritedEvents === undefined ? {} : { inheritedEvents: input.inheritedEvents }),
      ...(input.compaction === undefined ? {} : { compaction: input.compaction }),
      tools: input.tools,
    });
    return { prompt, systemMessage: { role: "system", content: prompt.text } };
  }
}
