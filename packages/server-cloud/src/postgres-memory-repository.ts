import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { executionScopeKey, type ExecutionIdentity } from "@daoyin/harness-contracts";
import type { AgentEvent } from "@daoyin/harness-protocol";
import type { MemoryContextSnapshot } from "@daoyin/harness-agent-core";
import { CloudError } from "./repository.js";
import {
  memoryDomain, memoryId, memoryOwner, memoryPermission, normalizeMemoryProposal,
  type DurableMemory, type MemoryAuditAction, type MemoryAuditEntry, type MemoryProposal, type MemoryReference,
  type MemorySource, type RecalledMemory,
} from "./memory-policy.js";
import type { MemoryPreparation, MemoryUse } from "./memory-runtime.js";
import { agentSourceShape, verifyAgentSource, recallRelevance, rankMemoryHits, memoryContextText, matchesOwnInvalidation,
  type MemoryMutation, type MemoryInvalidation } from "./memory-agent-policy.js";

type Row = Record<string, unknown>;
type Transaction = <T>(operation: (client: PoolClient) => Promise<T>) => Promise<T>;
const uid = (prefix: string): string => `${prefix}_${randomUUID().replaceAll("-", "")}`;
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const missing = (): CloudError => new CloudError(404, "MEMORY_NOT_FOUND", "记忆不存在或当前身份无权访问。");
const conflict = (): CloudError => new CloudError(409, "MEMORY_VERSION_CONFLICT", "记忆已改变，请重新读取并确认最新版本。");
const changed = (): CloudError => new CloudError(409, "MEMORY_CONTEXT_CHANGED", "本轮引用的记忆或共享授权已改变，未继续使用旧内容。");
const tooLarge = (): CloudError => new CloudError(409, "MEMORY_HISTORY_LIMIT", "记忆依赖过多，请新建会话。");
const number = (value: unknown): number => Number(value);
const bool = (value: unknown): boolean => value === true || value === "t" || value === 1 || value === "1";
const refKey = (reference: MemoryReference): string => JSON.stringify([reference.id, reference.revision, reference.grantId]);
const turnKey = (sessionId: string, turnId: string): string => JSON.stringify([sessionId, turnId]);

function view(row: Row): DurableMemory {
  return { id: String(row.id), revision: number(row.revision), state: row.state as DurableMemory["state"],
    key: String(row.fact_key), scope: row.memory_scope as DurableMemory["scope"], kind: row.kind as DurableMemory["kind"],
    content: String(row.content), keywords: JSON.parse(String(row.keywords)) as string[], createdBy: String(row.created_by),
    originAppId: String(row.origin_app), source: JSON.parse(String(row.source)) as MemorySource,
    expiresAt: row.expires_at === null ? null : number(row.expires_at), createdAt: number(row.created_at),
    supersedes: row.supersedes === null ? null : String(row.supersedes) };
}

/** Called by the explicit cloud migration command within its owning transaction. */
export async function migratePostgresMemory(client: PoolClient): Promise<void> {
  for (const statement of [
    `CREATE TABLE IF NOT EXISTS durable_memories (
      id TEXT PRIMARY KEY, domain_key TEXT NOT NULL, owner_key TEXT NOT NULL, origin_app TEXT NOT NULL,
      created_by TEXT NOT NULL, root_key TEXT NOT NULL, fact_key TEXT NOT NULL, memory_scope TEXT NOT NULL,
      kind TEXT NOT NULL, content TEXT NOT NULL, keywords TEXT NOT NULL, source TEXT NOT NULL,
      revision INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','active','superseded','forgotten','rejected')),
      supersedes TEXT, replaces_revision INTEGER, created_at BIGINT NOT NULL, expires_at BIGINT
    )`,
    "CREATE INDEX IF NOT EXISTS durable_memory_scope ON durable_memories(domain_key,owner_key,origin_app,state)",
    "CREATE UNIQUE INDEX IF NOT EXISTS durable_memory_active_key ON durable_memories(root_key) WHERE state='active'",
    `CREATE TABLE IF NOT EXISTS memory_requests (
      request_key TEXT PRIMARY KEY, input_hash TEXT NOT NULL, memory_id TEXT NOT NULL REFERENCES durable_memories(id)
    )`,
    `CREATE TABLE IF NOT EXISTS memory_shares (
      id TEXT PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES durable_memories(id), revision INTEGER NOT NULL,
      target_app TEXT NOT NULL, expires_at BIGINT NOT NULL, revoked BOOLEAN NOT NULL DEFAULT FALSE,
      created_by TEXT NOT NULL, created_at BIGINT NOT NULL
    )`,
    "CREATE INDEX IF NOT EXISTS memory_share_target ON memory_shares(memory_id,revision,target_app,revoked,expires_at)",
    `CREATE TABLE IF NOT EXISTS memory_audit (
      id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, revision INTEGER NOT NULL, actor_id TEXT NOT NULL,
      action TEXT NOT NULL, created_at BIGINT NOT NULL
    )`,
    "CREATE INDEX IF NOT EXISTS memory_audit_record ON memory_audit(memory_id,created_at DESC,id DESC)",
    `CREATE TABLE IF NOT EXISTS memory_references (
      consumer_scope TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT NOT NULL, step INTEGER NOT NULL,
      memory_id TEXT NOT NULL, revision INTEGER NOT NULL, grant_id TEXT NOT NULL,
      reasons TEXT NOT NULL, created_at BIGINT NOT NULL,
      PRIMARY KEY(consumer_scope,session_id,turn_id,step,memory_id,revision,grant_id)
    )`,
  ]) await client.query(statement);
}

/** PostgreSQL implementation of the reviewed, scoped memory contract. */
export class PostgresMemoryRepository {
  public constructor(private readonly pool: Pool, private readonly transaction: Transaction) {}

  async #audit(client: PoolClient, identity: ExecutionIdentity, record: DurableMemory, action: MemoryAuditAction): Promise<void> {
    await client.query("INSERT INTO memory_audit(id,memory_id,revision,actor_id,action,created_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [uid("ma"), record.id, record.revision, identity.actorUserId, action, Date.now()]);
  }

  async #row(client: Pool | PoolClient, id: string, domain: string, lock = false): Promise<Row> {
    if (!memoryId(id)) throw missing();
    const result = await client.query<Row>(`SELECT * FROM durable_memories WHERE id=$1 AND domain_key=$2${lock ? " FOR UPDATE" : ""}`, [id, domain]);
    if (result.rows[0] === undefined) throw missing();
    return result.rows[0];
  }

  async #managed(client: Pool | PoolClient, identity: ExecutionIdentity, id: string, lock = false): Promise<Row> {
    memoryPermission(identity, "memory.write");
    const row = await this.#row(client, id, memoryDomain(identity), lock);
    if (row.origin_app !== identity.appInstallationId || row.owner_key !== memoryOwner(identity, row.memory_scope as DurableMemory["scope"])) throw missing();
    if (row.memory_scope === "organization") memoryPermission(identity, "memory.organization.write");
    return row;
  }

  async #source(client: PoolClient, identity: ExecutionIdentity, requestId: string, source?: MemorySource): Promise<MemorySource> {
    if (source === undefined) return { kind: "user_edit", requestId };
    if (source.kind !== "conversation" || source.requestId !== requestId || !memoryId(source.sessionId) || !memoryId(source.turnId) || !memoryId(source.eventId)) {
      throw new CloudError(400, "MEMORY_SOURCE_INVALID", "记忆来源无效。");
    }
    const result = await client.query<Row>(`SELECT e.body FROM cloud_events e JOIN cloud_runs r ON r.id=e.turn_id AND r.session_id=e.session_id
      WHERE e.event_id=$1 AND e.session_id=$2 AND e.turn_id=$3 AND r.scope_key=$4`,
    [source.eventId, source.sessionId, source.turnId, executionScopeKey(identity)]);
    const event = result.rows[0] === undefined ? undefined : JSON.parse(String(result.rows[0].body)) as AgentEvent;
    if (event?.type !== "turn.started") throw new CloudError(403, "MEMORY_SOURCE_DENIED", "只能引用当前身份可访问的原始用户消息。");
    return { kind: "conversation", requestId, sessionId: source.sessionId, turnId: source.turnId, eventId: source.eventId };
  }

  async #agentSource(client: PoolClient, identity: ExecutionIdentity, source: MemorySource, operation: "remember" | "forget"): Promise<MemorySource> {
    if (!agentSourceShape(source)) throw new CloudError(403, "MEMORY_SOURCE_DENIED", "自主记忆缺少真实来源。");
    const result = await client.query<Row>(`SELECT e.body FROM cloud_events e JOIN cloud_runs r ON r.id=e.turn_id AND r.session_id=e.session_id
      WHERE e.event_id=ANY($1::text[]) AND e.session_id=$2 AND e.turn_id=$3 AND r.scope_key=$4 AND r.status='running'`,
    [[source.eventId, source.toolEventId], source.sessionId, source.turnId, executionScopeKey(identity)]);
    const events = result.rows.map((row) => JSON.parse(String(row.body)) as AgentEvent);
    return verifyAgentSource(source, events.find((event) => event.id === source.eventId), events.find((event) => event.id === source.toolEventId), operation);
  }

  public async propose(identity: ExecutionIdentity, raw: MemoryProposal, source?: MemorySource): Promise<DurableMemory> {
    return (await this.#save(identity, raw, source, false)).memory;
  }

  public async remember(identity: ExecutionIdentity, raw: MemoryProposal, source: MemorySource): Promise<MemoryMutation> {
    return this.#save(identity, raw, source, true);
  }

  async #save(identity: ExecutionIdentity, raw: MemoryProposal, source: MemorySource | undefined, automatic: boolean): Promise<MemoryMutation> {
    memoryPermission(identity, "memory.write");
    const input = normalizeMemoryProposal(raw);
    const domain = memoryDomain(identity);
    const owner = memoryOwner(identity, input.scope);
    if (input.scope === "organization") memoryPermission(identity, "memory.organization.write");
    return this.transaction(async (client) => {
      if (automatic && (source === undefined || source.requestId !== input.requestId)) throw conflict();
      const provenance = automatic ? await this.#agentSource(client, identity, source!, "remember") : await this.#source(client, identity, input.requestId, source);
      const requestKey = hash([executionScopeKey(identity), input.requestId]);
      const fingerprint = hash([input.key, input.scope, input.kind, input.content, input.keywords, input.expiresAt ?? null,
        input.replaces?.id ?? null, input.replaces?.revision ?? null, provenance]);
      const rootKey = hash([domain, owner, identity.appInstallationId, input.scope, input.key]);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [requestKey]);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [rootKey]);
      const previous = await client.query<Row>("SELECT * FROM memory_requests WHERE request_key=$1", [requestKey]);
      if (previous.rows[0] !== undefined) {
        if (String(previous.rows[0].input_hash) !== fingerprint) throw conflict();
        return { memory: view(await this.#managed(client, identity, String(previous.rows[0].memory_id))), invalidations: [] };
      }
      let supersedes: string | null = null;
      const invalidations: MemoryInvalidation[] = [];
      if (input.replaces !== undefined) {
        const old = await this.#managed(client, identity, input.replaces.id, true);
        if (old.state !== "active" || number(old.revision) !== input.replaces.revision || old.root_key !== rootKey) throw conflict();
        supersedes = input.replaces.id;
        if (automatic) {
          await client.query("UPDATE durable_memories SET state='superseded',revision=revision+1 WHERE id=$1", [supersedes]);
          await client.query("UPDATE memory_shares SET revoked=TRUE WHERE memory_id=$1", [supersedes]);
          invalidations.push({ id: supersedes, throughRevision: number(old.revision), revision: number(old.revision) + 1, state: "superseded" });
          await this.#audit(client, identity, view(await this.#row(client, supersedes, domain)), "superseded");
        }
      } else {
        const existing = await client.query<Row>(`SELECT * FROM durable_memories WHERE root_key=$1 AND state<>'rejected'
          ORDER BY CASE state WHEN 'active' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,created_at DESC,id DESC LIMIT 1`, [rootKey]);
        const row = existing.rows[0];
        if (row !== undefined && row.state === "forgotten" && automatic) throw new CloudError(409, "MEMORY_FORGOTTEN", "该记忆已被忘记；自动写入不会恢复，请由用户明确重新保存。");
        if (row !== undefined && row.state !== "forgotten") {
          if ((row.state === "active" || (!automatic && row.state === "pending")) && row.content === input.content && row.kind === input.kind &&
              row.keywords === JSON.stringify(input.keywords) && numberOrNull(row.expires_at) === (input.expiresAt ?? null)) {
            await client.query("INSERT INTO memory_requests(request_key,input_hash,memory_id) VALUES ($1,$2,$3)", [requestKey, fingerprint, String(row.id)]);
            return { memory: view(row), invalidations: [] };
          }
          throw conflict();
        }
      }
      const count = await client.query<{ n: string }>("SELECT COUNT(*) AS n FROM durable_memories WHERE domain_key=$1", [domain]);
      if (number(count.rows[0]?.n) >= 5_000) throw new CloudError(429, "MEMORY_CAPACITY", "当前空间的记忆容量已达上限。");
      const memoryIdValue = uid("mem");
      await client.query(`INSERT INTO durable_memories(id,domain_key,owner_key,origin_app,created_by,root_key,fact_key,memory_scope,kind,content,keywords,source,
        revision,state,supersedes,replaces_revision,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,$13,$14,$15,$16,$17)`,
      [memoryIdValue, domain, owner, identity.appInstallationId, identity.actorUserId, rootKey, input.key, input.scope, input.kind, input.content,
        JSON.stringify(input.keywords), JSON.stringify(provenance), automatic ? "active" : "pending", supersedes, input.replaces?.revision ?? null, Date.now(), input.expiresAt ?? null]);
      await client.query("INSERT INTO memory_requests(request_key,input_hash,memory_id) VALUES ($1,$2,$3)", [requestKey, fingerprint, memoryIdValue]);
      const result = view(await this.#row(client, memoryIdValue, domain));
      await this.#audit(client, identity, result, automatic ? (supersedes === null ? "agent_saved" : "agent_updated") : "proposed");
      return { memory: result, invalidations };
    });
  }

  public async forgetByAgent(identity: ExecutionIdentity, id: string, revision: number, source: MemorySource): Promise<MemoryMutation> {
    memoryPermission(identity, "memory.write");
    return this.transaction(async (client) => {
      const provenance = await this.#agentSource(client, identity, source, "forget");
      const requestKey = hash([executionScopeKey(identity), source.requestId]);
      const fingerprint = hash(["agent_forget", id, revision, provenance]);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [requestKey]);
      const previous = await client.query<Row>("SELECT * FROM memory_requests WHERE request_key=$1", [requestKey]);
      if (previous.rows[0] !== undefined) {
        if (String(previous.rows[0].input_hash) !== fingerprint) throw conflict();
        return { memory: view(await this.#managed(client, identity, String(previous.rows[0].memory_id))), invalidations: [] };
      }
      const initial = await this.#managed(client, identity, id);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [String(initial.root_key)]);
      const row = await this.#managed(client, identity, id, true);
      if (row.state !== "active" || number(row.revision) !== revision) throw conflict();
      const chain = await client.query<Row>("SELECT id,revision FROM durable_memories WHERE root_key=$1 AND state<>'forgotten' FOR UPDATE", [String(row.root_key)]);
      await client.query("UPDATE durable_memories SET state='forgotten',content='',keywords='[]',revision=revision+1 WHERE root_key=$1 AND state<>'forgotten'", [String(row.root_key)]);
      await client.query("UPDATE memory_shares SET revoked=TRUE WHERE memory_id IN (SELECT id FROM durable_memories WHERE root_key=$1)", [String(row.root_key)]);
      await client.query("INSERT INTO memory_requests(request_key,input_hash,memory_id) VALUES ($1,$2,$3)", [requestKey, fingerprint, id]);
      const memory = view(await this.#row(client, id, memoryDomain(identity)));
      await this.#audit(client, identity, memory, "agent_forgotten");
      return { memory, invalidations: chain.rows.map((item) => ({ id: String(item.id), throughRevision: number(item.revision),
        revision: number(item.revision) + 1, state: "forgotten" as const })) };
    });
  }

  public async confirm(identity: ExecutionIdentity, id: string, revision: number): Promise<DurableMemory> {
    return this.transaction(async (client) => {
      const row = await this.#managed(client, identity, id, true);
      if (row.state === "active" && number(row.revision) === revision + 1) return view(row);
      if (row.state !== "pending" || number(row.revision) !== revision || (row.expires_at !== null && number(row.expires_at) <= Date.now())) throw conflict();
      if (row.supersedes !== null) {
        const old = await this.#managed(client, identity, String(row.supersedes), true);
        if (old.state !== "active" || number(old.revision) !== number(row.replaces_revision)) throw conflict();
        await client.query("UPDATE durable_memories SET state='superseded',revision=revision+1 WHERE id=$1", [String(old.id)]);
        await client.query("UPDATE memory_shares SET revoked=TRUE WHERE memory_id=$1", [String(old.id)]);
        await this.#audit(client, identity, view(await this.#row(client, String(old.id), memoryDomain(identity))), "superseded");
      }
      await client.query("UPDATE durable_memories SET state='active',revision=revision+1 WHERE id=$1", [id]);
      const result = view(await this.#row(client, id, memoryDomain(identity)));
      await this.#audit(client, identity, result, "confirmed");
      return result;
    });
  }

  public async reject(identity: ExecutionIdentity, id: string, revision: number): Promise<DurableMemory> {
    return this.transaction(async (client) => {
      const row = await this.#managed(client, identity, id, true);
      if (row.state === "rejected") return view(row);
      if (row.state !== "pending" || number(row.revision) !== revision) throw conflict();
      await client.query("UPDATE durable_memories SET state='rejected',content='',keywords='[]',revision=revision+1 WHERE id=$1", [id]);
      const result = view(await this.#row(client, id, memoryDomain(identity)));
      await this.#audit(client, identity, result, "candidate_rejected");
      return result;
    });
  }

  public async get(identity: ExecutionIdentity, id: string): Promise<DurableMemory> {
    memoryPermission(identity, "memory.read");
    const row = await this.#row(this.pool, id, memoryDomain(identity));
    const record = view(row);
    if (record.state === "active" && await this.validReference(identity, await this.#reference(this.pool, identity, row))) return record;
    try { await this.#managed(this.pool, identity, id); } catch { throw missing(); }
    return record;
  }

  public async forget(identity: ExecutionIdentity, id: string, revision: number): Promise<DurableMemory> {
    return this.transaction(async (client) => {
      const row = await this.#managed(client, identity, id, true);
      if (row.state === "forgotten") return view(row);
      if (number(row.revision) !== revision) throw conflict();
      await client.query("UPDATE durable_memories SET state='forgotten',content='',keywords='[]',revision=revision+1 WHERE root_key=$1 AND state<>'forgotten'", [String(row.root_key)]);
      await client.query("UPDATE memory_shares SET revoked=TRUE WHERE memory_id IN (SELECT id FROM durable_memories WHERE root_key=$1)", [String(row.root_key)]);
      const result = view(await this.#row(client, id, memoryDomain(identity)));
      await this.#audit(client, identity, result, "forgotten_chain");
      return result;
    });
  }

  public async share(identity: ExecutionIdentity, id: string, revision: number, targetAppId: string, expiresAt: number): Promise<{ id: string; expiresAt: number }> {
    memoryPermission(identity, "memory.share");
    if (!memoryId(targetAppId) || targetAppId === identity.appInstallationId || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 30 * 86400_000) {
      throw new CloudError(400, "MEMORY_SHARE_INVALID", "共享目标或期限无效，最长为 30 天。");
    }
    return this.transaction(async (client) => {
      const row = await this.#managed(client, identity, id, true);
      if (row.state !== "active" || number(row.revision) !== revision || row.memory_scope === "application" ||
          (row.expires_at !== null && expiresAt > number(row.expires_at))) throw conflict();
      const grantId = `ms_${hash([id, revision, targetAppId, expiresAt])}`;
      const previous = await client.query<Row>("SELECT * FROM memory_shares WHERE id=$1", [grantId]);
      if (previous.rows[0] !== undefined) {
        if (bool(previous.rows[0].revoked)) throw conflict();
        return { id: grantId, expiresAt };
      }
      await client.query("INSERT INTO memory_shares(id,memory_id,revision,target_app,expires_at,revoked,created_by,created_at) VALUES ($1,$2,$3,$4,$5,FALSE,$6,$7)",
        [grantId, id, revision, targetAppId, expiresAt, identity.actorUserId, Date.now()]);
      await this.#audit(client, identity, view(row), "shared");
      return { id: grantId, expiresAt };
    });
  }

  public async revokeShare(identity: ExecutionIdentity, grantId: string): Promise<void> {
    memoryPermission(identity, "memory.share");
    await this.transaction(async (client) => {
      const grant = await client.query<Row>("SELECT * FROM memory_shares WHERE id=$1 FOR UPDATE", [grantId]);
      if (grant.rows[0] === undefined) throw missing();
      const row = await this.#managed(client, identity, String(grant.rows[0].memory_id), true);
      if (!bool(grant.rows[0].revoked)) {
        await client.query("UPDATE memory_shares SET revoked=TRUE WHERE id=$1", [grantId]);
        await this.#audit(client, identity, view(row), "share_revoked");
      }
    });
  }

  public async list(identity: ExecutionIdentity, offset = 0): Promise<{ items: DurableMemory[]; hasMore: boolean }> {
    memoryPermission(identity, "memory.read");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 5_000) throw new CloudError(400, "MEMORY_CURSOR_INVALID", "记忆分页无效。");
    const canOrg = identity.space.kind === "organization" && identity.permissions.includes("memory.organization.read");
    const result = await this.pool.query<Row>(`SELECT * FROM durable_memories WHERE domain_key=$1 AND origin_app=$2
      AND (owner_key=$3 OR ($4=TRUE AND memory_scope='organization' AND (state='active' OR created_by=$5 OR $6=TRUE)))
      ORDER BY created_at DESC,id DESC LIMIT 51 OFFSET $7`, [memoryDomain(identity), identity.appInstallationId, `user:${identity.actorUserId}`,
      canOrg, identity.actorUserId, identity.permissions.includes("memory.organization.write"), offset]);
    return { items: result.rows.slice(0, 50).map(view), hasMore: result.rows.length > 50 };
  }

  async #visibleRows(client: Pool | PoolClient, identity: ExecutionIdentity): Promise<Row[]> {
    const domain = memoryDomain(identity);
    if (!identity.permissions.includes("memory.read")) return [];
    const canOrg = identity.space.kind === "organization" && identity.permissions.includes("memory.organization.read");
    const result = await client.query<Row>(`SELECT m.* FROM durable_memories m WHERE m.domain_key=$1 AND m.state='active'
      AND (m.expires_at IS NULL OR m.expires_at>$2) AND (m.owner_key=$3 OR ($4=TRUE AND m.memory_scope='organization'))
      AND (m.origin_app=$5 OR (m.memory_scope IN ('personal','organization') AND EXISTS
        (SELECT 1 FROM memory_shares s WHERE s.memory_id=m.id AND s.revision=m.revision AND s.target_app=$5 AND s.revoked=FALSE AND s.expires_at>$2)))
      ORDER BY m.created_at DESC,m.id DESC LIMIT 5001`, [domain, Date.now(), `user:${identity.actorUserId}`, canOrg, identity.appInstallationId]);
    return result.rows;
  }

  async #reference(client: Pool | PoolClient, identity: ExecutionIdentity, row: Row): Promise<MemoryReference> {
    let grantId: string | null = null;
    if (row.origin_app !== identity.appInstallationId) {
      const grant = await client.query<Row>(`SELECT id FROM memory_shares WHERE memory_id=$1 AND revision=$2 AND target_app=$3 AND revoked=FALSE AND expires_at>$4
        ORDER BY expires_at DESC,id LIMIT 1`, [String(row.id), number(row.revision), identity.appInstallationId, Date.now()]);
      if (grant.rows[0] === undefined) throw missing();
      grantId = String(grant.rows[0].id);
    }
    return { id: String(row.id), revision: number(row.revision), grantId };
  }

  public async validReference(identity: ExecutionIdentity, reference: MemoryReference): Promise<boolean> {
    try { memoryPermission(identity, "memory.read"); } catch { return false; }
    return this.#validReference(this.pool, identity, reference);
  }

  async #validReference(client: Pool | PoolClient, identity: ExecutionIdentity, reference: MemoryReference): Promise<boolean> {
    const result = await client.query<Row>("SELECT * FROM durable_memories WHERE id=$1 AND domain_key=$2", [reference.id, memoryDomain(identity)]);
    const row = result.rows[0];
    if (row === undefined || row.state !== "active" || number(row.revision) !== reference.revision || (row.expires_at !== null && number(row.expires_at) <= Date.now())) return false;
    const owner = row.owner_key === `user:${identity.actorUserId}`;
    const org = row.memory_scope === "organization" && identity.space.kind === "organization" && identity.permissions.includes("memory.organization.read");
    if (!owner && !org) return false;
    if (row.origin_app === identity.appInstallationId) return reference.grantId === null;
    if (row.memory_scope === "application" || reference.grantId === null) return false;
    const share = await client.query("SELECT 1 FROM memory_shares WHERE id=$1 AND memory_id=$2 AND revision=$3 AND target_app=$4 AND revoked=FALSE AND expires_at>$5",
      [reference.grantId, reference.id, reference.revision, identity.appInstallationId, Date.now()]);
    return share.rows[0] !== undefined;
  }

  public async search(identity: ExecutionIdentity, query: string, limit = 6): Promise<RecalledMemory[]> {
    memoryPermission(identity, "memory.read");
    return this.#search(this.pool, identity, query, limit);
  }

  async #search(client: Pool | PoolClient, identity: ExecutionIdentity, query: string, limit: number, includeDefaults = false): Promise<RecalledMemory[]> {
    if (typeof query !== "string" || query.length > 500 || !Number.isSafeInteger(limit) || limit < 1 || limit > 12) {
      throw new CloudError(400, "MEMORY_QUERY_INVALID", "记忆查询过长或条数无效。");
    }
    const rows = await this.#visibleRows(client, identity);
    if (rows.length > 5_000) throw new CloudError(429, "MEMORY_CAPACITY", "记忆数量超过当前检索容量。");
    const hits: RecalledMemory[] = [];
    for (const row of rows) {
      const memory = view(row);
      const relevance = recallRelevance(memory, query, includeDefaults);
      if (relevance !== null) hits.push({ memory, reference: await this.#reference(client, identity, row), ...relevance });
    }
    return rankMemoryHits(hits, limit);
  }

  public async prepare(identity: ExecutionIdentity, input: MemoryPreparation): Promise<MemoryContextSnapshot> {
    return this.transaction((client) => this.#prepare(client, identity, input));
  }

  async #prepare(client: PoolClient, identity: ExecutionIdentity, input: MemoryPreparation): Promise<MemoryContextSnapshot> {
    const domain = memoryDomain(identity);
    const consumer = executionScopeKey(identity);
    if (!memoryId(input.sessionId) || !memoryId(input.turnId) || !Number.isSafeInteger(input.step) || input.step < 0 || input.step > 100) throw changed();
    if ((input.ownInvalidations?.length ?? 0) > 500 || (input.additionalReferences?.length ?? 0) > 500) throw tooLarge();
    const active = await client.query("SELECT 1 FROM cloud_runs WHERE scope_key=$1 AND session_id=$2 AND id=$3 AND status='running'", [consumer, input.sessionId, input.turnId]);
    if (active.rows[0] === undefined) throw changed();
    const own = async (ref: MemoryReference, source = false): Promise<boolean> => {
      const rows = await client.query<Row>("SELECT id,revision,state FROM durable_memories WHERE id=$1 AND domain_key=$2", [ref.id, domain]);
      return matchesOwnInvalidation(rows.rows[0], ref, input.ownInvalidations, source);
    };
    const dependencies: Array<{ sessionId: string; turnId: string; reference: MemoryReference }> = [];
    const sessions = new Set([input.sessionId, ...input.events.map((event) => event.sessionId)]);
    if (sessions.size > 50) throw tooLarge();
    const requested = new Set(input.events.map((event) => turnKey(event.sessionId, event.turnId)));
    requested.add(turnKey(input.sessionId, input.turnId));
    for (const sessionId of sessions) {
      const owned = await client.query("SELECT 1 FROM cloud_sessions WHERE id=$1 AND scope_key=$2", [sessionId, consumer]);
      if (owned.rows[0] === undefined) throw changed();
      const refs = await client.query<Row>("SELECT DISTINCT session_id,turn_id,memory_id,revision,grant_id FROM memory_references WHERE consumer_scope=$1 AND session_id=$2 LIMIT 5001", [consumer, sessionId]);
      if (refs.rows.length > 5_000) throw tooLarge();
      for (const row of refs.rows) if (requested.has(turnKey(String(row.session_id), String(row.turn_id)))) dependencies.push({
        sessionId: String(row.session_id), turnId: String(row.turn_id), reference: { id: String(row.memory_id), revision: number(row.revision), grantId: row.grant_id ? String(row.grant_id) : null },
      });
      if (dependencies.length > 5_000) throw tooLarge();
    }
    const excluded = new Map<string, { sessionId: string; turnId: string }>();
    const retired = new Set<string>();
    for (const dependency of dependencies) if (!identity.permissions.includes("memory.read") || !await this.#validReference(client, identity, dependency.reference)) {
      if (dependency.sessionId === input.sessionId && dependency.turnId === input.turnId) {
        if (!await own(dependency.reference)) throw changed();
        retired.add(refKey(dependency.reference));
      } else excluded.set(turnKey(dependency.sessionId, dependency.turnId), { sessionId: dependency.sessionId, turnId: dependency.turnId });
    }
    const sourceRows = await client.query<Row>(`SELECT id,revision,source FROM durable_memories WHERE domain_key=$1 AND origin_app=$2
      AND state IN ('active','superseded','forgotten') AND (created_by=$3 OR memory_scope='organization')`, [domain, identity.appInstallationId, identity.actorUserId]);
    const sourceDependencies: Array<{ sessionId: string; turnId: string; reference: MemoryReference }> = [];
    for (const row of sourceRows.rows) {
      const source = JSON.parse(String(row.source)) as MemorySource;
      const reference = { id: String(row.id), revision: number(row.revision), grantId: null };
      if (!source.sessionId || !source.turnId || !requested.has(turnKey(source.sessionId, source.turnId))) continue;
      if (!identity.permissions.includes("memory.read") || !await this.#validReference(client, identity, reference)) {
        if (source.sessionId === input.sessionId && source.turnId === input.turnId) {
          if (!await own(reference, true)) throw changed();
        } else excluded.set(turnKey(source.sessionId, source.turnId), { sessionId: source.sessionId, turnId: source.turnId });
      } else sourceDependencies.push({ sessionId: source.sessionId, turnId: source.turnId, reference });
    }
    const references = new Map<string, MemoryReference>();
    for (const item of [...dependencies, ...sourceDependencies]) {
      if (!excluded.has(turnKey(item.sessionId, item.turnId)) && !retired.has(refKey(item.reference))) references.set(refKey(item.reference), item.reference);
    }
    const reasons = new Map<string, string[]>();
    for (const reference of input.additionalReferences ?? []) {
      if (!identity.permissions.includes("memory.read") || !await this.#validReference(client, identity, reference)) {
        if (!await own(reference)) throw changed();
        continue;
      }
      references.set(refKey(reference), reference); reasons.set(refKey(reference), ["tool_search_or_write"]);
    }
    const hits = identity.permissions.includes("memory.read") ? await this.#search(client, identity, input.query.slice(0, 500), 6, true) : [];
    const records: Array<Record<string, unknown>> = [];
    for (const hit of hits) {
      const data = { reference: hit.reference, key: hit.memory.key, kind: hit.memory.kind, scope: hit.memory.scope, content: hit.memory.content,
        source: hit.memory.source, originAppId: hit.memory.originAppId, reasons: hit.reasons };
      if (JSON.stringify([...records, data]).length > 8_000) continue;
      records.push(data); references.set(refKey(hit.reference), hit.reference); reasons.set(refKey(hit.reference), hit.reasons);
    }
    if (references.size > 500) throw tooLarge();
    const refs = [...references.values()];
    for (const reference of refs) await client.query(`INSERT INTO memory_references(consumer_scope,session_id,turn_id,step,memory_id,revision,grant_id,reasons,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`, [consumer, input.sessionId, input.turnId, input.step,
      reference.id, reference.revision, reference.grantId ?? "", JSON.stringify(reasons.get(refKey(reference)) ?? ["history_dependency"]), Date.now()]);
    return { text: memoryContextText(records, excluded.size, hits.length - records.length), excludedTurns: [...excluded.values()], assertCurrent: async (signal) => {
      signal.throwIfAborted();
      if ((await Promise.all(refs.map((reference) => this.validReference(identity, reference)))).some((available) => !available)) throw changed();
    } };
  }

  public async references(identity: ExecutionIdentity, sessionId: string, turnId: string): Promise<MemoryUse[]> {
    memoryPermission(identity, "memory.read");
    const consumer = executionScopeKey(identity);
    if (identity.space.kind === "public") throw missing();
    const run = await this.pool.query("SELECT 1 FROM cloud_runs WHERE scope_key=$1 AND session_id=$2 AND id=$3", [consumer, sessionId, turnId]);
    if (run.rows[0] === undefined) throw missing();
    const result = await this.pool.query<Row>("SELECT * FROM memory_references WHERE consumer_scope=$1 AND session_id=$2 AND turn_id=$3 ORDER BY step,memory_id LIMIT 5001", [consumer, sessionId, turnId]);
    if (result.rows.length > 5_000) throw tooLarge();
    return Promise.all(result.rows.map(async (row) => {
      const reference = { id: String(row.memory_id), revision: number(row.revision), grantId: row.grant_id ? String(row.grant_id) : null };
      return { ...reference, step: number(row.step), available: await this.validReference(identity, reference), reasons: JSON.parse(String(row.reasons)) as string[] };
    }));
  }

  public async audit(identity: ExecutionIdentity, id: string, offset = 0): Promise<{ items: MemoryAuditEntry[]; hasMore: boolean }> {
    memoryPermission(identity, "memory.read");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 5_000) throw new CloudError(400, "MEMORY_CURSOR_INVALID", "记忆分页无效。");
    await this.#managed(this.pool, identity, id);
    const result = await this.pool.query<Row>("SELECT * FROM memory_audit WHERE memory_id=$1 ORDER BY created_at DESC,id DESC LIMIT 51 OFFSET $2", [id, offset]);
    return { items: result.rows.slice(0, 50).map((row) => ({ id: String(row.id), memoryId: String(row.memory_id), revision: number(row.revision),
      actorId: String(row.actor_id), action: row.action as MemoryAuditAction, createdAt: number(row.created_at) })), hasMore: result.rows.length > 50 };
  }

  public async shares(identity: ExecutionIdentity, id: string): Promise<Array<{ id: string; revision: number; targetAppId: string; expiresAt: number; revoked: boolean }>> {
    memoryPermission(identity, "memory.share");
    await this.#managed(this.pool, identity, id);
    const result = await this.pool.query<Row>("SELECT * FROM memory_shares WHERE memory_id=$1 ORDER BY created_at DESC LIMIT 100", [id]);
    return result.rows.map((row) => ({ id: String(row.id), revision: number(row.revision), targetAppId: String(row.target_app), expiresAt: number(row.expires_at), revoked: bool(row.revoked) }));
  }
}

function numberOrNull(value: unknown): number | null { return value === null || value === undefined ? null : number(value); }
