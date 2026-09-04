import type { JsonValue, MemoryKind, MemoryScope } from "@daoyin/harness-protocol";
import type { MemoryRecord, MemorySearchHit } from "@daoyin/harness-protocol";
import type { MemoryStore } from "@daoyin/harness-workspace";
import type { ToolDefinition, ToolExecutionContext, ToolSuccess } from "./registry.js";

const MEMORY_KINDS: readonly MemoryKind[] = ["preference", "fact", "goal", "decision", "note"];
const MEMORY_SCOPES: readonly MemoryScope[] = ["session", "resource", "account"];

const objectSchema = (properties: Record<string, JsonValue>, required: string[]): JsonValue => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

function success(toolName: string, summary: string, result: JsonValue): ToolSuccess {
  return { ok: true, summary, evidence: { schemaVersion: 1, toolName, result, artifacts: [], diagnostics: [] } };
}

function stringArgument(input: Record<string, unknown>, name: string): string {
  const value = input[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw Object.assign(new Error(`${name} must be a non-empty string.`), { code: "TOOL_INPUT_INVALID" });
  }
  return value.trim();
}

function optionalStringArray(input: Record<string, unknown>, name: string): string[] {
  const value = input[name];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw Object.assign(new Error(`${name} must be an array of strings.`), { code: "TOOL_INPUT_INVALID" });
  }
  return value.map((item) => String(item).trim()).filter(Boolean).slice(0, 32);
}

function optionalConfidence(input: Record<string, unknown>): number | undefined {
  const value = input.confidence;
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw Object.assign(new Error("confidence must be a number between 0 and 1."), { code: "TOOL_INPUT_INVALID" });
  }
  return value;
}

function enumArgument<T extends string>(input: Record<string, unknown>, name: string, allowed: readonly T[]): T {
  const value = input[name];
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw Object.assign(new Error(`${name} must be one of: ${allowed.join(", ")}.`), { code: "TOOL_INPUT_INVALID" });
  }
  return value as T;
}

function scopeId(scope: MemoryScope, context: ToolExecutionContext): string {
  if (scope === "session") return context.sessionId;
  if (scope === "resource") return context.scopeId;
  return context.accountId;
}

function memoryAllowed(record: MemoryRecord, context: ToolExecutionContext): boolean {
  if (record.accountId !== context.accountId) return false;
  if (record.scope === "session") return record.scopeId === context.sessionId;
  if (record.scope === "resource") return record.scopeId === context.scopeId;
  return record.scopeId === context.accountId;
}

function hitView(hit: MemorySearchHit): JsonValue {
  return {
    id: hit.record.id,
    scope: hit.record.scope,
    kind: hit.record.kind,
    content: hit.record.content,
    keywords: hit.record.keywords,
    confidence: hit.record.confidence,
    sourceEventIds: hit.record.sourceEventIds,
    createdAt: hit.record.createdAt,
    score: hit.score,
    reasons: hit.reasons,
  };
}

export function createMemoryTools(store: MemoryStore): ToolDefinition[] {
  return [
    {
      name: "memory_search",
      description: "Search provenance-bound local memory visible to the current account/session/resource. Use it when stable prior preferences, decisions, goals, or facts may materially help the current task.",
      category: "system",
      mutating: false,
      inputSchema: objectSchema({
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 12 },
      }, ["query"]),
      async execute(input, _signal, context) {
        const query = stringArgument(input, "query");
        const rawLimit = input.limit;
        const limit = rawLimit === undefined ? 5 : Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 12) {
          throw Object.assign(new Error("limit must be an integer between 1 and 12."), { code: "TOOL_INPUT_INVALID" });
        }
        const hits = await store.search({
          accountId: context.accountId,
          sessionId: context.sessionId,
          resourceScopeId: context.scopeId,
          query,
          limit,
        });
        return success("memory_search", `Found ${String(hits.length)} relevant memories.`, { hits: hits.map(hitView) });
      },
    },
    {
      name: "memory_remember",
      description: "Persist one stable, reusable memory with provenance. Use only when the user explicitly asks to remember something or when a durable preference/decision/goal is clearly useful beyond the current message. Do not store secrets, transient tool output, speculative inferences, or large copied text.",
      category: "system",
      mutating: true,
      inputSchema: objectSchema({
        scope: { type: "string", enum: [...MEMORY_SCOPES] },
        kind: { type: "string", enum: [...MEMORY_KINDS] },
        content: { type: "string" },
        keywords: { type: "array", items: { type: "string" }, maxItems: 32 },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      }, ["scope", "kind", "content"]),
      async execute(input, _signal, context) {
        if (context.sourceEventIds.length === 0) {
          throw Object.assign(new Error("Memory cannot be stored without source event provenance."), { code: "MEMORY_PROVENANCE_REQUIRED" });
        }
        const scope = enumArgument(input, "scope", MEMORY_SCOPES);
        const kind = enumArgument(input, "kind", MEMORY_KINDS);
        const confidence = optionalConfidence(input);
        const record = await store.append({
          accountId: context.accountId,
          scope,
          scopeId: scopeId(scope, context),
          kind,
          content: stringArgument(input, "content"),
          keywords: optionalStringArray(input, "keywords"),
          ...(confidence === undefined ? {} : { confidence }),
          sourceEventIds: context.sourceEventIds,
        });
        return success("memory_remember", `Stored ${record.scope} ${record.kind} memory.`, {
          id: record.id,
          scope: record.scope,
          kind: record.kind,
          content: record.content,
          sourceEventIds: record.sourceEventIds,
        });
      },
    },
    {
      name: "memory_update",
      description: "Supersede one visible memory with a corrected version while preserving append-only history and provenance. Use when a prior stable memory is explicitly corrected or replaced.",
      category: "system",
      mutating: true,
      inputSchema: objectSchema({
        memoryId: { type: "string" },
        content: { type: "string" },
        kind: { type: "string", enum: [...MEMORY_KINDS] },
        keywords: { type: "array", items: { type: "string" }, maxItems: 32 },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      }, ["memoryId", "content"]),
      async execute(input, _signal, context) {
        const memoryId = stringArgument(input, "memoryId");
        const prior = await store.get(memoryId);
        if (prior === undefined) throw Object.assign(new Error("Memory does not exist."), { code: "MEMORY_NOT_FOUND" });
        if (!memoryAllowed(prior, context)) throw Object.assign(new Error("Memory is outside the current authorized scope."), { code: "MEMORY_SCOPE_DENIED" });
        const kind = input.kind === undefined ? prior.kind : enumArgument(input, "kind", MEMORY_KINDS);
        const record = await store.append({
          accountId: context.accountId,
          scope: prior.scope,
          scopeId: prior.scopeId,
          kind,
          content: stringArgument(input, "content"),
          keywords: input.keywords === undefined ? prior.keywords : optionalStringArray(input, "keywords"),
          confidence: optionalConfidence(input) ?? prior.confidence,
          sourceEventIds: context.sourceEventIds,
          supersedes: prior.id,
        });
        return success("memory_update", `Superseded memory ${prior.id}.`, {
          id: record.id,
          supersedes: prior.id,
          scope: record.scope,
          kind: record.kind,
          content: record.content,
        });
      },
    },
    {
      name: "memory_forget",
      description: "Forget one visible stored memory by appending a tombstone. This never rewrites the historical record, but the forgotten memory stops participating in normal retrieval.",
      category: "system",
      mutating: true,
      inputSchema: objectSchema({ memoryId: { type: "string" } }, ["memoryId"]),
      async execute(input, _signal, context) {
        const memoryId = stringArgument(input, "memoryId");
        const prior = await store.get(memoryId);
        if (prior === undefined) throw Object.assign(new Error("Memory does not exist."), { code: "MEMORY_NOT_FOUND" });
        if (!memoryAllowed(prior, context)) throw Object.assign(new Error("Memory is outside the current authorized scope."), { code: "MEMORY_SCOPE_DENIED" });
        const tombstone = await store.append({
          accountId: context.accountId,
          scope: prior.scope,
          scopeId: prior.scopeId,
          kind: prior.kind,
          content: "",
          keywords: [],
          confidence: 1,
          sourceEventIds: context.sourceEventIds,
          supersedes: prior.id,
          tombstone: true,
        });
        return success("memory_forget", `Forgot memory ${prior.id}.`, { id: prior.id, tombstoneId: tombstone.id });
      },
    },
  ];
}
