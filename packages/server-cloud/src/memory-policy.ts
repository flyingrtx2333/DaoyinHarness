import { assertExecutionIdentity, type ExecutionIdentity } from "@daoyin/harness-contracts";
import { CloudError } from "./repository.js";

export type DurableMemoryScope = "application" | "personal" | "organization";
export type DurableMemoryKind = "preference" | "fact" | "goal" | "decision" | "note";
export type DurableMemoryState = "pending" | "active" | "superseded" | "forgotten" | "rejected";
export type MemoryAuditAction = "proposed" | "confirmed" | "superseded" | "candidate_rejected" | "forgotten_chain" | "shared" | "share_revoked";
export interface MemorySource {
  kind: "user_edit" | "conversation";
  requestId: string;
  sessionId?: string;
  turnId?: string;
  eventId?: string;
}
export interface MemoryProposal {
  requestId: string;
  key: string;
  scope: DurableMemoryScope;
  kind: DurableMemoryKind;
  content: string;
  keywords?: string[];
  expiresAt?: number;
  replaces?: { id: string; revision: number };
}
export interface DurableMemory {
  id: string;
  revision: number;
  state: DurableMemoryState;
  key: string;
  scope: DurableMemoryScope;
  kind: DurableMemoryKind;
  content: string;
  keywords: string[];
  createdBy: string;
  originAppId: string;
  source: MemorySource;
  expiresAt: number | null;
  createdAt: number;
  supersedes: string | null;
}
export interface MemoryReference { id: string; revision: number; grantId: string | null }
export interface RecalledMemory { memory: DurableMemory; reference: MemoryReference; score: number; reasons: string[] }
/** Audit entries deliberately contain lifecycle metadata only, never memory body text. */
export interface MemoryAuditEntry {
  id: string;
  memoryId: string;
  revision: number;
  actorId: string;
  action: MemoryAuditAction;
  createdAt: number;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/u;
export function memoryId(value: unknown): value is string { return typeof value === "string" && ID.test(value); }
export function memoryPermission(identity: ExecutionIdentity, permission: string): void {
  assertExecutionIdentity(identity);
  if (identity.space.kind === "public" || !identity.permissions.includes(permission)) {
    throw new CloudError(403, "MEMORY_ACCESS_DENIED", "当前空间没有此项长期记忆权限。");
  }
}
export function memoryDomain(identity: ExecutionIdentity): string {
  assertExecutionIdentity(identity);
  if (identity.space.kind === "public") throw new CloudError(403, "MEMORY_ACCESS_DENIED", "公开入口不保存私人长期记忆。");
  return JSON.stringify([identity.space.kind, identity.space.id,
    identity.space.kind === "personal" ? identity.space.ownerUserId : identity.space.tenantId]);
}
export function memoryOwner(identity: ExecutionIdentity, scope: DurableMemoryScope): string {
  if (scope === "organization") {
    if (identity.space.kind !== "organization") throw new CloudError(403, "MEMORY_SCOPE_DENIED", "企业记忆必须在对应企业空间创建。");
    return `tenant:${identity.space.tenantId}`;
  }
  if (scope === "personal" && identity.space.kind !== "personal") {
    throw new CloudError(403, "MEMORY_SCOPE_DENIED", "不能把企业资料写入个人通用记忆。");
  }
  return `user:${identity.actorUserId}`;
}

export function normalizeMemoryProposal(value: MemoryProposal, now = Date.now()): MemoryProposal {
  if (!value || Object.keys(value).some((key) => !["requestId", "key", "scope", "kind", "content", "keywords", "expiresAt", "replaces"].includes(key)) ||
      !memoryId(value.requestId) || typeof value.key !== "string" || !value.key.trim() || value.key.length > 120 ||
      !["application", "personal", "organization"].includes(value.scope) ||
      !["preference", "fact", "goal", "decision", "note"].includes(value.kind) ||
      typeof value.content !== "string" || !value.content.trim() || value.content.length > 2000 || [...value.content].some((character) => character.charCodeAt(0) <= 8) ||
      (value.keywords !== undefined && (!Array.isArray(value.keywords) || value.keywords.length > 16 ||
        value.keywords.some((keyword) => typeof keyword !== "string" || keyword.length > 64))) ||
      (value.expiresAt !== undefined && (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + 365 * 86400_000)) ||
      (value.replaces !== undefined && (!value.replaces || !memoryId(value.replaces.id) || !Number.isSafeInteger(value.replaces.revision) || value.replaces.revision < 1))) {
    throw new CloudError(400, "MEMORY_INPUT_INVALID", "记忆内容、类型、有效期或版本无效。");
  }
  // Deterministic defense-in-depth only. User review and source authorization remain mandatory.
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b|(?:api[_ -]?key|access[_ -]?token|password|密码|密钥)\s*[:=：]\s*\S{6,}/iu.test(value.content)) {
    throw new CloudError(400, "MEMORY_SENSITIVE_CONTENT", "凭据和密码不能保存为长期记忆。");
  }
  return { ...value, key: value.key.normalize("NFKC").trim().toLocaleLowerCase(), content: value.content.trim(),
    keywords: [...new Set((value.keywords ?? []).map((item) => item.normalize("NFKC").trim()).filter(Boolean))] };
}

const stop = new Set(["的", "了", "我", "你", "我们", "这个", "那个", "一下", "什么", "怎么", "如何", "可以", "一个", "继续", "the", "and", "for", "with", "please", "this", "that"]);
export function memoryTokens(text: string): Set<string> {
  const result = new Set<string>();
  const normalized = text.normalize("NFKC").toLocaleLowerCase();
  for (const item of normalized.match(/[a-z0-9_][a-z0-9_-]{1,63}/gu) ?? []) if (!stop.has(item)) result.add(item);
  for (const run of normalized.match(/\p{Script=Han}+/gu) ?? []) {
    for (let index = 0; index + 1 < run.length; index += 1) {
      const token = run.slice(index, index + 2);
      if (!stop.has(token)) result.add(token);
    }
  }
  return result;
}

/** Invoked AFTER namespace/consent filtering; not vector or semantic retrieval. */
export function memoryRelevance(memory: DurableMemory, query: string, now = Date.now()): { score: number; reasons: string[] } | null {
  const needle = query.normalize("NFKC").trim().toLocaleLowerCase();
  if (needle.length < 2) return null;
  const tokens = memoryTokens(needle);
  const haystack = `${memory.key} ${memory.content} ${memory.keywords.join(" ")}`.normalize("NFKC").toLocaleLowerCase();
  const words = memoryTokens(haystack);
  const tags = memoryTokens(memory.keywords.join(" "));
  const overlap = [...tokens].filter((token) => words.has(token)).length;
  const tagOverlap = [...tokens].filter((token) => tags.has(token)).length;
  const phrase = haystack.includes(needle);
  if (!phrase && (overlap === 0 || overlap / Math.max(1, Math.min(tokens.size, 20)) < 0.12)) return null;
  const freshness = 1 / (1 + Math.max(0, now - memory.createdAt) / (90 * 86400_000));
  return { score: Math.round(((phrase ? 8 : 0) + Math.min(8, overlap) + Math.min(4, tagOverlap * 2) + freshness) * 1000) / 1000,
    reasons: [...(phrase ? ["phrase"] : []), `token_overlap:${overlap}`, ...(tagOverlap ? [`keyword_overlap:${tagOverlap}`] : [])] };
}
