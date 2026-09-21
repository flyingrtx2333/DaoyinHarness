import { isProjectAccountIdentity } from "./projects/profile.js";
import { isProjectTool, validateProjectInput } from "./projects/tools.js";
import { assertExecutionIdentity, snapshotExecutionIdentity, type ExecutionIdentity } from "@daoyin/harness-contracts";
import { wireMessages, type ModelReply } from "@daoyin/harness-agent-core";
import { createCloudServer, type CloudServerOptions } from "./app.js";
import { createCompanyPublicProfile, isCompanyPublicIdentity, COMPANY_KNOWLEDGE_TOOL, parseCompanyKnowledgeQuery } from "./company-profile.js";
import { CloudError } from "./repository.js";
import { createSaishiProfile, isSaishiIdentity } from "./saishi-profile.js";
import { createStoryProfile, isStoryIdentity } from "./story-profile.js";
import { createWorkbenchProfile, isWorkbenchIdentity } from "./workbench-profile.js";
import { readModelStream } from "./model-stream.js";
import { isCloudOrchestrationToolName } from "./cloud-orchestration.js";
import { RESOURCE_TOOL_NAMES } from "./resources/contracts.js";
import { VIDEO_CONFIRMATION_TOOL, VIDEO_GENERATION_OPERATIONS } from "./video-interaction.js";
import { isMemoryToolName } from "./memory-agent-policy.js";
import { validateMemoryToolInput } from "./memory-tools.js";

/**
 * @fileoverview 道引主平台适配器与网关桥梁
 * @description
 * 负责通过 HTTPS 专用回环通信连接道引主平台内部 API 网关（`/api/internal/agent-*`）：
 * 1. **身份自省（Introspect）**：验证客户端 Token 并获取 `ExecutionIdentity`。
 * 2. **实时授权校验（Authorize）**：毫秒级向平台确认会话所属空间、租户及出资方账号依然有效。
 * 3. **模型推理代理（Model Gateway）**：将 Agent 内部标准消息序列转换为平台计量协议，支持 NDJSON 流式输出。
 * 4. **能力语义路由分析（Capability Semantic）**：调用主平台的向量检索与语义 Rerank 服务筛选工具。
 * 5. **业务工具中继（Tool Bridge）**：转发短剧、赛事、工作台私有插件的操作请求与细粒度鉴权。
 */

export interface PlatformAdapterOptions {
  /** 可信的主平台基准 URL（生产环境必须为 HTTPS，本地回环开发支持 127.0.0.1） */
  platformUrl: string;
  /** 公共业务服务密钥（用于访问公共知识库等） */
  serviceToken: string;
  /**
   * 私有业务应用专属服务密钥（用于访问赛事、剧情等高权限业务系统）
   * 注意：私有密钥与公共密钥物理隔离，不可相同
   */
  appServiceToken?: string;
  /** 可选的自定义 fetch 函数（用于单测或特定网络拦截） */
  fetch?: typeof fetch;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type CallPolicy = (name: string, input: Record<string, unknown>) => boolean;
const RESOURCE_TOOLS = new Set<string>(RESOURCE_TOOL_NAMES);

/**
 * 校验大模型产生的工具调用（Tool Call）是否符合安全策略与参数模式
 *
 * @param name 工具名称
 * @param input 模型传入的实参字典
 * @param requestTools 本轮提供给模型的工具候选列表
 * @param bindings 绑定的业务工具执行器与校验器集合
 * @returns 是否允许调用该工具
 *
 * @example
 * ```ts
 * const allowed = privateModelCallAllowed(
 *   "story_create_video",
 *   { storyId: "st_123", prompt: "日落黄昏" },
 *   requestTools,
 *   bindings,
 * );
 * ```
 */
export function privateModelCallAllowed(name: string, input: Record<string, unknown>,
  requestTools: ReadonlyArray<{ name: string }>, bindings: ReadonlyArray<{ definition: { name: string }; validateInput(input: Record<string, unknown>): boolean }>): boolean {
  if (!requestTools.some((tool) => tool.name === name)) return false;
  if (name === "capability_search") return Object.keys(input).length === 1 &&
    typeof input.query === "string" && input.query.trim().length > 0 && input.query.length <= 500;
  if (isProjectTool(name)) return validateProjectInput(name, input);
  if (isMemoryToolName(name)) return validateMemoryToolInput(name, input);
  if (RESOURCE_TOOLS.has(name) || isCloudOrchestrationToolName(name)) return true;
  const direct = bindings.find((binding) => binding.definition.name === name);
  if (direct !== undefined) return direct.validateInput(input);
  if (name !== VIDEO_CONFIRMATION_TOOL || typeof input.operation !== "string" || !VIDEO_GENERATION_OPERATIONS.has(input.operation) ||
      !record(input.input)) return false;
  const generation = bindings.find((binding) => binding.definition.name === input.operation);
  return generation !== undefined && generation.validateInput(input.input);
}

/**
 * 校验并解析主平台模型网关的原始 JSON 响应
 *
 * @param value 平台返回的原始报文
 * @param appPolicy 业务工具安全策略校验器
 * @returns 规范化的 ModelReply 结果
 *
 * @example 纯文本响应示例
 * ```json
 * { "kind": "assistant", "content": "我已经为您梳理了大纲。" }
 * ```
 * @example 工具调用响应示例
 * ```json
 * {
 *   "kind": "tool_calls",
 *   "content": "正在检索相关素材",
 *   "calls": [
 *     { "id": "call_abc123", "name": "story_call", "input": { "storyId": "st_001" } }
 *   ]
 * }
 * ```
 */
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

type BridgePath = "introspect" | "authorize" | "model" | "search" | "profile" | "call" |
  "authorize-tool" | "capability-semantic" | "health";


/**
 * 创建与道引主平台互联的一组适配器实现
 *
 * 核心安全机制：
 * 1. 凭据绝不持久化在本地身份、Run 记录、事件流或工具执行回执中。
 * 2. 身份解析通过 `introspect` 端点，严禁接受客户端请求体中伪造的身份信息。
 * 3. 私有业务应用（短剧/赛事/工作台）与公共应用（企业公共知识库）在不同通道隔离交互。
 *
 * @param options 平台连接配置
 * @returns 适配器对象，可直接注入 `CloudServerOptions`
 *
 * @example
 * ```ts
 * const adapters = createPlatformAdapters({
 *   platformUrl: "https://api.daoyin.internal",
 *   serviceToken: process.env.DAOYIN_SERVICE_TOKEN!,
 *   appServiceToken: process.env.DAOYIN_APP_SERVICE_TOKEN!,
 * });
 * ```
 */
export function createPlatformAdapters(options: PlatformAdapterOptions): Pick<CloudServerOptions, "authenticate" | "isAuthorizationActive" | "resolveProfile" | "createModel" | "createCapabilitySemantic" | "checkPlatform"> {
  const base = new URL(options.platformUrl);
  if (base.username || base.password || base.search || base.hash || base.pathname !== "/" ||
      (base.protocol !== "https:" && !(base.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(base.hostname))) ||
      !/^[\x21-\x7e]{32,256}$/u.test(options.serviceToken)) throw new Error("Invalid trusted platform configuration.");
  if (options.appServiceToken !== undefined && (!/^[\x21-\x7e]{32,256}$/u.test(options.appServiceToken) || options.appServiceToken === options.serviceToken)) throw new Error("Invalid private application service key.");
  const transport = options.fetch ?? fetch;

  /** 封装对平台内部网关的安全 POST 请求 */
  async function post(path: BridgePath, input: unknown, parent: AbortSignal, privateApp = false, onTextDelta?: (delta: string) => Promise<void>): Promise<unknown> {
    parent.throwIfAborted();
    const secret = privateApp ? options.appServiceToken : options.serviceToken;
    if (!secret) throw new CloudError(503, "APP_BRIDGE_DISABLED", "私有业务插件尚未配置。");
    if ((!privateApp && ["profile", "call", "authorize-tool"].includes(path)) || (privateApp && path === "search")) throw new Error("Invalid bridge path.");
    const duration = path === "model" ? 160_000 : path === "search" ? 90_000 : ["profile", "call", "authorize-tool"].includes(path) ? (path === "call" ? 100_000 : 30_000) : 5_000;
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
    if (isProjectAccountIdentity(identity)) return {id:"daoyin-workbench",version:"1",instructions:"使用当前账号的独立云端项目工具开发与发布应用。所有代码执行均通过隔离执行服务。",tools:[]};
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
      if (privateApp ? !(isSaishiIdentity(value.identity) || isStoryIdentity(value.identity) || isWorkbenchIdentity(value.identity) || isProjectAccountIdentity(value.identity)) : !isCompanyPublicIdentity(value.identity)) return null;
      return snapshotExecutionIdentity(value.identity);
    },
    isAuthorizationActive: async (identity: ExecutionIdentity, signal) => {
      const privateApp = isSaishiIdentity(identity) || isStoryIdentity(identity) || isWorkbenchIdentity(identity) || isProjectAccountIdentity(identity);
      if (!privateApp && !isCompanyPublicIdentity(identity)) return false;
      const value = await post("authorize", { identity }, signal, privateApp);
      return record(value) && value.active === true;
    },
    resolveProfile: async (identity, signal) => {
      if (isSaishiIdentity(identity) || isStoryIdentity(identity) || isWorkbenchIdentity(identity) || isProjectAccountIdentity(identity)) return privateProfile(identity, signal);
      if (!isCompanyPublicIdentity(identity)) throw new CloudError(403, "APP_ACCESS_DENIED", "未开通当前应用。");
      return publicProfile;
    },
    createCapabilitySemantic: (identity, run) => ({
      retrieve: async (input) => {
        const privateApp = isSaishiIdentity(identity) || isStoryIdentity(identity) ||
          isWorkbenchIdentity(identity) || isProjectAccountIdentity(identity);
        if (!privateApp || run.authorizationId !== identity.authorizationId ||
            run.billingAccountId !== identity.billingAccountId) {
          throw new CloudError(403, "RUN_IDENTITY_MISMATCH", "任务授权不匹配。");
        }
        const value = await post("capability-semantic", {
          authorizationId: identity.authorizationId, runId: run.id, operationId: "capability_vector",
          input: { schemaVersion: 1, operation: "retrieve", query: input.query, clauses: input.clauses,
            candidates: input.candidates.map((pack) => ({
              id: pack.id, title: pack.title, summary: pack.summary, intents: pack.intents,
              examples: pack.examples, negativeExamples: pack.negativeExamples,
              resourceKinds: pack.resourceKinds, risk: pack.risk,
            })) },
        }, input.signal, true);
        if (!record(value) || value.schemaVersion !== 1 || !record(value.vectorScores)) {
          throw new Error("Invalid capability vector response.");
        }
        return value.vectorScores as Record<string, number>;
      },
      analyze: async (input) => {
        const privateApp = isSaishiIdentity(identity) || isStoryIdentity(identity) ||
          isWorkbenchIdentity(identity) || isProjectAccountIdentity(identity);
        if (!privateApp || run.authorizationId !== identity.authorizationId ||
            run.billingAccountId !== identity.billingAccountId) {
          throw new CloudError(403, "RUN_IDENTITY_MISMATCH", "任务授权不匹配。");
        }
        const value = await post("capability-semantic", {
          authorizationId: identity.authorizationId, runId: run.id, operationId: "capability_route",
          input: { schemaVersion: 1, operation: "analyze", query: input.query, clauses: input.clauses,
            candidates: input.candidates.map((pack) => ({
              id: pack.id, title: pack.title, summary: pack.summary, intents: pack.intents,
              examples: pack.examples, negativeExamples: pack.negativeExamples,
              resourceKinds: pack.resourceKinds, risk: pack.risk,
            })) },
        }, input.signal, true);
        if (!record(value) || value.schemaVersion !== 1 || !record(value.rerankScores) ||
            !Array.isArray(value.intents)) throw new Error("Invalid capability semantic response.");
        return { rerankScores: value.rerankScores as Record<string, number>,
          intents: value.intents as Array<{ label: string; objective: string; confidence: number; packIds: string[] }> };
      },
    }),
    createModel: async (identity, run, signal) => {
      const privateApp = isSaishiIdentity(identity) || isStoryIdentity(identity) || isWorkbenchIdentity(identity) || isProjectAccountIdentity(identity);
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
        return reply(value, privateApp ? (name, input) => privateModelCallAllowed(name, input, request.tools, bindings) : undefined);
      } };
    },
  };
}

/**
 * 快速创建具备平台鉴权、模型网关与业务 Profile 绑定的完整 Fastify 云端服务
 *
 * @param options 平台连接配置与基础服务配置
 * @returns Fastify 服务实例
 *
 * @example
 * ```ts
 * const app = createPlatformCloudServer({
 *   platformUrl: "https://api.daoyin.com",
 *   serviceToken: "sec_platform_pub_xxx",
 *   appServiceToken: "sec_platform_app_xxx",
 *   repository: new PostgresCloudRepository({ connectionString: "..." }),
 * });
 * await app.listen({ host: "127.0.0.1", port: 4677 });
 * ```
 */
export function createPlatformCloudServer(options: PlatformAdapterOptions & Pick<CloudServerOptions, "repository" | "maxConcurrentRuns" | "runTimeoutMs" | "buildInfo" | "capabilityRouterMode" | "generalResourcesMode" | "telemetry">): ReturnType<typeof createCloudServer> {
  return createCloudServer({ ...createPlatformAdapters(options), repository: options.repository,
    ...(options.buildInfo === undefined ? {} : { buildInfo: options.buildInfo }),
    ...(options.maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns: options.maxConcurrentRuns }),
    ...(options.runTimeoutMs === undefined ? {} : { runTimeoutMs: options.runTimeoutMs }),
    ...(options.capabilityRouterMode === undefined ? {} : { capabilityRouterMode: options.capabilityRouterMode }),
    ...(options.generalResourcesMode === undefined ? {} : { generalResourcesMode: options.generalResourcesMode }),
    ...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
  });
}

