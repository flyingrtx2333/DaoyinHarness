import type { ExecutionIdentity } from "@daoyin/harness-contracts";
import type { AgentEvent } from "@daoyin/harness-protocol";
import type { MaybePromise } from "./repository.js";

export interface SessionSearchHit {
  readonly sessionId: string;
  readonly turnId: string;
  readonly sessionTitle: string;
  readonly userMessage: string;
  readonly assistantText: string;
  readonly eventSeqStart: number;
  readonly eventSeqEnd: number;
  readonly createdAt: string;
  readonly score: number;
}

export interface EpisodicEventPreview {
  readonly eventSeq: number;
  readonly eventId: string;
  readonly turnId: string;
  readonly type: AgentEvent["type"];
  readonly occurredAt: string;
  readonly text: string;
  readonly toolName?: string;
  readonly status?: string;
}

export interface SessionReadResult {
  readonly sessionId: string;
  readonly title: string;
  readonly events: readonly EpisodicEventPreview[];
  readonly hasMore: boolean;
  readonly nextAfterEventSeq: number | null;
}

export interface SessionTraceResult {
  readonly sessionId: string;
  readonly turnId: string;
  readonly userMessage: string;
  readonly finalText: string;
  readonly status: string;
  readonly events: readonly EpisodicEventPreview[];
}

export interface EpisodicMemoryRepository {
  search(identity: ExecutionIdentity, query: string, limit?: number): MaybePromise<SessionSearchHit[]>;
  read(identity: ExecutionIdentity, sessionId: string, afterEventSeq?: number, limit?: number): MaybePromise<SessionReadResult>;
  trace(identity: ExecutionIdentity, turnId: string, limit?: number): MaybePromise<SessionTraceResult>;
}

function bounded(value: string, max = 700): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().slice(0, max);
}

/** Historical data remains untrusted reference data; never project raw tool payloads. */
export function episodicEventPreview(event: AgentEvent): EpisodicEventPreview {
  let text = "";
  let toolName: string | undefined;
  let status: string | undefined;
  if (event.type === "turn.started") text = event.payload.userMessage;
  else if (event.type === "assistant.delta") text = event.payload.delta;
  else if (event.type === "tool.started") { toolName = event.payload.toolName; text = event.payload.displayText; status = "running"; }
  else if (event.type === "tool.completed") { toolName = event.payload.toolName; text = event.payload.summary; status = "completed"; }
  else if (event.type === "tool.failed") { toolName = event.payload.toolName; text = event.payload.message; status = "failed"; }
  else if (event.type === "turn.completed" || event.type === "turn.failed") { text = event.payload.outcomeSummary; status = event.payload.status; }
  else if (event.type === "turn.cancelled") { text = "任务已停止"; status = event.payload.status; }
  else if (event.type === "turn.interrupted") { text = "执行被中断"; status = event.payload.status; }
  return { eventSeq: event.eventSeq, eventId: event.id, turnId: event.turnId, type: event.type,
    occurredAt: event.occurredAt, text: bounded(text), ...(toolName ? { toolName } : {}), ...(status ? { status } : {}) };
}

export function episodicIndexText(event: AgentEvent): string {
  // The run document is seeded with the user message when the run is admitted.
  if (event.type === "tool.completed") return bounded(`${event.payload.toolName} ${event.payload.summary}`, 1_000);
  if (event.type === "tool.failed") return bounded(`${event.payload.toolName} ${event.payload.message}`, 1_000);
  if (event.type === "turn.completed" || event.type === "turn.failed") return bounded(event.payload.outcomeSummary, 2_000);
  return "";
}
