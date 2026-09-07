import type { DatabaseSync } from "node:sqlite";
import { executionScopeKey, type ExecutionIdentity } from "@daoyin/harness-contracts";
import type { AgentEvent } from "@daoyin/harness-protocol";
import type { MemoryContextSnapshot } from "@daoyin/harness-agent-core";
import { CloudError } from "./repository.js";
import { memoryDomain, memoryId, memoryPermission, type MemoryReference, type MemorySource } from "./memory-policy.js";
import type { SqliteMemoryRepository } from "./memory-repository.js";
import { matchesOwnInvalidation, memoryContextText, type MemoryInvalidation } from "./memory-agent-policy.js";

export interface MemoryPreparation {
  sessionId: string;
  turnId: string;
  step: number;
  query: string;
  events: readonly AgentEvent[];
  /** Trusted run-local state only. Never accepted from an HTTP body/model argument. */
  ownInvalidations?: readonly MemoryInvalidation[];
  additionalReferences?: readonly MemoryReference[];
}
export interface MemoryUse extends MemoryReference { step: number; available: boolean; reasons: string[] }
const refKey = (ref: MemoryReference): string => JSON.stringify([ref.id, ref.revision, ref.grantId]);
const turnKey = (sessionId: string, turnId: string): string => JSON.stringify([sessionId, turnId]);
const changed = (): CloudError => new CloudError(409, "MEMORY_CONTEXT_CHANGED", "本轮引用的记忆或共享授权已改变，未继续使用旧内容。");
const tooLarge = (): CloudError => new CloudError(409, "MEMORY_HISTORY_LIMIT", "记忆依赖过多，请新建会话。");

/** Run inside a fenced transaction. References contain no memory text. */
export function prepareMemoryContext(db: DatabaseSync, memory: SqliteMemoryRepository, identity: ExecutionIdentity, input: MemoryPreparation): MemoryContextSnapshot {
  const domain = memoryDomain(identity);
  const consumer = executionScopeKey(identity);
  if (!memoryId(input.sessionId) || !memoryId(input.turnId) || !Number.isSafeInteger(input.step) || input.step < 0 || input.step > 100) throw changed();
  if ((input.ownInvalidations?.length ?? 0) > 500 || (input.additionalReferences?.length ?? 0) > 500) throw tooLarge();
  const run = db.prepare("SELECT 1 FROM cloud_runs WHERE scope_key=? AND session_id=? AND id=? AND status='running'")
    .get(consumer, input.sessionId, input.turnId);
  if (run === undefined) throw changed();
  const own = (ref: MemoryReference, source = false): boolean => matchesOwnInvalidation(
    db.prepare("SELECT id,revision,state FROM durable_memories WHERE id=? AND domain_key=?").get(ref.id, domain),
    ref, input.ownInvalidations, source);
  const dependencies: Array<{ sessionId: string; turnId: string; reference: MemoryReference }> = [];
  const sessions = new Set([input.sessionId, ...input.events.map((event) => event.sessionId)]);
  if (sessions.size > 50) throw tooLarge();
  const requested = new Set(input.events.map((event) => turnKey(event.sessionId, event.turnId)));
  requested.add(turnKey(input.sessionId, input.turnId));
  for (const sessionId of sessions) {
    if (db.prepare("SELECT 1 FROM cloud_sessions WHERE id=? AND scope_key=?").get(sessionId, consumer) === undefined) throw changed();
    const rows = db.prepare("SELECT DISTINCT session_id,turn_id,memory_id,revision,grant_id FROM memory_references WHERE consumer_scope=? AND session_id=? LIMIT 5001").all(consumer, sessionId);
    if (rows.length > 5000) throw tooLarge();
    for (const row of rows) if (requested.has(turnKey(String(row.session_id), String(row.turn_id)))) dependencies.push({
      sessionId: String(row.session_id), turnId: String(row.turn_id), reference: {
        id: String(row.memory_id), revision: Number(row.revision), grantId: row.grant_id ? String(row.grant_id) : null,
      },
    });
    if (dependencies.length > 5000) throw tooLarge();
  }
  const excluded = new Map<string, { sessionId: string; turnId: string }>();
  const retired = new Set<string>();
  for (const dep of dependencies) if (!memory.validReference(identity, dep.reference)) {
    if (dep.sessionId === input.sessionId && dep.turnId === input.turnId) {
      if (!own(dep.reference)) throw changed();
      retired.add(refKey(dep.reference));
    } else excluded.set(turnKey(dep.sessionId, dep.turnId), { sessionId: dep.sessionId, turnId: dep.turnId });
  }
  // Original user/tool sources are dependencies even when they did not match recall.
  const sources = db.prepare("SELECT id,revision,source FROM durable_memories WHERE domain_key=? AND origin_app=? AND state IN ('active','superseded','forgotten') AND (created_by=? OR memory_scope='organization')")
    .all(domain, identity.appInstallationId, identity.actorUserId);
  const sourceDependencies: Array<{ sessionId: string; turnId: string; reference: MemoryReference }> = [];
  for (const row of sources) {
    const source = JSON.parse(String(row.source)) as MemorySource;
    const ref = { id: String(row.id), revision: Number(row.revision), grantId: null };
    if (!source.sessionId || !source.turnId || !requested.has(turnKey(source.sessionId, source.turnId))) continue;
    if (!memory.validReference(identity, ref)) {
      if (source.sessionId === input.sessionId && source.turnId === input.turnId) {
        if (!own(ref, true)) throw changed();
      } else excluded.set(turnKey(source.sessionId, source.turnId), { sessionId: source.sessionId, turnId: source.turnId });
    } else sourceDependencies.push({ sessionId: source.sessionId, turnId: source.turnId, reference: ref });
  }
  const references = new Map<string, MemoryReference>();
  for (const dep of [...dependencies, ...sourceDependencies]) {
    if (!excluded.has(turnKey(dep.sessionId, dep.turnId)) && !retired.has(refKey(dep.reference))) references.set(refKey(dep.reference), dep.reference);
  }
  const reasons = new Map<string, string[]>();
  for (const ref of input.additionalReferences ?? []) {
    if (!memory.validReference(identity, ref)) {
      if (!own(ref)) throw changed();
      continue;
    }
    references.set(refKey(ref), ref);
    reasons.set(refKey(ref), ["tool_search_or_write"]);
  }
  const hits = identity.permissions.includes("memory.read") ? memory.search(identity, input.query.slice(0, 500), 6, true) : [];
  const records: Array<Record<string, unknown>> = [];
  for (const hit of hits) {
    const data = { reference: hit.reference, key: hit.memory.key, kind: hit.memory.kind, scope: hit.memory.scope,
      content: hit.memory.content, source: hit.memory.source, originAppId: hit.memory.originAppId, reasons: hit.reasons };
    if (JSON.stringify([...records, data]).length > 8000) continue;
    records.push(data);
    references.set(refKey(hit.reference), hit.reference);
    reasons.set(refKey(hit.reference), hit.reasons);
  }
  if (references.size > 500) throw tooLarge();
  const refs = [...references.values()];
  for (const ref of refs) db.prepare("INSERT OR IGNORE INTO memory_references VALUES (?,?,?,?,?,?,?,?,?)")
    .run(consumer, input.sessionId, input.turnId, input.step, ref.id, ref.revision, ref.grantId ?? "", JSON.stringify(reasons.get(refKey(ref)) ?? ["history_dependency"]), Date.now());
  return { text: memoryContextText(records, excluded.size, hits.length - records.length), excludedTurns: [...excluded.values()], assertCurrent: async (signal) => {
    signal.throwIfAborted();
    if (refs.some((ref) => !memory.validReference(identity, ref))) throw changed();
  } };
}

export function readMemoryUses(db: DatabaseSync, memory: SqliteMemoryRepository, identity: ExecutionIdentity, sessionId: string, turnId: string): MemoryUse[] {
  memoryPermission(identity, "memory.read");
  const consumer = executionScopeKey(identity);
  if (identity.space.kind === "public" || db.prepare("SELECT 1 FROM cloud_runs WHERE scope_key=? AND session_id=? AND id=?").get(consumer, sessionId, turnId) === undefined) {
    throw new CloudError(404, "MEMORY_NOT_FOUND", "记忆引用不存在或不可访问。");
  }
  const rows = db.prepare("SELECT * FROM memory_references WHERE consumer_scope=? AND session_id=? AND turn_id=? ORDER BY step,memory_id LIMIT 5001")
    .all(consumer, sessionId, turnId);
  if (rows.length > 5000) throw tooLarge();
  return rows.map((row) => {
    const reference = { id: String(row.memory_id), revision: Number(row.revision), grantId: row.grant_id ? String(row.grant_id) : null };
    return { ...reference, step: Number(row.step), available: memory.validReference(identity, reference), reasons: JSON.parse(String(row.reasons)) as string[] };
  });
}
