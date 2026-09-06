import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ExecutionIdentity } from "@daoyin/harness-contracts";
import { CloudError, type CloudRepository } from "./repository.js";
import { memoryPermission, type DurableMemoryScope, type MemoryProposal, type MemorySource } from "./memory-policy.js";

export interface MemoryRouteOptions {
  repository: CloudRepository;
  identityFor(request: FastifyRequest): ExecutionIdentity;
  ensureActive(identity: ExecutionIdentity, signal?: AbortSignal): Promise<void>;
  /** Must check the installed target belongs to this same personal/enterprise space. */
  authorizeShareTarget?(identity: ExecutionIdentity, targetAppId: string, signal: AbortSignal): Promise<boolean>;
}
const identifier = { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9_.:@-]*$" };
const revision = { type: "integer", minimum: 1, maximum: 1000000 };
const idParams = { type: "object", required: ["id"], additionalProperties: false, properties: { id: identifier } };
const revisionBody = { type: "object", required: ["revision"], additionalProperties: false, properties: { revision } };

/** Safe for an authenticated BFF to use when deciding whether to show memory management. */
export interface MemoryCapabilities {
  enabled: boolean;
  canRead: boolean;
  canWrite: boolean;
  canShare: boolean;
  sharingTargetCheckAvailable: boolean;
  scopes: DurableMemoryScope[];
}

function capabilities(identity: ExecutionIdentity, storageAvailable: boolean, sharingTargetCheckAvailable: boolean): MemoryCapabilities {
  const enabled = storageAvailable && identity.space.kind !== "public";
  const canRead = enabled && identity.permissions.includes("memory.read");
  const canWrite = enabled && identity.permissions.includes("memory.write");
  const canShare = enabled && identity.permissions.includes("memory.share") && sharingTargetCheckAvailable;
  const scopes: DurableMemoryScope[] = [];
  if (canWrite) {
    scopes.push("application");
    if (identity.space.kind === "personal") scopes.push("personal");
    if (identity.space.kind === "organization" && identity.permissions.includes("memory.organization.write")) scopes.push("organization");
  }
  return { enabled, canRead, canWrite, canShare, sharingTargetCheckAvailable, scopes };
}

/** User management only. These routes are never added to the model-facing tool registry. */
export function registerMemoryRoutes(app: FastifyInstance, options: MemoryRouteOptions): void {
  const prefix = "/api/v1/cloud/memories";
  async function scope(request: FastifyRequest) {
    const identity = options.identityFor(request);
    if (identity.space.kind === "public") throw new CloudError(403, "MEMORY_ACCESS_DENIED", "公开访客入口不开放私人长期记忆。");
    const memory = options.repository.memory;
    if (memory === undefined) throw new CloudError(503, "MEMORY_UNAVAILABLE", "当前运行环境未配置长期记忆存储。");
    await options.ensureActive(identity);
    return { identity, memory };
  }

  app.get(`${prefix}/capabilities`, async (request) => {
    const identity = options.identityFor(request);
    await options.ensureActive(identity);
    return capabilities(identity, options.repository.memory !== undefined, options.authorizeShareTarget !== undefined);
  });

  app.get<{ Querystring: { offset?: string } }>(prefix, { schema: { querystring: {
    type: "object", additionalProperties: false, properties: { offset: { type: "string", pattern: "^[0-9]{1,4}$" } },
  } } }, async (request) => {
    const { identity, memory } = await scope(request);
    return await memory.list(identity, Number(request.query.offset ?? "0"));
  });

  app.post<{ Body: { query: string; limit?: number } }>(`${prefix}/search`, { schema: { body: {
    type: "object", additionalProperties: false, required: ["query"], properties: {
      query: { type: "string", minLength: 1, maxLength: 500 }, limit: { type: "integer", minimum: 1, maximum: 12 },
    },
  } } }, async (request) => {
    const { identity, memory } = await scope(request);
    return { hits: await memory.search(identity, request.body.query, request.body.limit) };
  });

  app.post<{ Body: MemoryProposal & { source?: Omit<MemorySource, "kind" | "requestId"> } }>(prefix, { schema: { body: {
    type: "object", additionalProperties: false, required: ["requestId", "key", "scope", "kind", "content"], properties: {
      requestId: identifier, key: { type: "string", minLength: 1, maxLength: 120 },
      scope: { type: "string", enum: ["application", "personal", "organization"] },
      kind: { type: "string", enum: ["preference", "fact", "goal", "decision", "note"] },
      content: { type: "string", minLength: 1, maxLength: 2000 },
      keywords: { type: "array", maxItems: 16, items: { type: "string", maxLength: 64 } },
      expiresAt: { type: "integer", minimum: 1 },
      replaces: { type: "object", required: ["id", "revision"], additionalProperties: false, properties: { id: identifier, revision } },
      source: { type: "object", required: ["sessionId", "turnId", "eventId"], additionalProperties: false,
        properties: { sessionId: identifier, turnId: identifier, eventId: identifier } },
    },
  } } }, async (request, reply) => {
    const { identity, memory } = await scope(request);
    const { source, ...proposal } = request.body;
    const result = await memory.propose(identity, proposal, source === undefined ? undefined : {
      kind: "conversation", requestId: proposal.requestId, ...source,
    });
    return reply.code(201).send({ memory: result, requiresConfirmation: result.state === "pending" });
  });

  app.post<{ Params: { id: string }; Body: { revision: number } }>(`${prefix}/:id/confirm`, {
    schema: { params: idParams, body: revisionBody },
  }, async (request) => {
    const { identity, memory } = await scope(request);
    return { memory: await memory.confirm(identity, request.params.id, request.body.revision) };
  });
  app.get<{ Params: { id: string } }>(`${prefix}/:id`, { schema: { params: idParams } }, async (request) => {
    const { identity, memory } = await scope(request);
    return { memory: await memory.get(identity, request.params.id) };
  });
  app.post<{ Params: { id: string }; Body: { revision: number } }>(`${prefix}/:id/reject`, {
    schema: { params: idParams, body: revisionBody },
  }, async (request) => {
    const { identity, memory } = await scope(request);
    return { memory: await memory.reject(identity, request.params.id, request.body.revision) };
  });
  app.post<{ Params: { id: string }; Body: { revision: number } }>(`${prefix}/:id/forget`, {
    schema: { params: idParams, body: revisionBody },
  }, async (request) => {
    const { identity, memory } = await scope(request);
    return { memory: await memory.forget(identity, request.params.id, request.body.revision) };
  });
  app.get<{ Params: { id: string } }>(`${prefix}/:id/shares`, { schema: { params: idParams } }, async (request) => {
    const { identity, memory } = await scope(request);
    return { shares: await memory.shares(identity, request.params.id) };
  });
  app.get<{ Params: { id: string }; Querystring: { offset?: string } }>(`${prefix}/:id/audit`, { schema: { params: idParams, querystring: {
    type: "object", additionalProperties: false, properties: { offset: { type: "string", pattern: "^[0-9]{1,4}$" } },
  } } }, async (request) => {
    const { identity, memory } = await scope(request);
    return await memory.audit(identity, request.params.id, Number(request.query.offset ?? "0"));
  });
  app.post<{ Params: { id: string }; Body: { revision: number; targetAppId: string; expiresAt: number } }>(`${prefix}/:id/shares`, {
    schema: { params: idParams, body: { type: "object", required: ["revision", "targetAppId", "expiresAt"], additionalProperties: false,
      properties: { revision, targetAppId: identifier, expiresAt: { type: "integer", minimum: 1 } } } },
  }, async (request) => {
    const { identity, memory } = await scope(request);
    memoryPermission(identity, "memory.share");
    const checker = options.authorizeShareTarget;
    if (checker === undefined) throw new CloudError(503, "MEMORY_TARGET_POLICY_UNAVAILABLE", "平台尚未配置跨应用记忆授权检查。");
    const signal = AbortSignal.timeout(5000);
    const allowed = await checker(identity, request.body.targetAppId, signal);
    signal.throwIfAborted();
    await options.ensureActive(identity);
    if (!allowed) throw new CloudError(403, "MEMORY_TARGET_DENIED", "目标应用未开通或不属于当前空间。");
    return { share: await memory.share(identity, request.params.id, request.body.revision, request.body.targetAppId, request.body.expiresAt) };
  });
  app.post<{ Params: { id: string }; Body: Record<string, never> }>(`${prefix}/shares/:id/revoke`, {
    schema: { params: idParams, body: { type: "object", additionalProperties: false } },
  }, async (request) => {
    const { identity, memory } = await scope(request);
    await memory.revokeShare(identity, request.params.id);
    return { revoked: true };
  });
  app.get<{ Params: { runId: string } }>("/api/v1/cloud/runs/:runId/memories", { schema: { params: {
    type: "object", required: ["runId"], additionalProperties: false, properties: { runId: identifier },
  } } }, async (request) => {
    const { identity, memory } = await scope(request);
    const run = await options.repository.getRun(identity, request.params.runId);
    return { references: await memory.references(identity, run.sessionId, run.id), meaning: "prepared_context_not_proof_of_model_use" };
  });
}
