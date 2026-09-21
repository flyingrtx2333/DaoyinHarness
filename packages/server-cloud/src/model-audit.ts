import type { JsonValue } from "@daoyin/harness-protocol";
import type { ModelReply, ModelRequest } from "@daoyin/harness-agent-core";

const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|passwd|secret|token|api[-_]?key|access[-_]?key)/iu;
const SENSITIVE_TEXT = /(?:bearer\s+[a-z0-9._~+/-]{8,}|\bsk-[a-z0-9_-]{8,}\b)/giu;
const MAX_STRING = 32_000;
const MAX_TOTAL = 92_000;

interface AuditBudget { remaining: number; truncated: boolean }

function text(value: string, budget: AuditBudget): string {
  const redacted = value.replace(SENSITIVE_TEXT, "[REDACTED]");
  const allowed = Math.max(0, Math.min(MAX_STRING, budget.remaining));
  const result = redacted.length <= allowed ? redacted : `${redacted.slice(0, Math.max(0, allowed - 1))}…`;
  budget.remaining -= result.length;
  if (result.length !== redacted.length) budget.truncated = true;
  return result;
}

function value(input: unknown, budget: AuditBudget, key = "", depth = 0): JsonValue {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (input === null || typeof input === "boolean") return input;
  if (typeof input === "string") return text(input, budget);
  if (typeof input === "number") return Number.isFinite(input) ? input : String(input);
  if (depth >= 12 || budget.remaining <= 0) { budget.truncated = true; return "[TRUNCATED]"; }
  if (Array.isArray(input)) {
    if (input.length > 200) budget.truncated = true;
    return input.slice(0, 200).map(item => value(item, budget, "", depth + 1));
  }
  if (typeof input === "object") {
    const entries = Object.entries(input as Record<string, unknown>);
    if (entries.length > 200) budget.truncated = true;
    return Object.fromEntries(entries.slice(0, 200).map(([name, item]) => [name, value(item, budget, name, depth + 1)]));
  }
  return text(String(input), budget);
}

export function requestedAudit(request: ModelRequest, modelCallId: string, callIndex: number, targetRunId: string) {
  const budget: AuditBudget = { remaining: MAX_TOTAL, truncated: false };
  const systemPrompt = {
    stableText: text(request.systemPrompt.stableText, budget),
    dynamicText: text(request.systemPrompt.dynamicText, budget),
  };
  const messages = request.messages.map(message => value(message, budget));
  const tools = request.tools.map(tool => ({ name: tool.name, description: text(tool.description, budget) }));
  return { modelCallId, callIndex, targetRunId, systemPrompt, messages, tools, truncated: budget.truncated };
}

export function respondedAudit(reply: ModelReply, modelCallId: string, callIndex: number, targetRunId: string, latencyMs: number) {
  const budget: AuditBudget = { remaining: MAX_TOTAL, truncated: false };
  return { modelCallId, callIndex, targetRunId, status: "completed" as const, latencyMs,
    reply: value(reply, budget), truncated: budget.truncated };
}

export function failedAudit(error: unknown, modelCallId: string, callIndex: number, targetRunId: string, latencyMs: number) {
  const candidate = error as { code?: unknown; message?: unknown; name?: unknown };
  const cancelled = candidate?.name === "AbortError";
  const failureCode = typeof candidate?.code === "string" ? candidate.code.slice(0, 80) : cancelled ? "MODEL_CANCELLED" : "MODEL_REQUEST_FAILED";
  const rawMessage = typeof candidate?.message === "string" ? candidate.message : "模型请求未完成。";
  const budget: AuditBudget = { remaining: 2_000, truncated: false };
  return { modelCallId, callIndex, targetRunId, status: cancelled ? "cancelled" as const : "failed" as const,
    latencyMs, failureCode, failureMessage: text(rawMessage, budget), truncated: budget.truncated };
}
