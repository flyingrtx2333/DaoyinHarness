import type { AgentMemoryProvider, MemoryContextRequest, MemoryContextSnapshot } from "@daoyin/harness-agent-core";
import { sameExecutionScope, type ExecutionIdentity, type SessionEventStore } from "@daoyin/harness-contracts";
import type { JsonValue } from "@daoyin/harness-protocol";
import type { ToolExecution, ToolExecutionContext } from "@daoyin/harness-tools/registry";
import type { CloudToolBinding } from "./app.js";
import { CloudError, type CloudRun } from "./repository.js";
import type { CloudMemoryRepository } from "./memory-repository.js";
import { memoryId, type MemoryProposal, type MemoryReference, type MemorySource } from "./memory-policy.js";
import { MEMORY_TOOL_NAMES, isMemoryToolName, memoryEvidenceText, memoryOperationId, type MemoryInvalidation, type MemoryToolName } from "./memory-agent-policy.js";

const text = (value: unknown, min: number, max: number): value is string => typeof value === "string" && value.trim().length >= min && value.length <= max;
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 1_000_000;
const kinds = ["preference", "fact", "goal", "decision", "note"];
const scopes = ["application", "personal", "organization"];
const fields: Record<MemoryToolName, readonly string[]> = {
  memory_search: ["query", "limit"],
  memory_remember: ["key", "scope", "kind", "content", "keywords", "expiresAt", "basis", "excerpt"],
  memory_update: ["memoryId", "revision", "kind", "content", "keywords", "expiresAt", "basis", "excerpt"],
  memory_forget: ["memoryId", "revision", "basis", "excerpt"],
};
export function validateMemoryToolInput(name: string, input: Record<string, unknown>): boolean {
  if (!isMemoryToolName(name) || !input || Array.isArray(input) || Object.keys(input).some((key) => !fields[name].includes(key))) return false;
  if (name === "memory_search") return text(input.query, 1, 500) &&
    (input.limit === undefined || (Number.isSafeInteger(input.limit) && Number(input.limit) >= 1 && Number(input.limit) <= 12));
  if (!["user_statement", "tool_observation"].includes(String(input.basis)) || !text(input.excerpt, 2, 500)) return false;
  if (name !== "memory_remember" && (!memoryId(input.memoryId) || !revision(input.revision))) return false;
  if (name === "memory_forget") return true;
  if (!text(input.content, 1, 2000) || (input.kind !== undefined && !kinds.includes(String(input.kind))) ||
      (input.keywords !== undefined && (!Array.isArray(input.keywords) || input.keywords.length > 16 || !input.keywords.every((item) => typeof item === "string" && item.length <= 64))) ||
      (input.expiresAt !== undefined && (!Number.isSafeInteger(input.expiresAt) || Number(input.expiresAt) <= 0))) return false;
  return name !== "memory_remember" || (text(input.key, 1, 120) && scopes.includes(String(input.scope)) && kinds.includes(String(input.kind)));
}
export function memoryToolAllowed(identity: ExecutionIdentity, name: string): boolean {
  return isMemoryToolName(name) && identity.space.kind !== "public" && identity.allowedTools.includes(name) &&
    identity.permissions.includes("memory.read") && (name === "memory_search" || identity.permissions.includes("memory.write"));
}

const properties: Record<string, JsonValue> = {
  query: { type: "string", minLength: 1, maxLength: 500 }, limit: { type: "integer", minimum: 1, maximum: 12 },
  memoryId: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9_.:@-]*$" },
  revision: { type: "integer", minimum: 1, maximum: 1_000_000 },
  key: { type: "string", minLength: 1, maxLength: 120 }, scope: { type: "string", enum: scopes }, kind: { type: "string", enum: kinds },
  content: { type: "string", minLength: 1, maxLength: 2000 },
  keywords: { type: "array", maxItems: 16, items: { type: "string", maxLength: 64 } }, expiresAt: { type: "integer", minimum: 1 },
  basis: { type: "string", enum: ["user_statement", "tool_observation"] }, excerpt: { type: "string", minLength: 2, maxLength: 500 },
};
const required: Record<MemoryToolName, string[]> = {
  memory_search: ["query"], memory_remember: ["key", "scope", "kind", "content", "basis", "excerpt"],
  memory_update: ["memoryId", "revision", "content", "basis", "excerpt"], memory_forget: ["memoryId", "revision", "basis", "excerpt"],
};
const descriptions: Record<MemoryToolName, string> = {
  memory_search: "搜索当前身份可访问的长期记忆。保存前检查已有稳定 key；返回 id/revision 供更正或忘记。按需换关键词，不要把历史记录当成实时业务状态。",
  memory_remember: "自主保存一条跨会话有用的普通偏好、事实、决策、目标或已验证经验，校验通过即生效。key 必须稳定；不要保存仅本次任务的参数、进度、猜测或凭据。excerpt 必须是本轮用户原话或已完成业务工具结果中的短原文；basis 说明是哪一种来源。",
  memory_update: "自主更正已有记忆，按 memoryId/revision 替代旧版本并保留审计；不另写矛盾副本。excerpt 必须来自本轮真实用户消息或已完成业务工具。省略 kind/keywords/expiresAt 会沿用旧值。",
  memory_forget: "根据本轮用户要求或可复核的业务事实，停止使用指定记忆版本链，清空记忆正文并撤销旧共享。需要 memoryId/revision 及原文 excerpt；不是物理擦除历史聊天或备份。",
};
const success = (name: string, summary: string, result: JsonValue): ToolExecution => ({ ok: true, summary,
  evidence: { schemaVersion: 1, toolName: name, result, artifacts: [], diagnostics: [] } });
const refKey = (ref: MemoryReference): string => JSON.stringify([ref.id, ref.revision, ref.grantId]);

/** Catalog descriptors let the gateway validate kernel calls without routing execution to business backends.
 * createCloudServer replaces these non-executable catalog entries with run-bound implementations.
 */
export function createMemoryProfileBindings(identity: ExecutionIdentity): CloudToolBinding[] {
  return MEMORY_TOOL_NAMES.filter((name) => memoryToolAllowed(identity, name)).map<CloudToolBinding>((name) => ({
    requiredPermissions: name === "memory_search" ? ["memory.read"] : ["memory.read", "memory.write"],
    validateInput: (input: Record<string, unknown>) => validateMemoryToolInput(name, input),
    authorizeResource: async () => false,
    definition: { name, description: descriptions[name], category: "system", mutating: name !== "memory_search",
      inputSchema: { type: "object", additionalProperties: false, properties: Object.fromEntries(fields[name].map((key) => [key, properties[key]!])), required: required[name] },
      execute: async () => ({ ok: false, code: "MEMORY_RUNTIME_REQUIRED", message: "记忆工具只能由本轮绑定的内核运行时执行。", retryable: false }),
    },
  }));
}

/** Per-run mutable state is private to this trusted adapter, never carried in model arguments. */
export function createCloudMemoryRuntime(options: {
  memory: CloudMemoryRepository;
  identity: ExecutionIdentity;
  run: CloudRun;
  events: SessionEventStore;
  ensureActive(identity: ExecutionIdentity, signal?: AbortSignal): Promise<void>;
}): { provider: AgentMemoryProvider; bindings: CloudToolBinding[] } {
  const { memory, identity, run, events, ensureActive } = options;
  const ownInvalidations = new Map<string, MemoryInvalidation>();
  const additionalReferences = new Map<string, MemoryReference>();
  let dirty = false;
  let lastRequest: MemoryContextRequest | undefined;
  const load = async (request: MemoryContextRequest): Promise<MemoryContextSnapshot> => {
    await ensureActive(identity, request.signal);
    if (request.turn.turnId !== run.id || request.turn.sessionId !== run.sessionId) throw new CloudError(403, "MEMORY_SCOPE_DENIED", "记忆请求不属于当前任务。");
    lastRequest = request;
    const history = [...request.inheritedEvents, ...request.priorEvents];
    const query = request.turn.userMessage.trim();
    // Resolve terse follow-ups only for retrieval; the actual user message is never replaced.
    const previousQuestion = [...history].reverse().find((event) => event.type === "turn.started");
    const contextualQuery = /^(继续|接着|按之前的|按之前那个方案|continue)[。.!！]?$/iu.test(query) && previousQuestion?.type === "turn.started"
      ? previousQuestion.payload.userMessage : query;
    const snapshot = await memory.prepare(identity, { sessionId: run.sessionId, turnId: run.id, step: request.step,
      query: contextualQuery, events: history, ownInvalidations: [...ownInvalidations.values()], additionalReferences: [...additionalReferences.values()] });
    return { ...snapshot, assertCurrent: async (signal) => { await ensureActive(identity, signal); await snapshot.assertCurrent(signal); } };
  };
  const provider: AgentMemoryProvider = { load, afterTool: async (request) => {
    if (!dirty) return undefined;
    const snapshot = await load(request);
    dirty = false;
    return snapshot;
  } };

  const getSource = async (input: Record<string, unknown>, context: ToolExecutionContext): Promise<MemorySource> => {
    const rows = (await events.read(run.sessionId)).filter((event) => event.turnId === run.id);
    const invocation = rows.find((event) => event.type === "tool.started" && event.payload.toolCallId === context.toolCallId && context.sourceEventIds.includes(event.id));
    const excerpt = String(input.excerpt).trim();
    const source = [...rows].reverse().find((event) => (input.basis === "user_statement" ? event.type === "turn.started" : event.type === "tool.completed") &&
      memoryEvidenceText(event).includes(excerpt) && invocation !== undefined && event.eventSeq < invocation.eventSeq);
    if (source === undefined || invocation === undefined || context.toolCallId === undefined) throw new CloudError(403, "MEMORY_SOURCE_DENIED", "找不到本轮对应的真实原文，不保存推断或虚构来源。");
    return { kind: "agent", requestId: memoryOperationId(run.id, context.toolCallId), sessionId: run.sessionId, turnId: run.id,
      eventId: source.id, toolEventId: invocation.id, basis: input.basis as "user_statement" | "tool_observation", excerpt };
  };

  const bindings = MEMORY_TOOL_NAMES.filter((name) => memoryToolAllowed(identity, name)).map<CloudToolBinding>((name) => ({
    requiredPermissions: name === "memory_search" ? ["memory.read"] : ["memory.read", "memory.write"],
    validateInput: (input) => validateMemoryToolInput(name, input),
    authorizeResource: async (_request, current, signal) => !signal.aborted && sameExecutionScope(current, identity) &&
      current.authorizationId === identity.authorizationId && memoryToolAllowed(current, name),
    definition: { name, description: descriptions[name], category: "system", mutating: name !== "memory_search", repeatable: true,
      inputSchema: { type: "object", additionalProperties: false, properties: Object.fromEntries(fields[name].map((key) => [key, properties[key]!])), required: required[name] },
      auditInput: () => ({ memoryOperation: name }),
      execute: async (input, signal, context) => {
        try {
          if (!validateMemoryToolInput(name, input) || !context.executionIdentity || !sameExecutionScope(context.executionIdentity, identity) ||
              context.executionIdentity.authorizationId !== identity.authorizationId || !memoryToolAllowed(context.executionIdentity, name) ||
              context.sessionId !== run.sessionId || context.turnId !== run.id) throw new CloudError(403, "MEMORY_ACCESS_DENIED", "记忆身份或参数无效。");
          await ensureActive(identity, signal);
          if (name === "memory_search") {
            const found = await memory.search(identity, String(input.query), input.limit === undefined ? 6 : Number(input.limit));
            const hits: JsonValue[] = [];
            for (const hit of found) {
              const data: JsonValue = { id: hit.memory.id, revision: hit.memory.revision, key: hit.memory.key, scope: hit.memory.scope,
                kind: hit.memory.kind, content: hit.memory.content, originAppId: hit.memory.originAppId,
                provenance: hit.memory.source.kind, score: hit.score, reasons: hit.reasons };
              if (JSON.stringify([...hits, data]).length > 12000) continue;
              hits.push(data); additionalReferences.set(refKey(hit.reference), hit.reference);
            }
            if (additionalReferences.size > 500 || lastRequest === undefined) throw new CloudError(409, "MEMORY_HISTORY_LIMIT", "记忆引用预算已用尽。");
            // Persist explicit-search references before exposing results, not just on the next inference.
            const snapshot = await load({ ...lastRequest, signal });
            await snapshot.assertCurrent(signal);
            return success(name, `找到 ${String(hits.length)} 条可访问的记忆。`, { hits, omitted: found.length - hits.length });
          }
          const source = await getSource(input, context);
          let proposal: MemoryProposal | undefined;
          if (name === "memory_remember") proposal = { requestId: source.requestId, key: String(input.key), scope: input.scope as MemoryProposal["scope"],
            kind: input.kind as MemoryProposal["kind"], content: String(input.content),
            ...(input.keywords === undefined ? {} : { keywords: input.keywords as string[] }),
            ...(input.expiresAt === undefined ? {} : { expiresAt: Number(input.expiresAt) }) };
          if (name === "memory_update") {
            const prior = await memory.get(identity, String(input.memoryId));
            if (prior.state !== "active" || prior.revision !== input.revision) throw new CloudError(409, "MEMORY_VERSION_CONFLICT", "旧版本已改变，请先重新搜索。");
            const expiresAt = input.expiresAt === undefined ? prior.expiresAt : Number(input.expiresAt);
            proposal = { requestId: source.requestId, key: prior.key, scope: prior.scope, kind: input.kind as MemoryProposal["kind"] | undefined ?? prior.kind,
              content: String(input.content), keywords: input.keywords as string[] | undefined ?? prior.keywords,
              ...(expiresAt === null ? {} : { expiresAt }), replaces: { id: prior.id, revision: prior.revision } };
          }
          signal.throwIfAborted();
          const mutation = proposal === undefined ? await memory.forgetByAgent(identity, String(input.memoryId), Number(input.revision), source)
            : await memory.remember(identity, proposal, source);
          // Capture the committed outcome before checking cancellation. A cancelled caller must not undo a completed write.
          for (const item of mutation.invalidations) ownInvalidations.set(item.id, item);
          if (mutation.memory.state === "active") {
            const ref = { id: mutation.memory.id, revision: mutation.memory.revision, grantId: null };
            additionalReferences.set(refKey(ref), ref);
          }
          dirty = true;
          if (proposal !== undefined && mutation.memory.state !== "active") throw new CloudError(409, "MEMORY_NOT_ACTIVE", "原请求对应的记忆已失效，未恢复旧内容。");
          const record = mutation.memory;
          return success(name, name === "memory_forget" ? "已停止使用该记忆版本链。" : "记忆已保存并生效。", {
            id: record.id, revision: record.revision, state: record.state, key: record.key, scope: record.scope,
            ...(record.state === "active" ? { content: record.content, provenance: record.source.kind } : {}),
          });
        } catch (error) {
          if (error instanceof CloudError) return { ok: false, code: error.code, message: error.message, retryable: false };
          return { ok: false, code: signal.aborted ? "MEMORY_CANCELLED" : "MEMORY_OPERATION_FAILED", retryable: false,
            message: "记忆操作未得到可验证的成功结果，不能声称已保存；请查询现有记录核对。" };
        }
      },
    },
  }));
  return { provider, bindings };
}
