import { assertExecutionIdentity, snapshotExecutionIdentity, type ExecutionIdentity } from "@daoyin/harness-contracts";
import { wireMessages, type ModelReply } from "@daoyin/harness-agent-core";
import { createCloudServer, type CloudServerOptions } from "./app.js";
import { createCompanyPublicProfile, isCompanyPublicIdentity, COMPANY_KNOWLEDGE_TOOL, parseCompanyKnowledgeQuery } from "./company-profile.js";
import { CloudError } from "./repository.js";
import { createSaishiProfile, isSaishiIdentity } from "./saishi-profile.js";
import { createStoryProfile, isStoryIdentity } from "./story-profile.js";
import { createWorkbenchProfile, isWorkbenchIdentity } from "./workbench-profile.js";
import { readModelStream } from "./model-stream.js";

export interface PlatformAdapterOptions {
  /** Fixed trusted origin, HTTPS except explicit loopback development. */
  platformUrl: string;
  serviceToken: string;
  /** Optional and separate from the public sponsor key. No fallback between them. */
  appServiceToken?: string;
  fetch?: typeof fetch;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type CallPolicy = (name: string, input: Record<string, unknown>) => boolean;
function reply(value: unknown, appPolicy?: CallPolicy): ModelReply {
  if (!record(value) || value.schemaVersion !== 1 || !record(value.output)) throw new Error("Invalid model response.");
  const output = value.output;
  if (typeof output.content !== "string" || output.content.length > 16_000) throw new Error("Invalid model text.");
  if (output.kind === "assistant") return { kind: "assistant", content: output.content };
  if (output.kind !== "tool_calls" || !Array.isArray(output.calls) || output.calls.length < 1 || output.calls.length > 4) throw new Error("Invalid model calls.");
  const seen = new Set<string>();
  const calls = output.calls.map((call) => {
    if (!record(call) || typeof call.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(call.id) || seen.has(call.id) ||
        typeof call.name !== "string" || !record(call.input)) throw new Error("Invalid model tool.");
    seen.add(call.id);
    if (appPolicy !== undefined) {
      if (!appPolicy(call.name, call.input)) throw new Error("Model tool is outside the application grant.");
      return { id: call.id, name: call.name, input: call.input };
    }
    if (call.name !== COMPANY_KNOWLEDGE_TOOL) throw new Error("Invalid public model tool.");
    return { id: call.id, name: call.name, input: { ...parseCompanyKnowledgeQuery(call.input) } };
  });
  return { kind: "tool_calls", content: output.content, calls };
}

type BridgePath = "introspect" | "authorize" | "model" | "search" | "profile" | "call" | "authorize-tool" | "health";

/** No credentials are attached to identities, run records, tool results or errors. */
export function createPlatformAdapters(options: PlatformAdapterOptions): Pick<CloudServerOptions, "authenticate" | "isAuthorizationActive" | "resolveProfile" | "createModel" | "checkPlatform"> {
  const base = new URL(options.platformUrl);
  if (base.username || base.password || base.search || base.hash || base.pathname !== "/" ||
      (base.protocol !== "https:" && !(base.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(base.hostname))) ||
      !/^[\x21-\x7e]{32,256}$/u.test(options.serviceToken)) throw new Error("Invalid trusted platform configuration.");
  if (options.appServiceToken !== undefined && (!/^[\x21-\x7e]{32,256}$/u.test(options.appServiceToken) || options.appServiceToken === options.serviceToken)) throw new Error("Invalid private application service key.");
  const transport = options.fetch ?? fetch;

  async function post(path: BridgePath, input: unknown, parent: AbortSignal, privateApp = false, onTextDelta?: (delta: string) => Promise<void>): Promise<unknown> {
    parent.throwIfAborted();
    const secret = privateApp ? options.appServiceToken : options.serviceToken;
    if (!secret) throw new CloudError(503, "APP_BRIDGE_DISABLED", "私有业务插件尚未配置。");
    if ((!privateApp && ["profile", "call", "authorize-tool"].includes(path)) || (privateApp && path === "search")) throw new Error("Invalid bridge path.");
    const duration = ["model", "search"].includes(path) ? 90_000 : ["profile", "call", "authorize-tool"].includes(path) ? (path === "call" ? 100_000 : 30_000) : 5_000;
    const signal = AbortSignal.any([parent, AbortSignal.timeout(duration)]);
    try {
      const response = await transport(new URL(`/api/internal/${privateApp ? "agent-apps" : "agent-public"}/v1/${path}`, base), {
        method: "POST", redirect: "error", signal,
        headers: { "content-type": "application/json", "x-agent-service-token": secret, ...(onTextDelta ? { Accept: "application/x-ndjson" } : {}) }, body: JSON.stringify(input),
      });
      if (!response.ok) {
        const status = [400, 401, 402, 403, 404, 409, 413, 429].includes(response.status) ? response.status : 503;
        let message = "平台授权或业务调用未完成，请保留原请求标识。";
        if (privateApp && path === "call") {
          const detail: unknown = await response.json().catch(() => null);
          if (record(detail) && record(detail.detail) && detail.detail.code === "STORY_OPERATION_FAILED" &&
              typeof detail.detail.message === "string" && detail.detail.message.length <= 600) message = detail.detail.message;
        } else await response.body?.cancel();
        throw new CloudError(status, "PLATFORM_BRIDGE_REJECTED", message);
      }
      if (onTextDelta && response.headers.get("content-type")?.includes("application/x-ndjson")) return await readModelStream(response, onTextDelta, signal);
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

  const publicProfile = createCompanyPublicProfile({
    search: async (input, context, signal) => post("search", {
      authorizationId: context.identity.authorizationId, runId: context.runId, operationId: context.operationId, input,
    }, signal),
  });
  async function privateProfile(identity: ExecutionIdentity, signal: AbortSignal) {
    const catalog = await post("profile", { authorizationId: identity.authorizationId }, signal, true);
    const factory = isWorkbenchIdentity(identity) ? createWorkbenchProfile : isStoryIdentity(identity) ? createStoryProfile : createSaishiProfile;
    return factory(catalog, identity, {
      authorize: async (name, input, current, operationId, childSignal) => {
        const value = await post("authorize-tool", { authorizationId: current.authorizationId, name, arguments: input,
          runId: "resource_check", operationId }, childSignal, true);
        return record(value) && value.allowed === true;
      },
      call: async (name, input, current, runId, operationId, childSignal) => post("call", {
        authorizationId: current.authorizationId, name, arguments: input, runId, operationId,
      }, childSignal, true),
    });
  }
  return {
    checkPlatform: async (signal) => {
      for (const privateApp of options.appServiceToken ? [false, true] : [false]) {
        const value = await post("health", {}, signal, privateApp);
        if (!record(value) || value.schemaVersion !== 1 || value.status !== "ok") throw new Error("Platform bridge is not ready.");
      }
    },
    authenticate: async (bearer, signal) => {
      const privateApp = /^(?:saishi|story)_agent_/u.test(bearer);
      if (privateApp && !/^(?:saishi|story)_agent_[A-Za-z0-9_-]{64}$/u.test(bearer)) return null;
      const value = await post("introspect", { bearer }, signal, privateApp);
      if (!record(value)) return null;
      assertExecutionIdentity(value.identity);
      if (privateApp ? !(isSaishiIdentity(value.identity) || isStoryIdentity(value.identity) || isWorkbenchIdentity(value.identity)) : !isCompanyPublicIdentity(value.identity)) return null;
      return snapshotExecutionIdentity(value.identity);
    },
    isAuthorizationActive: async (identity: ExecutionIdentity, signal) => {
      const privateApp = isSaishiIdentity(identity) || isStoryIdentity(identity) || isWorkbenchIdentity(identity);
      if (!privateApp && !isCompanyPublicIdentity(identity)) return false;
      const value = await post("authorize", { identity }, signal, privateApp);
      return record(value) && value.active === true;
    },
    resolveProfile: async (identity, signal) => {
      if (isSaishiIdentity(identity) || isStoryIdentity(identity) || isWorkbenchIdentity(identity)) return privateProfile(identity, signal);
      if (!isCompanyPublicIdentity(identity)) throw new CloudError(403, "APP_ACCESS_DENIED", "未开通当前应用。");
      return publicProfile;
    },
    createModel: async (identity, run, signal) => {
      const privateApp = isSaishiIdentity(identity) || isStoryIdentity(identity) || isWorkbenchIdentity(identity);
      if ((!privateApp && !isCompanyPublicIdentity(identity)) || run.authorizationId !== identity.authorizationId || run.billingAccountId !== identity.billingAccountId) {
        throw new CloudError(403, "RUN_IDENTITY_MISMATCH", "任务授权不匹配。");
      }
      const bindings = privateApp ? (await privateProfile(identity, signal)).tools : [];
      let step = 0;
      return { complete: async (request) => {
        step += 1;
        const value = await post("model", {
          authorizationId: identity.authorizationId, runId: run.id, operationId: `model_${String(step)}`,
          input: { schemaVersion: 1, messages: wireMessages(request),
            tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
            systemPrompt: request.systemPrompt },
        }, request.signal, privateApp, request.onTextDelta);
        return reply(value, privateApp ? (name, input) => request.tools.some((tool) => tool.name === name) &&
          bindings.some((binding) => binding.definition.name === name && binding.validateInput(input)) : undefined);
      } };
    },
  };
}

export function createPlatformCloudServer(options: PlatformAdapterOptions & Pick<CloudServerOptions, "repository" | "maxConcurrentRuns" | "runTimeoutMs" | "buildInfo">): ReturnType<typeof createCloudServer> {
  return createCloudServer({ ...createPlatformAdapters(options), repository: options.repository,
    ...(options.buildInfo === undefined ? {} : { buildInfo: options.buildInfo }),
    ...(options.maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns: options.maxConcurrentRuns }),
    ...(options.runTimeoutMs === undefined ? {} : { runTimeoutMs: options.runTimeoutMs }),
  });
}
