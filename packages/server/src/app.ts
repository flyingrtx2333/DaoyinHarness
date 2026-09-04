import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { AgentEngine, type ModelClient, type SystemPromptRegistry } from "@daoyin/harness-agent-core";
import { JsonlProcessPermissionStore, ProcessService, type ProcessPermissionStore } from "@daoyin/harness-process";
import {
  API_VERSION,
  type ApiError,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type LocalSessionSummary,
  type ProcessPermissionRequest,
  type RuntimeBootstrap,
  type RuntimeHealth,
  type SandboxMode,
  type SandboxRuntimeStatus,
  type SessionEventsResponse,
  type StartTurnRequest,
  type StartTurnResponse,
  type WorkspaceFilesResponse,
  type WorkspaceSummary,
} from "@daoyin/harness-protocol";
import { createMemoryTools, createProcessTools, createSkillTools, createWebTools, createWorkspaceTools, ToolRegistry } from "@daoyin/harness-tools";
import {
  JsonlCompactionStore,
  JsonlMemoryStore,
  JsonlSessionStore,
  JsonSessionCatalog,
  Workspace,
  type MemoryStore,
  type SessionCompactionStore,
} from "@daoyin/harness-workspace";
import { createLocalPromptRegistry, type MemoryContextProvider } from "./prompt-context.js";

export interface CreateAppOptions {
  port: number;
  version: string;
  startedAt: string;
  publicDir?: string;
  dataDir?: string;
  workspaceRoot?: string;
  model?: ModelClient;
  memoryContextProvider?: MemoryContextProvider;
  sandboxMode?: SandboxMode;
  compactionRetainRecentTurns?: number;
  compactionTriggerUncompactedTurns?: number;
  compactionTriggerCharacters?: number;
  compactionMaxSummaryCharacters?: number;
  logger?: FastifyServerOptions["logger"];
}

interface RuntimeState {
  csrfToken: string;
  sessionCookie: string;
  catalog: JsonSessionCatalog | null;
  events: JsonlSessionStore | null;
  workspace: Workspace | null;
  workspaceSummary: WorkspaceSummary | null;
  resourceScopeId: string | null;
  tools: ToolRegistry | null;
  processService: ProcessService | null;
  processPermissions: ProcessPermissionStore | null;
  memoryStore: MemoryStore | null;
  compactionStore: SessionCompactionStore | null;
  promptRegistry: SystemPromptRegistry | null;
  model: ModelClient | null;
  activeTurns: Map<string, AbortController>;
}

function requestId(): string {
  return `req_${crypto.randomUUID()}`;
}

function invalidRequest(code: string, message: string, retryable = false): ApiError {
  return {
    error: {
      code,
      message,
      retryable,
      requestId: requestId(),
      details: {},
    },
  };
}

function allowedOrigin(host: string, origin: string, expectedPort: number): boolean {
  try {
    const hostUrl = new URL(`http://${host}`);
    const originUrl = new URL(origin);
    return (
      hostUrl.hostname === "127.0.0.1" &&
      hostUrl.port === String(expectedPort) &&
      originUrl.origin === hostUrl.origin
    );
  } catch {
    return false;
  }
}

async function directoryExists(directory: string): Promise<boolean> {
  try {
    await access(directory, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function cookieValue(rawCookie: string | undefined, name: string): string | undefined {
  if (rawCookie === undefined) return undefined;
  for (const part of rawCookie.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) return decodeURIComponent(rawValue.join("="));
  }
  return undefined;
}

function sessionCookieHeader(value: string): string {
  return `daoyin_harness_session=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict`;
}

function parsePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "string" || value.length === 0) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseSessionBody(body: unknown): CreateSessionRequest {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw Object.assign(new Error("会话请求格式无效。"), { code: "INVALID_BODY" });
  }
  const title = (body as { title?: unknown }).title;
  if (title !== undefined && typeof title !== "string") {
    throw Object.assign(new Error("title 必须是字符串。"), { code: "INVALID_BODY" });
  }
  return title === undefined ? {} : { title };
}

function parseTurnBody(body: unknown): StartTurnRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw Object.assign(new Error("消息请求格式无效。"), { code: "INVALID_BODY" });
  }
  const candidate = body as { message?: unknown; planning?: unknown };
  const message = candidate.message;
  if (typeof message !== "string" || message.trim().length === 0 || message.length > 20_000) {
    throw Object.assign(new Error("message 必须是 1 到 20000 个字符的字符串。"), { code: "INVALID_BODY" });
  }
  if (candidate.planning !== undefined && typeof candidate.planning !== "boolean") {
    throw Object.assign(new Error("planning 必须是布尔值。"), { code: "INVALID_BODY" });
  }
  return candidate.planning === undefined ? { message: message.trim() } : { message: message.trim(), planning: candidate.planning };
}

function parsePermissionDecisionBody(body: unknown): { approve: boolean } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw Object.assign(new Error("权限决策请求格式无效。"), { code: "INVALID_BODY" });
  }
  const approve = (body as { approve?: unknown }).approve;
  if (typeof approve !== "boolean") throw Object.assign(new Error("approve 必须是布尔值。"), { code: "INVALID_BODY" });
  return { approve };
}

async function createRuntimeState(options: CreateAppOptions): Promise<RuntimeState> {
  const state: RuntimeState = {
    csrfToken: randomBytes(32).toString("base64url"),
    sessionCookie: randomBytes(32).toString("base64url"),
    catalog: null,
    events: null,
    workspace: null,
    workspaceSummary: null,
    resourceScopeId: null,
    tools: null,
    processService: null,
    processPermissions: null,
    memoryStore: null,
    compactionStore: null,
    promptRegistry: null,
    model: options.model ?? null,
    activeTurns: new Map(),
  };

  if (options.dataDir === undefined || options.workspaceRoot === undefined) return state;

  const workspace = await Workspace.open(options.workspaceRoot);
  const files = await workspace.listFiles();
  state.workspace = workspace;
  state.workspaceSummary = {
    name: path.basename(workspace.root) || workspace.root,
    root: workspace.root,
    fileCount: files.length,
  };
  state.resourceScopeId = `resource_${createHash("sha256").update(workspace.root).digest("hex").slice(0, 24)}`;
  state.catalog = new JsonSessionCatalog(path.join(options.dataDir, "state"));
  state.events = new JsonlSessionStore(path.join(options.dataDir, "transcripts"));
  const memoryStore = new JsonlMemoryStore(path.join(options.dataDir, "memory", "memories.jsonl"));
  const compactionStore = new JsonlCompactionStore(path.join(options.dataDir, "compactions"));
  const processService = await ProcessService.create(workspace.root, { sandboxMode: options.sandboxMode ?? "auto" });
  const processPermissions = new JsonlProcessPermissionStore(path.join(options.dataDir, "process", "permissions.jsonl"));
  state.memoryStore = memoryStore;
  state.compactionStore = compactionStore;
  state.processService = processService;
  state.processPermissions = processPermissions;

  const tools = new ToolRegistry();
  tools.registerPack({ id: "workspace", tools: createWorkspaceTools(workspace) });
  tools.registerPack({ id: "process", tools: createProcessTools(processService, processPermissions, workspace) });
  tools.registerPack({ id: "web", tools: createWebTools() });
  tools.registerPack({ id: "skills", tools: createSkillTools(workspace) });
  tools.registerPack({ id: "memory", tools: createMemoryTools(memoryStore) });
  state.tools = tools;

  const memoryContextProvider: MemoryContextProvider = async (input) => {
    const hits = await memoryStore.search({
      accountId: input.accountId,
      sessionId: input.sessionId,
      resourceScopeId: input.scopeId,
      query: input.userMessage,
      limit: 5,
    });
    const builtIn = hits.length === 0 ? null : JSON.stringify(hits.map((hit) => ({
      id: hit.record.id,
      scope: hit.record.scope,
      kind: hit.record.kind,
      content: hit.record.content,
      confidence: hit.record.confidence,
      sourceEventIds: hit.record.sourceEventIds,
      score: hit.score,
    })));
    const external = await options.memoryContextProvider?.(input);
    return [builtIn, external?.trim() || null].filter((value): value is string => typeof value === "string" && value.length > 0).join("\n") || null;
  };
  state.promptRegistry = createLocalPromptRegistry({
    workspace,
    workspaceSummary: state.workspaceSummary,
    sandboxStatus: processService.sandboxStatus,
    memoryContextProvider,
  });
  return state;
}

function sandboxStatusFor(options: CreateAppOptions, state: RuntimeState): SandboxRuntimeStatus {
  if (state.processService !== null) return state.processService.sandboxStatus;
  return {
    mode: options.sandboxMode ?? "auto",
    provider: "none",
    available: false,
    osIsolation: "none",
    networkIsolation: "none",
    reason: "Process runtime is not initialized, so sandbox availability has not been probed.",
  };
}

function healthFor(options: CreateAppOptions, state: RuntimeState): RuntimeHealth {
  const sandbox = sandboxStatusFor(options, state);
  return {
    status: "ready",
    apiVersion: API_VERSION,
    version: options.version,
    startedAt: options.startedAt,
    checkedAt: new Date().toISOString(),
    runtime: {
      host: "127.0.0.1",
      port: options.port,
      node: process.version,
      pid: process.pid,
    },
    capabilities: {
      process: state.processService === null ? "planned" : "ready",
      sandbox: state.processService === null ? "planned" : sandbox.available ? "ready" : "unavailable",
      database: state.catalog === null ? "planned" : "ready",
      workspace: state.workspace === null ? "planned" : "ready",
      authentication: "planned",
      modelGateway: state.model === null ? "planned" : "ready",
    },
  };
}

function requireRuntime(state: RuntimeState): asserts state is RuntimeState & {
  catalog: JsonSessionCatalog;
  events: JsonlSessionStore;
  workspace: Workspace;
  workspaceSummary: WorkspaceSummary;
  resourceScopeId: string;
  tools: ToolRegistry;
  processService: ProcessService;
  processPermissions: ProcessPermissionStore;
  memoryStore: MemoryStore;
  compactionStore: SessionCompactionStore;
  promptRegistry: SystemPromptRegistry;
} {
  if (state.catalog === null || state.events === null || state.workspace === null || state.workspaceSummary === null || state.resourceScopeId === null || state.tools === null || state.processService === null || state.processPermissions === null || state.memoryStore === null || state.compactionStore === null || state.promptRegistry === null) {
    throw Object.assign(new Error("本地工作区运行时尚未初始化。"), { code: "RUNTIME_NOT_INITIALIZED" });
  }
}

function isTerminalTurnEvent(event: import("@daoyin/harness-protocol").AgentEvent, turnId: string): boolean {
  return event.turnId === turnId && (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled");
}

async function reconcileSessionActivity(
  state: RuntimeState & { catalog: JsonSessionCatalog; events: JsonlSessionStore },
  session: LocalSessionSummary,
): Promise<LocalSessionSummary> {
  if (session.activeTurnId === null) return session;
  const events = await state.events.read(session.id);
  if (!events.some((event) => isTerminalTurnEvent(event, session.activeTurnId ?? ""))) return session;
  return state.catalog.update(session.id, { activeTurnId: null, updatedAt: new Date().toISOString() });
}

async function apiFailure(reply: import("fastify").FastifyReply, error: unknown): Promise<void> {
  const candidate = error as { code?: unknown; message?: unknown };
  const code = typeof candidate.code === "string" ? candidate.code : "INTERNAL_ERROR";
  const message = typeof candidate.message === "string" ? candidate.message : "本地运行时发生未知错误。";
  const status = code === "SESSION_NOT_FOUND" || code === "PROCESS_PERMISSION_NOT_FOUND" ? 404
    : code === "PROCESS_PERMISSION_SCOPE_DENIED" ? 403
      : code === "SESSION_BUSY" || code === "PROCESS_PERMISSION_CONSUMED" ? 409
        : code === "INVALID_BODY" ? 400
          : 500;
  await reply.code(status).send(invalidRequest(code, message, status >= 500));
}

export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const state = await createRuntimeState(options);
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: false,
  });

  app.addHook("onRequest", async (request, reply) => {
    const host = request.headers.host;
    if (
      host === undefined ||
      !allowedOrigin(host, `http://${host}`, options.port) ||
      request.headers.forwarded !== undefined ||
      request.headers["x-forwarded-host"] !== undefined
    ) {
      await reply.code(400).send(invalidRequest("INVALID_HOST", "请求 Host 不属于本地运行时。"));
      return;
    }

    const origin = request.headers.origin;
    if (origin !== undefined && !allowedOrigin(host, origin, options.port)) {
      await reply.code(403).send(invalidRequest("INVALID_ORIGIN", "请求 Origin 不属于本地运行时。"));
      return;
    }

    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
      const sessionCookie = cookieValue(request.headers.cookie, "daoyin_harness_session");
      const csrfHeader = request.headers["x-daoyin-csrf"];
      if (sessionCookie !== state.sessionCookie || csrfHeader !== state.csrfToken) {
        await reply.code(403).send(invalidRequest("CSRF_REJECTED", "本地会话校验失败，请刷新页面后重试。"));
        return;
      }
    }
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    void reply
      .header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Content-Type-Options", "nosniff")
      .header("X-Frame-Options", "DENY")
      .header("Cache-Control", "no-store");
    return payload;
  });

  app.get("/api/v1/health", async (): Promise<RuntimeHealth> => healthFor(options, state));

  app.get("/api/v1/bootstrap", async (_request, reply): Promise<RuntimeBootstrap> => {
    const sessions = state.catalog === null ? [] : await state.catalog.list();
    void reply.header("Set-Cookie", sessionCookieHeader(state.sessionCookie));
    return {
      csrfToken: state.csrfToken,
      health: healthFor(options, state),
      sandbox: sandboxStatusFor(options, state),
      workspace: state.workspaceSummary,
      sessions,
      tools: state.tools?.capabilities() ?? [],
    };
  });

  app.get("/api/v1/workspace/files", async (_request, reply): Promise<WorkspaceFilesResponse | void> => {
    try {
      requireRuntime(state);
      const files = await state.workspace.listFiles();
      return { root: state.workspace.root, files };
    } catch (error) {
      await apiFailure(reply, error);
    }
  });

  app.get("/api/v1/process/permissions", async (request, reply): Promise<ProcessPermissionRequest[] | void> => {
    try {
      requireRuntime(state);
      const { sessionId } = request.query as { sessionId?: string };
      return state.processPermissions.list("local", state.resourceScopeId, sessionId);
    } catch (error) {
      await apiFailure(reply, error);
    }
  });

  app.post("/api/v1/process/permissions/:requestId/decision", async (request, reply): Promise<ProcessPermissionRequest | void> => {
    try {
      requireRuntime(state);
      const { requestId } = request.params as { requestId: string };
      const { approve } = parsePermissionDecisionBody(request.body);
      return state.processPermissions.decide(requestId, "local", state.resourceScopeId, approve);
    } catch (error) {
      await apiFailure(reply, error);
    }
  });

  app.get("/api/v1/sessions", async (_request, reply): Promise<CreateSessionResponse[] | void> => {
    try {
      requireRuntime(state);
      return (await state.catalog.list()).map((session) => ({ session }));
    } catch (error) {
      await apiFailure(reply, error);
    }
  });

  app.post("/api/v1/sessions", async (request, reply): Promise<CreateSessionResponse | void> => {
    try {
      requireRuntime(state);
      const body = parseSessionBody(request.body);
      const session = await state.catalog.create(body.title);
      void reply.code(201);
      return { session };
    } catch (error) {
      await apiFailure(reply, error);
    }
  });

  app.get("/api/v1/sessions/:sessionId/events", async (request, reply): Promise<SessionEventsResponse | void> => {
    try {
      requireRuntime(state);
      const { sessionId } = request.params as { sessionId: string };
      const session = await state.catalog.get(sessionId);
      if (session === undefined) throw Object.assign(new Error("会话不存在。"), { code: "SESSION_NOT_FOUND" });
      const { after } = request.query as { after?: string };
      const events = await state.events.read(sessionId, parsePositiveInteger(after, 0));
      return { session, events, lastEventSeq: events.at(-1)?.eventSeq ?? session.lastEventSeq };
    } catch (error) {
      await apiFailure(reply, error);
    }
  });

  app.post("/api/v1/sessions/:sessionId/turns", async (request, reply): Promise<StartTurnResponse | void> => {
    try {
      requireRuntime(state);
      const { sessionId } = request.params as { sessionId: string };
      const found = await state.catalog.get(sessionId);
      if (found === undefined) throw Object.assign(new Error("会话不存在。"), { code: "SESSION_NOT_FOUND" });
      const current = await reconcileSessionActivity(state, found);
      if (current.activeTurnId !== null) throw Object.assign(new Error("这个会话已有任务正在执行。"), { code: "SESSION_BUSY" });

      const body = parseTurnBody(request.body);
      const turnId = `turn_${crypto.randomUUID().replaceAll("-", "")}`;
      const controller = new AbortController();
      state.activeTurns.set(turnId, controller);
      await state.catalog.update(sessionId, {
        activeTurnId: turnId,
        updatedAt: new Date().toISOString(),
        title: current.title === "新对话" ? body.message.slice(0, 40) : current.title,
      });

      const model: ModelClient = state.model ?? {
        async complete() {
          throw new Error("真实模型网关尚未登录。会话与工作区已经接通，但当前不会伪造模型执行结果。");
        },
      };
      const engine = new AgentEngine({
        model,
        tools: state.tools,
        events: state.events,
        promptRegistry: state.promptRegistry,
        compactionStore: state.compactionStore,
        ...(options.compactionRetainRecentTurns === undefined ? {} : { compactionRetainRecentTurns: options.compactionRetainRecentTurns }),
        ...(options.compactionTriggerUncompactedTurns === undefined ? {} : { compactionTriggerUncompactedTurns: options.compactionTriggerUncompactedTurns }),
        ...(options.compactionTriggerCharacters === undefined ? {} : { compactionTriggerCharacters: options.compactionTriggerCharacters }),
        ...(options.compactionMaxSummaryCharacters === undefined ? {} : { compactionMaxSummaryCharacters: options.compactionMaxSummaryCharacters }),
        onEvent: async (event) => {
          const terminal = event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled";
          await state.catalog.update(sessionId, {
            lastEventSeq: event.eventSeq,
            updatedAt: event.occurredAt,
            ...(terminal ? { activeTurnId: null } : {}),
          });
        },
      });

      void engine.runTurn({
        accountId: "local",
        scopeId: state.resourceScopeId,
        sessionId,
        turnId,
        userMessage: body.message,
        ...(body.planning ? { systemInstruction: "Before acting, reason through the task structure and dependencies carefully. Keep the visible answer concise unless the user asks for detail." } : {}),
        signal: controller.signal,
      }).finally(async () => {
        state.activeTurns.delete(turnId);
        const latest = await state.catalog.get(sessionId);
        if (latest?.activeTurnId === turnId) {
          await state.catalog.update(sessionId, { activeTurnId: null, updatedAt: new Date().toISOString() });
        }
      }).catch(() => undefined);

      void reply.code(202);
      return { sessionId, turnId, status: "accepted" };
    } catch (error) {
      await apiFailure(reply, error);
    }
  });

  app.post("/api/v1/sessions/:sessionId/turns/:turnId/cancel", async (request, reply): Promise<{ status: "cancelling" | "idle" } | void> => {
    try {
      requireRuntime(state);
      const { sessionId, turnId } = request.params as { sessionId: string; turnId: string };
      const session = await state.catalog.get(sessionId);
      if (session === undefined) throw Object.assign(new Error("会话不存在。"), { code: "SESSION_NOT_FOUND" });
      const controller = state.activeTurns.get(turnId);
      if (controller === undefined || session.activeTurnId !== turnId) return { status: "idle" };
      controller.abort();
      return { status: "cancelling" };
    } catch (error) {
      await apiFailure(reply, error);
    }
  });

  if (options.publicDir !== undefined && (await directoryExists(options.publicDir))) {
    await app.register(fastifyStatic, {
      root: options.publicDir,
      wildcard: false,
    });

    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/api/")) {
        await reply.code(404).send(invalidRequest("NOT_FOUND", "未找到对应的本地 API。"));
        return;
      }
      await reply.type("text/html; charset=utf-8").sendFile("index.html");
    });
  } else {
    app.setNotFoundHandler(async (_request, reply) => {
      await reply.code(404).send(invalidRequest("NOT_FOUND", "未找到对应的本地 API。"));
    });
  }

  return app;
}
