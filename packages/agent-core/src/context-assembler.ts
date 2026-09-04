import type { AgentEvent, SessionCompaction } from "@daoyin/harness-protocol";
import type { ToolDescriptor } from "@daoyin/harness-tools";
import type { AgentTurnInput } from "./agent-engine.js";
import type { ModelConversationItem } from "./model.js";
import { SystemPromptRegistry, type PromptAssembly } from "./prompt-registry.js";

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

interface HistoricalTurn {
  user: string;
  assistant: string;
}

export class ContextAssembler {
  readonly #promptRegistry: SystemPromptRegistry;
  readonly #historyMaxTurns: number;
  readonly #historyMaxCharacters: number;

  public constructor(options: ContextAssemblerOptions) {
    this.#promptRegistry = options.promptRegistry;
    this.#historyMaxTurns = options.historyMaxTurns ?? 24;
    this.#historyMaxCharacters = options.historyMaxCharacters ?? 48_000;
  }

  #historicalTurns(events: readonly AgentEvent[], compaction?: SessionCompaction): HistoricalTurn[] {
    const turns: HistoricalTurn[] = [];
    const indexes = new Map<string, number>();
    const minimumSeq = compaction?.sourceEndSeq ?? 0;
    for (const event of events) {
      if (event.eventSeq <= minimumSeq) continue;
      if (event.type === "turn.started") {
        indexes.set(event.turnId, turns.length);
        turns.push({ user: event.payload.userMessage, assistant: "" });
        continue;
      }
      if (event.type !== "assistant.delta") continue;
      const index = indexes.get(event.turnId);
      if (index === undefined) continue;
      const turn = turns[index];
      if (turn !== undefined) turn.assistant += event.payload.delta;
    }
    return turns;
  }

  #boundedDialogue(turns: readonly HistoricalTurn[]): ModelConversationItem[] {
    const selected: HistoricalTurn[] = [];
    let characters = 0;
    for (let index = turns.length - 1; index >= 0 && selected.length < this.#historyMaxTurns; index -= 1) {
      const turn = turns[index];
      if (turn === undefined) continue;
      const size = turn.user.length + turn.assistant.length;
      if (selected.length > 0 && characters + size > this.#historyMaxCharacters) break;
      selected.push(turn);
      characters += size;
    }
    selected.reverse();

    const messages: ModelConversationItem[] = [];
    for (const turn of selected) {
      messages.push({ role: "user", content: turn.user });
      if (turn.assistant.trim().length > 0) messages.push({ role: "assistant", content: turn.assistant });
    }
    return messages;
  }

  public historicalDialogue(events: readonly AgentEvent[], compaction?: SessionCompaction): ModelConversationItem[] {
    return this.#boundedDialogue(this.#historicalTurns(events, compaction));
  }

  public historicalDialogueSources(
    sources: readonly { events: readonly AgentEvent[]; compaction?: SessionCompaction }[],
  ): ModelConversationItem[] {
    const turns = sources.flatMap((source) => this.#historicalTurns(source.events, source.compaction));
    return this.#boundedDialogue(turns);
  }

  public async assembleStep(input: StepContextInput): Promise<StepContextAssembly> {
    const prompt = await this.#promptRegistry.assemble({
      accountId: input.turn.accountId,
      scopeId: input.turn.scopeId,
      sessionId: input.turn.sessionId,
      turnId: input.turn.turnId,
      userMessage: input.turn.userMessage,
      ...(input.turn.systemInstruction === undefined ? {} : { systemInstruction: input.turn.systemInstruction }),
      step: input.step,
      priorEvents: input.priorEvents,
      ...(input.inheritedEvents === undefined ? {} : { inheritedEvents: input.inheritedEvents }),
      ...(input.compaction === undefined ? {} : { compaction: input.compaction }),
      tools: input.tools,
    });
    return {
      prompt,
      systemMessage: { role: "system", content: prompt.text },
    };
  }
}
