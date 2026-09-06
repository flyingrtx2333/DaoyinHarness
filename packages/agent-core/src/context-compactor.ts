import type { AgentEvent, JsonValue, SessionCompaction } from "@daoyin/harness-protocol";
import type { SessionCompactionStore } from "@daoyin/harness-contracts";
import { AgentPolicyError } from "./loop-policy.js";
import { contextPreview } from "./model-tool-result.js";
import { sessionEvidence } from "./session-context.js";

export interface ContextCompactorOptions {
  store: SessionCompactionStore;
  retainRecentTurns?: number;
  triggerUncompactedTurns?: number;
  triggerCharacters?: number;
  maxSummaryCharacters?: number;
}

interface TurnProjection {
  turnId: string; startSeq: number; endSeq: number;
  user: string; assistant: string; status: string; events: AgentEvent[];
}

function clip(value: string, max: number): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (normalized.length <= max) return normalized;
  const end = max - 1;
  const code = normalized.charCodeAt(end - 1);
  return normalized.slice(0, code >= 0xd800 && code <= 0xdbff ? end - 1 : end) + "…";
}

function projectTurns(events: readonly AgentEvent[]): TurnProjection[] {
  const turns = new Map<string, TurnProjection>();
  for (const event of events) {
    if (event.type === "turn.started") {
      if (turns.has(event.turnId)) throw new AgentPolicyError("AGENT_HISTORY_INVALID", "历史存在重复回合起点，未压缩原始记录。");
      turns.set(event.turnId, { turnId: event.turnId, startSeq: event.eventSeq, endSeq: event.eventSeq,
        user: event.payload.userMessage, assistant: "", status: "running", events: [event] });
      continue;
    }
    const turn = turns.get(event.turnId);
    if (turn === undefined) continue;
    turn.endSeq = Math.max(turn.endSeq, event.eventSeq);
    turn.events.push(event);
    if (event.type === "assistant.delta") turn.assistant += event.payload.delta;
    else if (event.type === "turn.completed" || event.type === "turn.failed") {
      turn.status = event.payload.status;
      if (!turn.assistant.trim()) turn.assistant = event.payload.outcomeSummary;
    } else if (event.type === "turn.cancelled" || event.type === "turn.interrupted") turn.status = event.payload.status;
  }
  return [...turns.values()];
}

function turnSummary(turn: TurnProjection): JsonValue {
  return {
    turnId: turn.turnId, eventRange: [turn.startSeq, turn.endSeq], status: turn.status,
    user: clip(turn.user, 900), assistant: clip(turn.assistant, 1100),
    tools: sessionEvidence(turn.events).slice(-6).map((item) => JSON.parse(contextPreview(item, 700)) as JsonValue),
  };
}

function buildSummary(previous: SessionCompaction | undefined, turns: TurnProjection[], maxCharacters: number): string {
  let older: JsonValue[] = [];
  let previouslyOmitted = 0;
  let legacySummary: string | null = null;
  if (previous !== undefined) {
    try {
      const parsed = JSON.parse(previous.summary) as Record<string, unknown>;
      if (parsed.schemaVersion !== 2 || !Array.isArray(parsed.turns)) throw new Error("Legacy summary");
      older = parsed.turns as JsonValue[];
      previouslyOmitted = Number.isSafeInteger(parsed.omittedTurns) && Number(parsed.omittedTurns) >= 0 ? Number(parsed.omittedTurns) : 0;
      legacySummary = typeof parsed.legacySummary === "string" ? clip(parsed.legacySummary, 800) : null;
    } catch {
      // Old summaries remain opaque, explicitly clipped reference text; never parse partial JSON as facts.
      legacySummary = clip(previous.summary, 800);
    }
  }
  const candidates = [...turns.slice().reverse().map(turnSummary), ...older];
  const selected: JsonValue[] = [];
  const encode = (): string => JSON.stringify({ schemaVersion: 2, order: "newest_first",
    omittedTurns: previouslyOmitted + candidates.length - selected.length, legacySummary, turns: selected });
  for (const candidate of candidates) {
    selected.push(JSON.parse(contextPreview(candidate, Math.min(4000, maxCharacters - 1100))) as JsonValue);
    if (encode().length > maxCharacters) { selected.pop(); break; }
  }
  return encode();
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
    this.#triggerCharacters = Math.max(2000, options.triggerCharacters ?? 32_000);
    this.#maxSummaryCharacters = Math.max(2000, Math.min(20_000, options.maxSummaryCharacters ?? 12_000));
    if (![this.#retainRecentTurns, this.#triggerUncompactedTurns, this.#triggerCharacters, this.#maxSummaryCharacters].every(Number.isSafeInteger)) {
      throw new Error("Invalid compaction limits.");
    }
  }

  public async compactIfNeeded(sessionId: string, events: readonly AgentEvent[]): Promise<SessionCompaction | undefined> {
    const previous = await this.#store.latest(sessionId);
    if (events.some((event) => event.sessionId !== sessionId) || (previous !== undefined && previous.sessionId !== sessionId)) {
      throw new AgentPolicyError("AGENT_HISTORY_SCOPE_MISMATCH", "历史与当前会话不匹配。");
    }
    const coveredSeq = previous?.sourceEndSeq ?? 0;
    const all = projectTurns(events).filter((turn) => turn.endSeq > coveredSeq);
    const terminalPrefix: TurnProjection[] = [];
    for (let index = 0; index < all.length; index += 1) {
      const turn = all[index];
      if (turn === undefined || turn.status === "running" || turn.startSeq <= coveredSeq) break;
      // A scalar watermark must never cover part of an interleaved or unfinished turn.
      const next = all[index + 1];
      if (next !== undefined && turn.endSeq >= next.startSeq) break;
      terminalPrefix.push(turn);
    }
    if (terminalPrefix.length <= this.#retainRecentTurns) return previous;
    const compactable = terminalPrefix.slice(0, -this.#retainRecentTurns);
    const candidateEndSeq = compactable.at(-1)?.endSeq;
    if (candidateEndSeq === undefined || candidateEndSeq <= coveredSeq) return previous;
    const candidateEvents = events.filter((event) => event.eventSeq > coveredSeq && event.eventSeq <= candidateEndSeq);
    const characters = candidateEvents.reduce((total, event) => total + JSON.stringify(event.payload).length, 0);
    if (terminalPrefix.length < this.#triggerUncompactedTurns && characters < this.#triggerCharacters) return previous;
    return this.#store.append({
      sessionId, sourceStartSeq: previous?.sourceStartSeq ?? candidateEvents[0]?.eventSeq ?? 1,
      sourceEndSeq: candidateEndSeq, summary: buildSummary(previous, compactable, this.#maxSummaryCharacters),
      strategy: "deterministic-trajectory-v2",
    });
  }
}
