import { assertExecutionIdentity, snapshotExecutionIdentity, type ExecutionIdentity } from "@daoyin/harness-contracts";
import type { ModelReply } from "@daoyin/harness-agent-core";
import { createCloudServer, type CloudServerOptions } from "./app.js";
import { createCompanyPublicProfile, isCompanyPublicIdentity, COMPANY_KNOWLEDGE_TOOL, parseCompanyKnowledgeQuery } from "./company-profile.js";
import { CloudError } from "./repository.js";

export interface PlatformAdapterOptions {
  /** Fixed trusted origin, HTTPS except explicit loopback development. */
  platformUrl: string;
  serviceToken: string;
  fetch?: typeof fetch;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reply(value: unknown): ModelReply {
  if (!record(value) || value.schemaVersion !== 1 || !record(value.output)) throw new Error("Invalid model response.");
  const output = value.output;
  if (typeof output.content !== "string" || output.content.length > 16_000) throw new Error("Invalid model text.");
  if (output.kind === "assistant") return { kind: "assistant", content: output.content };
  if (output.kind !== "tool_calls" || !Array.isArray(output.calls) || output.calls.length < 1 || output.calls.length > 4) throw new Error("Invalid model calls.");
  const seen = new Set<string>();
  const calls = output.calls.map((call) => {
    if (!record(call) || typeof call.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(call.id) || seen.has(call.id) ||
        call.name !== COMPANY_KNOWLEDGE_TOOL || !record(call.input)) throw new Error("Invalid model tool.");
    seen.add(call.id);
    return { id: call.id, name: call.name, input: { ...parseCompanyKnowledgeQuery(call.input) } };
  });
  return { kind: "tool_calls", content: output.content, calls };
}

/** No credentials are attached to identities, run records, tool results or errors. */
export function createPlatformAdapters(options: PlatformAdapterOptions): Pick<CloudServerOptions, "authenticate" | "isAuthorizationActive" | "resolveProfile" | "createModel"> {
  const base = new URL(options.platformUrl);
  if (base.username || base.password || base.search || base.hash || base.pathname !== "/" ||
      (base.protocol !== "https:" && !(base.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(base.hostname))) ||
      !/^[\x21-\x7e]{32,256}$/u.test(options.serviceToken)) throw new Error("Invalid trusted platform configuration.");
  const transport = options.fetch ?? fetch;

  async function post(path: "introspect" | "authorize" | "model" | "search", input: unknown, parent: AbortSignal): Promise<unknown> {
    parent.throwIfAborted();
    const signal = AbortSignal.any([parent, AbortSignal.timeout(path === "model" || path === "search" ? 90_000 : 5_000)]);
    let response: Response;
    try {
      response = await transport(new URL(`/api/internal/agent-public/v1/${path}`, base), {
        method: "POST", redirect: "error", signal,
        headers: { "content-type": "application/json", "x-agent-service-token": options.serviceToken },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const status = [401, 403, 409, 429].includes(response.status) ? response.status : 503;
        throw new CloudError(status, "PLATFORM_BRIDGE_REJECTED", "平台授权或业务调用未完成，请保留原请求标识。");
      }
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error("Empty platform response.");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 96_000) throw new Error("Platform response too large.");
          chunks.push(next.value);
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
      signal.throwIfAborted();
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch (error) {
      if (error instanceof CloudError) throw error;
      throw new CloudError(503, "PLATFORM_BRIDGE_UNAVAILABLE", "平台业务接口暂不可用；本次请求未自动重试。");
    }
  }

  const profile = createCompanyPublicProfile({
    search: async (input, context, signal) => post("search", {
      authorizationId: context.identity.authorizationId, runId: context.runId, operationId: context.operationId, input,
    }, signal),
  });
  return {
    authenticate: async (bearer, signal) => {
      const value = await post("introspect", { bearer }, signal);
      if (!record(value)) return null;
      assertExecutionIdentity(value.identity);
      if (!isCompanyPublicIdentity(value.identity)) return null;
      return snapshotExecutionIdentity(value.identity);
    },
    isAuthorizationActive: async (identity: ExecutionIdentity, signal) => {
      if (!isCompanyPublicIdentity(identity)) return false;
      const value = await post("authorize", { identity }, signal);
      return record(value) && value.active === true;
    },
    resolveProfile: async (identity) => {
      if (!isCompanyPublicIdentity(identity)) throw new CloudError(403, "APP_ACCESS_DENIED", "未开通当前应用。");
      return profile;
    },
    createModel: async (identity, run) => {
      if (!isCompanyPublicIdentity(identity) || run.authorizationId !== identity.authorizationId || run.billingAccountId !== identity.billingAccountId) {
        throw new CloudError(403, "RUN_IDENTITY_MISMATCH", "任务授权不匹配。");
      }
      let step = 0;
      return { complete: async (request) => {
        step += 1;
        const value = await post("model", {
          authorizationId: identity.authorizationId, runId: run.id, operationId: `model_${String(step)}`,
          input: { schemaVersion: 1, messages: request.messages,
            tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
            systemPrompt: request.systemPrompt },
        }, request.signal);
        return reply(value);
      } };
    },
  };
}

export function createPlatformCloudServer(options: PlatformAdapterOptions & Pick<CloudServerOptions, "repository" | "maxConcurrentRuns" | "runTimeoutMs">): ReturnType<typeof createCloudServer> {
  return createCloudServer({ ...createPlatformAdapters(options), repository: options.repository,
    ...(options.maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns: options.maxConcurrentRuns }),
    ...(options.runTimeoutMs === undefined ? {} : { runTimeoutMs: options.runTimeoutMs }),
  });
}
