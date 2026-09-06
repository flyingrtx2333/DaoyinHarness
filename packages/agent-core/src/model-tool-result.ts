import type { JsonValue } from "@daoyin/harness-protocol";
import type { ToolExecution } from "@daoyin/harness-tools";

export const MAX_MODEL_TOOL_RESULT_CHARACTERS = 24_000;
const TRUNCATED = "…[truncated]";

function prefix(value: string, length: number): string {
  // JavaScript counts UTF-16 units. Do not leave half an astral character.
  const last = value.charCodeAt(length - 1);
  return value.slice(0, last >= 0xd800 && last <= 0xdbff ? length - 1 : length);
}

function boundedString(value: string, budget: number): string {
  if (JSON.stringify(value).length <= budget) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (JSON.stringify(prefix(value, middle) + TRUNCATED).length <= budget) low = middle;
    else high = middle - 1;
  }
  return prefix(value, low) + TRUNCATED;
}

function boundedJson(value: JsonValue, budget: number, depth = 0): JsonValue {
  if (JSON.stringify(value).length <= budget) return value;
  if (depth >= 12 || budget < 32) return null;
  if (typeof value === "string") return boundedString(value, budget);
  if (Array.isArray(value)) {
    const entries: JsonValue[] = [];
    let remaining = budget - 2;
    for (const item of value) {
      const size = JSON.stringify(item).length + (entries.length === 0 ? 0 : 1);
      // Keep paths, search matches and other array entries whole and usable.
      if (size > remaining) break;
      entries.push(item);
      remaining -= size;
    }
    return entries;
  }
  if (typeof value === "object" && value !== null) {
    const entries: [string, JsonValue][] = [];
    let remaining = budget - 2;
    for (const [key, item] of Object.entries(value)) {
      const overhead = JSON.stringify(key).length + 1 + (entries.length === 0 ? 0 : 1);
      if (remaining - overhead < 4) break;
      const preview = boundedJson(item, remaining - overhead, depth + 1);
      entries.push([key, preview]);
      remaining -= overhead + JSON.stringify(preview).length;
    }
    return Object.fromEntries(entries);
  }
  return null;
}

/** Valid JSON even when clipped, with explicit omissions rather than a cut JSON string. */
export function contextPreview(value: JsonValue, maxCharacters: number): string {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 256) throw new Error("Invalid context preview budget.");
  const serialized = JSON.stringify(value);
  if (serialized.length <= maxCharacters) return serialized;
  const envelope = { truncated: true, originalCharacters: serialized.length };
  const preview = boundedJson(value, maxCharacters - JSON.stringify(envelope).length - 16);
  return JSON.stringify({ ...envelope, preview });
}

export function modelToolResult(result: ToolExecution, maxCharacters = MAX_MODEL_TOOL_RESULT_CHARACTERS): string {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1024 || maxCharacters > MAX_MODEL_TOOL_RESULT_CHARACTERS) {
    throw new Error("Invalid tool result context budget.");
  }
  const complete = result.ok
    ? { ok: true, summary: result.summary, result: result.evidence.result }
    : { ok: false, code: result.code, message: result.message, retryable: result.retryable, ...(result.details === undefined ? {} : { details: result.details }) };
  const serialized = JSON.stringify(complete);
  if (serialized.length <= maxCharacters) return serialized;

  const modelContext = {
    truncated: true,
    originalCharacters: serialized.length,
    notice: "Partial tool result for model context only. Full evidence remains in the append-only transcript. Do not treat omitted entries as absent or this preview as exhaustive. Narrow the directory or search query to retrieve relevant details; do not repeat the same broad request.",
  };
  const textBudget = Math.min(1024, Math.floor(maxCharacters / 8));
  if (result.ok) {
    const envelope = { ok: true, summary: boundedString(result.summary, textBudget), modelContext };
    const budget = maxCharacters - JSON.stringify(envelope).length - 16;
    return JSON.stringify({ ...envelope, result: boundedJson(result.evidence.result, budget) });
  }
  const envelope = { ok: false, code: boundedString(result.code, 128), message: boundedString(result.message, textBudget), retryable: result.retryable, modelContext };
  const budget = maxCharacters - JSON.stringify(envelope).length - 16;
  return JSON.stringify({ ...envelope, ...(result.details === undefined ? {} : { details: boundedJson(result.details, budget) }) });
}
