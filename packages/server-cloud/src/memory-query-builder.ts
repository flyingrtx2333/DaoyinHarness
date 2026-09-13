import type { AgentEvent } from "@daoyin/harness-protocol";
import { memoryTokens } from "./memory-policy.js";

export interface MemoryQueryBuildInput {
  readonly userMessage: string;
  readonly recentEvents: readonly AgentEvent[];
  readonly profileId: string;
  readonly step: number;
  readonly goal?: { readonly title?: string; readonly objective?: string };
}

export interface MemoryBuiltQuery {
  readonly rawQuery: string;
  readonly retrievalQuery: string;
  readonly terms: readonly string[];
  readonly reasons: readonly string[];
  readonly confidence: "high" | "medium" | "low";
}

const CONTINUATION = /^(?:继续|接着|继续吧|接着来|按之前(?:的|那个)?(?:方案)?|照之前(?:的|那个)?(?:方案)?|continue)(?:[。.!！?？]+)?$/iu;
const REFERENTIAL = /(?:这个|那个|它|刚才|之前|上次|前面|方案呢|第(?:[一二三四五六七八九十]|\d+)(?:个|种|套|条)?)/u;

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function recentUserMessages(events: readonly AgentEvent[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const event of [...events].reverse()) {
    if (event.type !== "turn.started") continue;
    const value = normalize(event.payload.userMessage);
    if (value.length < 2 || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length >= 3) break;
  }
  return result;
}

function boundedJoin(parts: readonly string[], max = 500): string {
  let result = "";
  for (const part of parts) {
    const value = normalize(part);
    if (!value) continue;
    const next = result ? `${result} ｜ ${value}` : value;
    if (next.length > max) break;
    result = next;
  }
  return result.slice(0, max);
}

/** Deterministic retrieval rewrite only. It never alters the actual user message sent to the model. */
export function buildMemoryQuery(input: MemoryQueryBuildInput): MemoryBuiltQuery {
  const rawQuery = normalize(input.userMessage).slice(0, 500);
  const recent = recentUserMessages(input.recentEvents).filter((item) => item !== rawQuery);
  const reasons = ["raw_query", `profile:${normalize(input.profileId).slice(0, 80) || "unknown"}`, `step:${String(input.step)}`];
  const continuation = CONTINUATION.test(rawQuery);
  const referential = REFERENTIAL.test(rawQuery) && rawQuery.length <= 32;
  const terse = rawQuery.length <= 12;
  let retrievalQuery = rawQuery;
  let confidence: MemoryBuiltQuery["confidence"] = rawQuery.length >= 4 ? "high" : "medium";

  if ((continuation || referential || terse) && recent.length > 0) {
    const history = continuation ? recent.slice(0, 1) : recent.slice(0, 2);
    retrievalQuery = boundedJoin([rawQuery, ...history]);
    reasons.push("recent_turn_context");
    confidence = continuation || referential ? "medium" : confidence;
  } else if ((continuation || referential) && recent.length === 0) {
    reasons.push("unresolved_reference");
    confidence = "low";
  }

  const goalParts = [input.goal?.title ?? "", input.goal?.objective ?? ""].map(normalize).filter(Boolean);
  if (goalParts.length > 0 && (confidence !== "high" || retrievalQuery.length < 40)) {
    retrievalQuery = boundedJoin([retrievalQuery, ...goalParts]);
    reasons.push("goal_context");
    if (confidence === "low") confidence = "medium";
  }

  const terms = [...memoryTokens(retrievalQuery)].slice(0, 32);
  return { rawQuery, retrievalQuery, terms, reasons, confidence };
}
