import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { executionScopeKey, type ExecutionIdentity } from "@daoyin/harness-contracts";
import type { AgentEvent } from "@daoyin/harness-protocol";
import { CloudError, type MaybePromise } from "./repository.js";
import {
  memoryDomain, memoryId, memoryOwner, memoryPermission, normalizeMemoryProposal,
  type DurableMemory, type MemoryAuditAction, type MemoryAuditEntry, type MemoryProposal, type MemoryReference,
  type MemorySource, type RecalledMemory,
} from "./memory-policy.js";

import { prepareMemoryContext, readMemoryUses, type MemoryPreparation, type MemoryUse } from "./memory-runtime.js";
import type { MemoryContextSnapshot } from "@daoyin/harness-agent-core";
import { agentSourceShape, verifyAgentSource, recallRelevance, rankMemoryHits, type MemoryMutation, type MemoryInvalidation } from "./memory-agent-policy.js";

/** Implementations may be synchronous (local SQLite) or asynchronous (cloud PostgreSQL). */
export interface CloudMemoryRepository {
  /** Trusted runtime entrypoints; not human confirmation routes. */
  remember(identity: ExecutionIdentity, raw: MemoryProposal, source: MemorySource): MaybePromise<MemoryMutation>;
  forgetByAgent(identity: ExecutionIdentity, id: string, revision: number, source: MemorySource): MaybePromise<MemoryMutation>;
  propose(identity: ExecutionIdentity, raw: MemoryProposal, source?: MemorySource): MaybePromise<DurableMemory>;
  confirm(identity: ExecutionIdentity, id: string, revision: number): MaybePromise<DurableMemory>;
  reject(identity: ExecutionIdentity, id: string, revision: number): MaybePromise<DurableMemory>;
  forget(identity: ExecutionIdentity, id: string, revision: number): MaybePromise<DurableMemory>;
  get(identity: ExecutionIdentity, id: string): MaybePromise<DurableMemory>;
  share(identity: ExecutionIdentity, id: string, revision: number, targetAppId: string, expiresAt: number): MaybePromise<{ id: string; expiresAt: number }>;
  revokeShare(identity: ExecutionIdentity, grantId: string): MaybePromise<void>;
  list(identity: ExecutionIdentity, offset?: number): MaybePromise<{ items: DurableMemory[]; hasMore: boolean }>;
  search(identity: ExecutionIdentity, query: string, limit?: number): MaybePromise<RecalledMemory[]>;
  prepare(identity: ExecutionIdentity, input: MemoryPreparation): MaybePromise<MemoryContextSnapshot>;
  references(identity: ExecutionIdentity, sessionId: string, turnId: string): MaybePromise<MemoryUse[]>;
  shares(identity: ExecutionIdentity, id: string): MaybePromise<Array<{ id: string; revision: number; targetAppId: string; expiresAt: number; revoked: boolean }>>;
  audit(identity: ExecutionIdentity, id: string, offset?: number): MaybePromise<{ items: MemoryAuditEntry[]; hasMore: boolean }>;
}

type Row = Record<string, unknown>;
type Transaction = <T>(operation: () => T) => T;
const uid = (prefix: string): string => `${prefix}_${randomUUID().replaceAll("-", "")}`;
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const missing = (): CloudError => new CloudError(404, "MEMORY_NOT_FOUND", "记忆不存在或当前身份无权访问。");
const conflict = (): CloudError => new CloudError(409, "MEMORY_VERSION_CONFLICT", "记忆已改变，请重新读取并确认最新版本。");

function view(row: Row): DurableMemory {
  return { id: String(row.id), revision: Number(row.revision), state: row.state as DurableMemory["state"],
    key: String(row.fact_key), scope: row.memory_scope as DurableMemory["scope"], kind: row.kind as DurableMemory["kind"],
    content: String(row.content), keywords: JSON.parse(String(row.keywords)) as string[], createdBy: String(row.created_by),
    originAppId: String(row.origin_app), source: JSON.parse(String(row.source)) as MemorySource,
    expiresAt: row.expires_at === null ? null : Number(row.expires_at), createdAt: Number(row.created_at),
    supersedes: row.supersedes === null ? null : String(row.supersedes) };
}

/** SQL mutations use the parent repository's fenced transaction. No network or model calls. */
export class SqliteMemoryRepository {
  public constructor(private readonly db: DatabaseSync, private readonly transaction: Transaction) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS durable_memories (
        id TEXT PRIMARY KEY, domain_key TEXT NOT NULL, owner_key TEXT NOT NULL, origin_app TEXT NOT NULL,
        created_by TEXT NOT NULL, root_key TEXT NOT NULL, fact_key TEXT NOT NULL, memory_scope TEXT NOT NULL,
        kind TEXT NOT NULL, content TEXT NOT NULL, keywords TEXT NOT NULL, source TEXT NOT NULL,
        revision INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','active','superseded','forgotten','rejected')),
        supersedes TEXT, replaces_revision INTEGER, created_at INTEGER NOT NULL, expires_at INTEGER
      ) STRICT;
      CREATE INDEX IF NOT EXISTS durable_memory_scope ON durable_memories(domain_key,owner_key,origin_app,state);
      CREATE UNIQUE INDEX IF NOT EXISTS durable_memory_active_key ON durable_memories(root_key) WHERE state='active';
      CREATE TABLE IF NOT EXISTS memory_requests (
        request_key TEXT PRIMARY KEY, input_hash TEXT NOT NULL, memory_id TEXT NOT NULL REFERENCES durable_memories(id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS memory_shares (
        id TEXT PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES durable_memories(id), revision INTEGER NOT NULL,
        target_app TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL, created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS memory_share_target ON memory_shares(memory_id,revision,target_app,revoked,expires_at);
      CREATE TABLE IF NOT EXISTS memory_audit (
        id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, revision INTEGER NOT NULL, actor_id TEXT NOT NULL,
        action TEXT NOT NULL, created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS memory_audit_record ON memory_audit(memory_id,created_at DESC,id DESC);
      CREATE TABLE IF NOT EXISTS memory_references (
        consumer_scope TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT NOT NULL, step INTEGER NOT NULL,
        memory_id TEXT NOT NULL, revision INTEGER NOT NULL, grant_id TEXT NOT NULL,
        reasons TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(consumer_scope,session_id,turn_id,step,memory_id,revision,grant_id)
      ) STRICT;
    `);
  }

  #audit(identity: ExecutionIdentity, record: DurableMemory, action: MemoryAuditAction): void {
    this.db.prepare("INSERT INTO memory_audit VALUES (?,?,?,?,?,?)")
      .run(uid("ma"), record.id, record.revision, identity.actorUserId, action, Date.now());
  }
  #row(id: string, domain: string): Row {
    if (!memoryId(id)) throw missing();
    const row = this.db.prepare("SELECT * FROM durable_memories WHERE id=? AND domain_key=?").get(id, domain);
    if (row === undefined) throw missing();
    return row;
  }
  #managed(identity: ExecutionIdentity, id: string): Row {
    memoryPermission(identity, "memory.write");
    const row = this.#row(id, memoryDomain(identity));
    if (row.origin_app !== identity.appInstallationId || row.owner_key !== memoryOwner(identity, row.memory_scope as DurableMemory["scope"])) throw missing();
    if (row.memory_scope === "organization") memoryPermission(identity, "memory.organization.write");
    return row;
  }
  #source(identity: ExecutionIdentity, requestId: string, source?: MemorySource): MemorySource {
    if (source === undefined) return { kind: "user_edit", requestId };
    if (source.kind !== "conversation" || source.requestId !== requestId || !memoryId(source.sessionId) ||
        !memoryId(source.turnId) || !memoryId(source.eventId)) throw new CloudError(400, "MEMORY_SOURCE_INVALID", "记忆来源无效。");
    const row = this.db.prepare(`SELECT e.body FROM cloud_events e JOIN cloud_runs r ON r.id=e.turn_id AND r.session_id=e.session_id
      WHERE e.event_id=? AND e.session_id=? AND e.turn_id=? AND r.scope_key=?`)
      .get(source.eventId, source.sessionId, source.turnId, executionScopeKey(identity));
    const event = row === undefined ? undefined : JSON.parse(String(row.body)) as AgentEvent;
    if (event?.type !== "turn.started") throw new CloudError(403, "MEMORY_SOURCE_DENIED", "只能引用当前身份可访问的原始用户消息。");
    return { kind: "conversation", requestId, sessionId: source.sessionId, turnId: source.turnId, eventId: source.eventId };
  }

  #agentSource(identity: ExecutionIdentity, source: MemorySource, operation: "remember" | "forget"): MemorySource {
    if (!agentSourceShape(source)) throw new CloudError(403, "MEMORY_SOURCE_DENIED", "自主记忆缺少真实来源。");
    const readEvent = (id: string): AgentEvent | undefined => {
      const row = this.db.prepare(`SELECT e.body FROM cloud_events e JOIN cloud_runs r ON r.id=e.turn_id AND r.session_id=e.session_id
        WHERE e.event_id=? AND e.session_id=? AND e.turn_id=? AND r.scope_key=? AND r.status='running'`)
        .get(id, source.sessionId, source.turnId, executionScopeKey(identity));
      return row === undefined ? undefined : JSON.parse(String(row.body)) as AgentEvent;
    };
    return verifyAgentSource(source, readEvent(source.eventId), readEvent(source.toolEventId), operation);
  }

  public propose(identity: ExecutionIdentity, raw: MemoryProposal, source?: MemorySource): DurableMemory {
    return this.#save(identity, raw, source, false).memory;
  }

  public remember(identity: ExecutionIdentity, raw: MemoryProposal, source: MemorySource): MemoryMutation {
    return this.#save(identity, raw, source, true);
  }

  #save(identity: ExecutionIdentity, raw: MemoryProposal, source: MemorySource | undefined, automatic: boolean): MemoryMutation {
    memoryPermission(identity, "memory.write");
    const input = normalizeMemoryProposal(raw);
    const domain = memoryDomain(identity);
    const owner = memoryOwner(identity, input.scope);
    if (input.scope === "organization") memoryPermission(identity, "memory.organization.write");
    return this.transaction(() => {
      if (automatic && (source === undefined || source.requestId !== input.requestId)) throw conflict();
      const provenance = automatic ? this.#agentSource(identity, source!, "remember") : this.#source(identity, input.requestId, source);
      const requestKey = hash([executionScopeKey(identity), input.requestId]);
      const fingerprint = hash([input.key, input.scope, input.kind, input.content, input.keywords,
        input.expiresAt ?? null, input.replaces?.id ?? null, input.replaces?.revision ?? null, provenance]);
      const previous = this.db.prepare("SELECT * FROM memory_requests WHERE request_key=?").get(requestKey);
      if (previous !== undefined) {
        if (previous.input_hash !== fingerprint) throw conflict();
        return { memory: view(this.#managed(identity, String(previous.memory_id))), invalidations: [] };
      }
      const rootKey = hash([domain, owner, identity.appInstallationId, input.scope, input.key]);
      let supersedes: string | null = null;
      const invalidations: MemoryInvalidation[] = [];
      if (input.replaces !== undefined) {
        const old = this.#managed(identity, input.replaces.id);
        if (old.state !== "active" || old.revision !== input.replaces.revision || old.root_key !== rootKey) throw conflict();
        supersedes = input.replaces.id;
        if (automatic) {
          this.db.prepare("UPDATE durable_memories SET state='superseded',revision=revision+1 WHERE id=?").run(supersedes);
          this.db.prepare("UPDATE memory_shares SET revoked=1 WHERE memory_id=?").run(supersedes);
          invalidations.push({ id: supersedes, throughRevision: Number(old.revision), revision: Number(old.revision) + 1, state: "superseded" });
          this.#audit(identity, view(this.#row(supersedes, domain)), "superseded");
        }
      } else {
        const existing = this.db.prepare(`SELECT * FROM durable_memories WHERE root_key=? AND state<>'rejected'
          ORDER BY CASE state WHEN 'active' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,created_at DESC,id DESC LIMIT 1`).get(rootKey);
        if (existing !== undefined && existing.state === "forgotten" && automatic) {
          // Only a NEW human proposal may restore a forgotten stable key. Never resurrect by automatic extraction.
          throw new CloudError(409, "MEMORY_FORGOTTEN", "该记忆已被忘记；自动写入不会恢复，请由用户明确重新保存。");
        }
        if (existing !== undefined && existing.state !== "forgotten") {
          if ((existing.state === "active" || (!automatic && existing.state === "pending")) && existing.content === input.content && existing.kind === input.kind &&
              existing.keywords === JSON.stringify(input.keywords) && existing.expires_at === (input.expiresAt ?? null)) {
            this.db.prepare("INSERT INTO memory_requests VALUES (?,?,?)").run(requestKey, fingerprint, String(existing.id));
            return { memory: view(existing), invalidations: [] };
          }
          throw conflict();
        }
      }
      const count = this.db.prepare("SELECT COUNT(*) AS n FROM durable_memories WHERE domain_key=?").get(domain);
      if (Number(count?.n) >= 5000) throw new CloudError(429, "MEMORY_CAPACITY", "当前空间的记忆容量已达上限。");
      const id = uid("mem");
      this.db.prepare(`INSERT INTO durable_memories
        (id,domain_key,owner_key,origin_app,created_by,root_key,fact_key,memory_scope,kind,content,keywords,source,
        revision,state,supersedes,replaces_revision,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?)`)
        .run(id, domain, owner, identity.appInstallationId, identity.actorUserId, rootKey, input.key, input.scope,
          input.kind, input.content, JSON.stringify(input.keywords), JSON.stringify(provenance), automatic ? "active" : "pending", supersedes,
          input.replaces?.revision ?? null, Date.now(), input.expiresAt ?? null);
      this.db.prepare("INSERT INTO memory_requests VALUES (?,?,?)").run(requestKey, fingerprint, id);
      const result = view(this.#row(id, domain));
      this.#audit(identity, result, automatic ? (supersedes === null ? "agent_saved" : "agent_updated") : "proposed");
      return { memory: result, invalidations };
    });
  }

  public forgetByAgent(identity: ExecutionIdentity, id: string, revision: number, source: MemorySource): MemoryMutation {
    memoryPermission(identity, "memory.write");
    return this.transaction(() => {
      const provenance = this.#agentSource(identity, source, "forget");
      const requestKey = hash([executionScopeKey(identity), source.requestId]);
      const fingerprint = hash(["agent_forget", id, revision, provenance]);
      const previous = this.db.prepare("SELECT * FROM memory_requests WHERE request_key=?").get(requestKey);
      if (previous !== undefined) {
        if (previous.input_hash !== fingerprint) throw conflict();
        return { memory: view(this.#managed(identity, String(previous.memory_id))), invalidations: [] };
      }
      const row = this.#managed(identity, id);
      if (row.state !== "active" || row.revision !== revision) throw conflict();
      const chain = this.db.prepare("SELECT id,revision FROM durable_memories WHERE root_key=? AND state<>'forgotten'").all(String(row.root_key));
      this.db.prepare("UPDATE durable_memories SET state='forgotten',content='',keywords='[]',revision=revision+1 WHERE root_key=? AND state<>'forgotten'").run(String(row.root_key));
      for (const item of chain) this.db.prepare("UPDATE memory_shares SET revoked=1 WHERE memory_id=?").run(String(item.id));
      this.db.prepare("INSERT INTO memory_requests VALUES (?,?,?)").run(requestKey, fingerprint, id);
      const memory = view(this.#row(id, memoryDomain(identity)));
      this.#audit(identity, memory, "agent_forgotten");
      return { memory, invalidations: chain.map((item) => ({ id: String(item.id), throughRevision: Number(item.revision),
        revision: Number(item.revision) + 1, state: "forgotten" as const })) };
    });
  }

  public confirm(identity: ExecutionIdentity, id: string, revision: number): DurableMemory {
    return this.transaction(() => {
      const row = this.#managed(identity, id);
      if (row.state === "active" && row.revision === revision + 1) return view(row);
      if (row.state !== "pending" || row.revision !== revision || (row.expires_at !== null && Number(row.expires_at) <= Date.now())) throw conflict();
      if (row.supersedes !== null) {
        const old = this.#managed(identity, String(row.supersedes));
        if (old.state !== "active" || old.revision !== row.replaces_revision) throw conflict();
        this.db.prepare("UPDATE durable_memories SET state='superseded',revision=revision+1 WHERE id=?").run(String(old.id));
        this.db.prepare("UPDATE memory_shares SET revoked=1 WHERE memory_id=?").run(String(old.id));
        this.#audit(identity, view(this.#row(String(old.id), memoryDomain(identity))), "superseded");
      }
      this.db.prepare("UPDATE durable_memories SET state='active',revision=revision+1 WHERE id=?").run(id);
      const result = view(this.#row(id, memoryDomain(identity)));
      this.#audit(identity, result, "confirmed");
      return result;
    });
  }

  public reject(identity: ExecutionIdentity, id: string, revision: number): DurableMemory {
    return this.transaction(() => {
      const row = this.#managed(identity, id);
      if (row.state === "rejected") return view(row);
      if (row.state !== "pending" || row.revision !== revision) throw conflict();
      this.db.prepare("UPDATE durable_memories SET state='rejected',content='',keywords='[]',revision=revision+1 WHERE id=?").run(id);
      const result = view(this.#row(id, memoryDomain(identity)));
      this.#audit(identity, result, "candidate_rejected");
      return result;
    });
  }

  public get(identity: ExecutionIdentity, id: string): DurableMemory {
    memoryPermission(identity, "memory.read");
    const row = this.#row(id, memoryDomain(identity));
    const record = view(row);
    if (record.state === "active" && this.validReference(identity, this.#reference(identity, row))) return record;
    // A pending candidate is inspectable only by an actor who can manage this exact record.
    // This lets a user resume confirmation after refresh without granting readers visibility.
    try { this.#managed(identity, id); } catch { throw missing(); }
    return record;
  }

  /** This store's payloads are erased; already emitted conversation text and backups are not. */
  public forget(identity: ExecutionIdentity, id: string, revision: number): DurableMemory {
    return this.transaction(() => {
      const row = this.#managed(identity, id);
      if (row.state === "forgotten") return view(row);
      if (row.revision !== revision) throw conflict();
      const chain = this.db.prepare("SELECT id FROM durable_memories WHERE root_key=?").all(String(row.root_key));
      this.db.prepare("UPDATE durable_memories SET state='forgotten',content='',keywords='[]',revision=revision+1 WHERE root_key=? AND state<>'forgotten'")
        .run(String(row.root_key));
      for (const item of chain) this.db.prepare("UPDATE memory_shares SET revoked=1 WHERE memory_id=?").run(String(item.id));
      const result = view(this.#row(id, memoryDomain(identity)));
      this.#audit(identity, result, "forgotten_chain");
      return result;
    });
  }

  /** Caller must first validate target installation entitlement. Never exposed as a model tool. */
  public share(identity: ExecutionIdentity, id: string, revision: number, targetAppId: string, expiresAt: number): { id: string; expiresAt: number } {
    memoryPermission(identity, "memory.share");
    if (!memoryId(targetAppId) || targetAppId === identity.appInstallationId || !Number.isSafeInteger(expiresAt) ||
        expiresAt <= Date.now() || expiresAt > Date.now() + 30 * 86400_000) throw new CloudError(400, "MEMORY_SHARE_INVALID", "共享目标或期限无效，最长为 30 天。");
    return this.transaction(() => {
      const row = this.#managed(identity, id);
      if (row.state !== "active" || row.revision !== revision || row.memory_scope === "application" ||
          (row.expires_at !== null && expiresAt > Number(row.expires_at))) throw conflict();
      const grantId = `ms_${hash([id, revision, targetAppId, expiresAt])}`;
      const previous = this.db.prepare("SELECT * FROM memory_shares WHERE id=?").get(grantId);
      if (previous !== undefined) {
        if (previous.revoked !== 0) throw conflict();
        return { id: grantId, expiresAt };
      }
      this.db.prepare("INSERT INTO memory_shares VALUES (?,?,?,?,?,0,?,?)")
        .run(grantId, id, revision, targetAppId, expiresAt, identity.actorUserId, Date.now());
      this.#audit(identity, view(row), "shared");
      return { id: grantId, expiresAt };
    });
  }

  public revokeShare(identity: ExecutionIdentity, grantId: string): void {
    memoryPermission(identity, "memory.share");
    this.transaction(() => {
      const grant = this.db.prepare("SELECT * FROM memory_shares WHERE id=?").get(grantId);
      if (grant === undefined) throw missing();
      const row = this.#managed(identity, String(grant.memory_id));
      if (grant.revoked === 0) {
        this.db.prepare("UPDATE memory_shares SET revoked=1 WHERE id=?").run(grantId);
        this.#audit(identity, view(row), "share_revoked");
      }
    });
  }

  public list(identity: ExecutionIdentity, offset = 0): { items: DurableMemory[]; hasMore: boolean } {
    memoryPermission(identity, "memory.read");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 5000) throw new CloudError(400, "MEMORY_CURSOR_INVALID", "记忆分页无效。");
    const canOrg = identity.space.kind === "organization" && identity.permissions.includes("memory.organization.read");
    const rows = this.db.prepare(`SELECT * FROM durable_memories WHERE domain_key=? AND origin_app=?
      AND (owner_key=? OR (?=1 AND memory_scope='organization'
        AND (state='active' OR created_by=? OR ?=1))) ORDER BY created_at DESC,id DESC LIMIT 51 OFFSET ?`)
      .all(memoryDomain(identity), identity.appInstallationId, `user:${identity.actorUserId}`, canOrg ? 1 : 0,
        identity.actorUserId, identity.permissions.includes("memory.organization.write") ? 1 : 0, offset);
    return { items: rows.slice(0, 50).map(view), hasMore: rows.length > 50 };
  }

  public prepare(identity: ExecutionIdentity, input: MemoryPreparation): MemoryContextSnapshot {
    return this.transaction(() => prepareMemoryContext(this.db, this, identity, input));
  }

  public references(identity: ExecutionIdentity, sessionId: string, turnId: string): MemoryUse[] {
    return readMemoryUses(this.db, this, identity, sessionId, turnId);
  }

  public audit(identity: ExecutionIdentity, id: string, offset = 0): { items: MemoryAuditEntry[]; hasMore: boolean } {
    memoryPermission(identity, "memory.read");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 5000) throw new CloudError(400, "MEMORY_CURSOR_INVALID", "记忆分页无效。");
    this.#managed(identity, id);
    const rows = this.db.prepare("SELECT * FROM memory_audit WHERE memory_id=? ORDER BY created_at DESC,id DESC LIMIT 51 OFFSET ?").all(id, offset);
    return { items: rows.slice(0, 50).map((row) => ({ id: String(row.id), memoryId: String(row.memory_id),
      revision: Number(row.revision), actorId: String(row.actor_id), action: row.action as MemoryAuditAction,
      createdAt: Number(row.created_at) })), hasMore: rows.length > 50 };
  }

  public shares(identity: ExecutionIdentity, id: string): Array<{ id: string; revision: number; targetAppId: string; expiresAt: number; revoked: boolean }> {
    memoryPermission(identity, "memory.share");
    this.#managed(identity, id);
    return this.db.prepare("SELECT * FROM memory_shares WHERE memory_id=? ORDER BY created_at DESC LIMIT 100").all(id)
      .map((row) => ({ id: String(row.id), revision: Number(row.revision), targetAppId: String(row.target_app),
        expiresAt: Number(row.expires_at), revoked: row.revoked !== 0 }));
  }

  #visibleRows(identity: ExecutionIdentity): Row[] {
    const domain = memoryDomain(identity);
    if (!identity.permissions.includes("memory.read")) return [];
    const canOrg = identity.space.kind === "organization" && identity.permissions.includes("memory.organization.read");
    return this.db.prepare(`SELECT m.* FROM durable_memories m WHERE m.domain_key=? AND m.state='active'
      AND (m.expires_at IS NULL OR m.expires_at>?) AND (m.owner_key=? OR (?=1 AND m.memory_scope='organization'))
      AND (m.origin_app=? OR (m.memory_scope IN ('personal','organization') AND EXISTS
        (SELECT 1 FROM memory_shares s WHERE s.memory_id=m.id AND s.revision=m.revision AND s.target_app=? AND s.revoked=0 AND s.expires_at>?)))
      ORDER BY m.created_at DESC,m.id DESC LIMIT 5001`)
      .all(domain, Date.now(), `user:${identity.actorUserId}`, canOrg ? 1 : 0, identity.appInstallationId, identity.appInstallationId, Date.now());
  }
  #reference(identity: ExecutionIdentity, row: Row): MemoryReference {
    let grantId: string | null = null;
    if (row.origin_app !== identity.appInstallationId) {
      const grant = this.db.prepare(`SELECT id FROM memory_shares WHERE memory_id=? AND revision=? AND target_app=? AND revoked=0 AND expires_at>?
        ORDER BY expires_at DESC,id LIMIT 1`).get(String(row.id), Number(row.revision), identity.appInstallationId, Date.now());
      if (grant === undefined) throw missing();
      grantId = String(grant.id);
    }
    return { id: String(row.id), revision: Number(row.revision), grantId };
  }
  public validReference(identity: ExecutionIdentity, ref: MemoryReference): boolean {
    try { memoryPermission(identity, "memory.read"); } catch { return false; }
    const row = this.db.prepare("SELECT * FROM durable_memories WHERE id=? AND domain_key=?").get(ref.id, memoryDomain(identity));
    if (row === undefined || row.state !== "active" || row.revision !== ref.revision || (row.expires_at !== null && Number(row.expires_at) <= Date.now())) return false;
    const owner = row.owner_key === `user:${identity.actorUserId}`;
    const org = row.memory_scope === "organization" && identity.space.kind === "organization" && identity.permissions.includes("memory.organization.read");
    if (!owner && !org) return false;
    if (row.origin_app === identity.appInstallationId) return ref.grantId === null;
    if (row.memory_scope === "application" || ref.grantId === null) return false;
    return this.db.prepare(`SELECT 1 FROM memory_shares WHERE id=? AND memory_id=? AND revision=? AND target_app=? AND revoked=0 AND expires_at>?`)
      .get(ref.grantId, ref.id, ref.revision, identity.appInstallationId, Date.now()) !== undefined;
  }

  public search(identity: ExecutionIdentity, query: string, limit = 6, includeDefaults = false): RecalledMemory[] {
    memoryPermission(identity, "memory.read");
    if (typeof query !== "string" || query.length > 500 || !Number.isSafeInteger(limit) || limit < 1 || limit > 12) {
      throw new CloudError(400, "MEMORY_QUERY_INVALID", "记忆查询过长或条数无效。");
    }
    const rows = this.#visibleRows(identity);
    if (rows.length > 5000) throw new CloudError(429, "MEMORY_CAPACITY", "记忆数量超过当前检索容量。");
    const hits: RecalledMemory[] = [];
    for (const row of rows) {
      const memory = view(row);
      const relevance = recallRelevance(memory, query, includeDefaults);
      if (relevance !== null) hits.push({ memory, reference: this.#reference(identity, row), ...relevance });
    }
    return rankMemoryHits(hits, limit);
  }
}
