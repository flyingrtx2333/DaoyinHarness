import type { AgentEvent, SessionCompaction } from "@daoyin/harness-protocol";
import type { SessionCompactionStore } from "@daoyin/harness-workspace";

export interface ContextCompactorOptions {
  store: SessionCompactionStore;
  retainRecentTurns?: number;
  triggerUncompactedTurns?: number;
  triggerCharacters?: number;
  maxSummaryCharacters?: number;
}

interface TurnProjection {
  turnId: string;
  startSeq: number;
  endSeq: number;
  user: string;
  assistant: string;
  status: string;
  tools: Array<Record<string, unknown>>;
}

function clip(value: string, max: number): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}…`;
}

function projectTurns(events: readonly AgentEvent[]): TurnProjection[] {
  const turns = new Map<string, TurnProjection>();
  const order: string[] = [];
  const toolInputs = new Map<string, unknown>();
  for (const event of events) {
    if (event.type === "turn.started") {
      turns.set(event.turnId, {
        turnId: event.turnId,
        startSeq: event.eventSeq,
        endSeq: event.eventSeq,
        user: event.payload.userMessage,
        assistant: "",
        status: "running",
        tools: [],
      });
      order.push(event.turnId);
      continue;
    }
    const turn = turns.get(event.turnId);
    if (turn === undefined) continue;
    turn.endSeq = Math.max(turn.endSeq, event.eventSeq);
    if (event.type === "assistant.delta") {
      turn.assistant += event.payload.delta;
    } else if (event.type === "tool.started") {
      toolInputs.set(event.payload.toolCallId, event.payload.input ?? null);
    } else if (event.type === "tool.completed") {
      turn.tools.push({
        tool: event.payload.toolName,
        status: "completed",
        input: toolInputs.get(event.payload.toolCallId) ?? null,
        summary: clip(event.payload.summary, 420),
        artifacts: event.payload.evidence.artifacts.slice(0, 5),
      });
    } else if (event.type === "tool.failed") {
      turn.tools.push({
        tool: event.payload.toolName,
        status: "failed",
        input: toolInputs.get(event.payload.toolCallId) ?? null,
        code: event.payload.code,
        message: clip(event.payload.message, 420),
        details: event.payload.details ?? null,
      });
    } else if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled") {
      turn.status = event.type.slice("turn.".length);
    }
  }
  return order.map((turnId) => turns.get(turnId)).filter((turn): turn is TurnProjection => turn !== undefined);
}

function turnSummary(turn: TurnProjection): Record<string, unknown> {
  return {
    turnId: turn.turnId,
    eventRange: [turn.startSeq, turn.endSeq],
    status: turn.status,
    user: clip(turn.user, 900),
    assistant: clip(turn.assistant, 1_100),
    tools: turn.tools.slice(-10),
  };
}

function buildSummary(previous: SessionCompaction | undefined, compactedTurns: TurnProjection[], maxCharacters: number): string {
  const blocks: string[] = [];
  if (previous !== undefined) {
    blocks.push(`Previous compacted context through eventSeq ${String(previous.sourceEndSeq)}:\n${previous.summary}`);
  }
  blocks.push(`Newly compacted turns:\n${JSON.stringify(compactedTurns.map(turnSummary))}`);
  let summary = blocks.join("\n\n");
  if (summary.length <= maxCharacters) return summary;

  const latestTurns = compactedTurns.slice(-Math.max(2, Math.min(8, compactedTurns.length)));
  const priorBudget = Math.max(1_500, Math.floor(maxCharacters * 0.38));
  const prior = previous?.summary ? clip(previous.summary, priorBudget) : "";
  const current = JSON.stringify(latestTurns.map(turnSummary));
  summary = [prior ? `Older compacted context (clipped):\n${prior}` : "", `Most recent compacted turns:\n${current}`]
    .filter(Boolean)
    .join("\n\n");
  return summary.length <= maxCharacters ? summary : summary.slice(0, maxCharacters);
}

export class ContextCompactor {
  readonly #store: SessionCompactionStore;
  readonly #retainRecentTurns: number;
  readonly #triggerUncompactedTurns: number;
  readonly #triggerCharacters: number;
  readonly #maxSummaryCharacters: number;

  public constructor(options: ContextCompactorOptions) {
    this.#store = options.store;
    this.#retainRecentTurns = Math.max(1, options.retainRecentTurns ?? 8);
    this.#triggerUncompactedTurns = Math.max(this.#retainRecentTurns + 1, options.triggerUncompactedTurns ?? 16);
    this.#triggerCharacters = Math.max(2_000, options.triggerCharacters ?? 32_000);
    this.#maxSummaryCharacters = Math.max(2_000, Math.min(20_000, options.maxSummaryCharacters ?? 12_000));
  }

  public async compactIfNeeded(sessionId: string, events: readonly AgentEvent[]): Promise<SessionCompaction | undefined> {
    const previous = await this.#store.latest(sessionId);
    const coveredSeq = previous?.sourceEndSeq ?? 0;
    const turns = projectTurns(events).filter((turn) => turn.endSeq > coveredSeq && turn.status !== "running");
    if (turns.length <= this.#retainRecentTurns) return previous;

    const compactable = turns.slice(0, Math.max(0, turns.length - this.#retainRecentTurns));
    const candidateEndSeq = compactable.at(-1)?.endSeq;
    if (candidateEndSeq === undefined || candidateEndSeq <= coveredSeq) return previous;
    const candidateEvents = events.filter((event) => event.eventSeq > coveredSeq && event.eventSeq <= candidateEndSeq);
    const characterLoad = candidateEvents.reduce((total, event) => total + JSON.stringify(event.payload).length, 0);
    if (turns.length < this.#triggerUncompactedTurns && characterLoad < this.#triggerCharacters) return previous;

    const summary = buildSummary(previous, compactable, this.#maxSummaryCharacters);
    return this.#store.append({
      sessionId,
      sourceStartSeq: previous?.sourceStartSeq ?? candidateEvents[0]?.eventSeq ?? 1,
      sourceEndSeq: candidateEndSeq,
      summary,
      strategy: "deterministic-trajectory-v1",
    });
  }
}
