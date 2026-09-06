import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { AgentEngine, type ModelClient, type SystemPromptRegistry } from "@daoyin/harness-agent-core";
import { BrowserService } from "@daoyin/harness-browser";
import { McpManager, type McpClientFactory, type McpRemoteServerConfig } from "@daoyin/harness-mcp";
import { ChildAgentRunner, JsonlOrchestrationStore, WorkflowService, createOrchestrationTools } from "@daoyin/harness-orchestration";
import { JsonlProcessPermissionStore, ProcessService, type ProcessPermissionStore } from "@daoyin/harness-process";
import {
  API_VERSION,
  type AgentEvent,
  type ApiError,
  type AuthenticationSummary,
  type BeginAuthenticationResponse,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type LocalSessionSummary,
  type OrchestrationSnapshot,
  type ProcessPermissionRequest,
  type RuntimeBootstrap,
  type RuntimeHealth,
  type ResumeSessionResponse,
  type SandboxMode,
  type SandboxRuntimeStatus,
  type SessionEventStreamMessage,
  type SessionEventsResponse,
  type SessionSearchHit,
  type SessionSearchResponse,
  type StartTurnRequest,
  type StartTurnResponse,
  type WorkspaceFilesResponse,
  type WorkspaceSummary,
  type PickWorkspaceResponse,
  type SwitchWorkspaceResponse,
} from "@daoyin/harness-protocol";
import { createBrowserTools, createMcpTools, createMemoryTools, createProcessTools, createSkillTools, createWebTools, createWorkspaceTools, ToolRegistry } from "@daoyin/harness-tools";
import {
  JsonlCompactionStore,
  JsonlMemoryStore,
  JsonlSessionStore,
  JsonSessionCatalog,
  Workspace,
  type MemoryStore,
  type SessionCompactionStore,
} from "@daoyin/harness-workspace";
import { createLocalPromptRegistry, type MemoryContextProvider, type OrchestrationContextProvider } from "./prompt-context.js";
import { WorkspaceHistory, validateWorkspaceRoot } from "./workspace-history.js";
import { pickWorkspaceDirectory } from "./folder-picker.js";
import { runtimeAccountScope } from "./account-scope.js";

export interface CreateAppOptions {
  port: number;
  version: string;
  startedAt: string;
  publicDir?: string;
  dataDir?: string;
  workspaceRoot?: string;
  restoreLastWorkspace?: boolean;
  pickWorkspaceDirectory?: () => Promise<string | null>;
  model?: ModelClient;
  authentication?: HarnessAuthentication;
  memoryContextProvider?: MemoryContextProvider;
  browserExecutablePath?: string;
  mcpServers?: McpRemoteServerConfig[];
  mcpClientFactory?: McpClientFactory;
  sandboxMode?: SandboxMode;
  compactionRetainRecentTurns?: number;
  compactionTriggerUncompactedTurns?: number;
  compactionTriggerCharacters?: number;
  compactionMaxSummaryCharacters?: number;
  logger?: FastifyServerOptions["logger"];
}

export interface HarnessAuthentication {
  readonly authority?: string;
  status(): AuthenticationSummary;
  beginAuthorization(): BeginAuthenticationResponse;
  completeAuthorization(code: string, state: string): Promise<{ id: number; userName: string; tenantId: number }>;
  logout(): Promise<void>;
}

type LiveSessionEventMessage = Extract<SessionEventStreamMessage, { type: "event" }>;
type SessionEventSubscriber = (message: LiveSessionEventMessage) => void;

interface RuntimeState {
  accountId: string;
  csrfToken: string;
  sessionCookie: string;
  catalog: JsonSessionCatalog | null;
  events: JsonlSessionStore | null;
  workspace: Workspace | null;
  workspaceSummary: WorkspaceSummary | null;
  resourceScopeId: string | null;
  tools: ToolRegistry | null;
  browserService: BrowserService | null;
  mcpManager: McpManager | null;
  processService: ProcessService | null;
  processPermissions: ProcessPermissionStore | null;
  memoryStore: MemoryStore | null;
  orchestrationStore: JsonlOrchestrationStore | null;
  compactionStore: SessionCompactionStore | null;
  promptRegistry: SystemPromptRegistry | null;
  model: ModelClient | null;
  authentication: HarnessAuthentication | null;
  activeTurns: Map<string, AbortController>;
  eventSubscribers: Map<string, Set<SessionEventSubscriber>>;
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

function parseForkBody(body: unknown): ForkSessionRequest {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw Object.assign(new Error("分叉请求格式无效。"), { code: "INVALID_BODY" });
  }
  const candidate = body as { eventSeq?: unknown; title?: unknown };
  if (candidate.eventSeq !== undefined && (!Number.isSafeInteger(candidate.eventSeq) || Number(candidate.eventSeq) < 0)) {
    throw Object.assign(new Error("eventSeq 必须是非负整数。"), { code: "INVALID_BODY" });
  }
  if (candidate.title !== undefined && typeof candidate.title !== "string") {
    throw Object.assign(new Error("title 必须是字符串。"), { code: "INVALID_BODY" });
  }
  return {
    ...(candidate.eventSeq === undefined ? {} : { eventSeq: Number(candidate.eventSeq) }),
    ...(candidate.title === undefined ? {} : { title: candidate.title }),
  };
}

function normalizedSearchQuery(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase().slice(0, 500);
}

function searchScore(text: string, query: string): number {
  const normalized = text.normalize("NFKC").toLowerCase();
  if (query.length === 0 || normalized.length === 0) return 0;
  let score = normalized.includes(query) ? 100 : 0;
  const tokens = [...new Set(query.split(/\s+/gu).filter((token) => token.length > 0))];
  for (const token of tokens) {
    if (normalized.includes(token)) score += Math.min(30, 8 + token.length * 2);
  }
  return score;
}

function searchSnippet(text: string, query: string): string {
  const compact = text.replace(/\s+/gu, " ").trim();
  if (compact.length <= 280) return compact;
  const normalized = compact.normalize("NFKC").toLowerCase();
  const index = normalized.indexOf(query);
  const start = Math.max(0, (index < 0 ? 0 : index) - 100);
  const end = Math.min(compact.length, start + 280);
  return `${start > 0 ? "…" : ""}${compact.slice(start, end)}${end < compact.length ? "…" : ""}`;
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

async function createRuntimeState(options: CreateAppOptions, catalogDirectory?: string, accountId = "local"): Promise<RuntimeState> {
  const state: RuntimeState = {
    accountId,
    csrfToken: randomBytes(32).toString("base64url"),
    sessionCookie: randomBytes(32).toString("base64url"),
    catalog: null,
    events: null,
    workspace: null,
    workspaceSummary: null,
    resourceScopeId: null,
    tools: null,
    browserService: null,
    mcpManager: null,
    processService: null,
    processPermissions: null,
    memoryStore: null,
    orchestrationStore: null,
    compactionStore: null,
    promptRegistry: null,
    model: options.model ?? null,
    authentication: options.authentication ?? null,
    activeTurns: new Map(),
    eventSubscribers: new Map(),
  };

  if (options.model !== undefined && state.authentication !== null) {
    const model = options.model;
    const assertIdentity = (): void => {
      if (runtimeAccountScope(options.dataDir, state.authentication).accountId !== state.accountId) {
        throw Object.assign(new Error("账号状态已改变，请刷新后重新发起任务。"), { code: "AUTH_CONTEXT_CHANGED" });
      }
    };
    state.model = {
      async complete(request) {
        assertIdentity();
        const result = await model.complete(request);
        assertIdentity();
        return result;
      },
    };
  }
  if (options.dataDir === undefined || options.workspaceRoot === undefined) return state;

  try {
    const workspace = await Workspace.open(options.workspaceRoot);
    const files = await workspace.listFiles();
    state.workspace = workspace;
    state.workspaceSummary = {
      name: path.basename(workspace.root) || workspace.root,
      root: workspace.root,
      fileCount: files.length,
    };
    state.resourceScopeId = `resource_${createHash("sha256").update(workspace.root).digest("hex").slice(0, 24)}`;
    state.catalog = new JsonSessionCatalog(catalogDirectory ?? path.join(options.dataDir, "state"));
    const events = new JsonlSessionStore(path.join(options.dataDir, "transcripts"));
    state.events = events;
    const memoryStore = new JsonlMemoryStore(path.join(options.dataDir, "memory", "memories.jsonl"));
    const orchestrationStore = new JsonlOrchestrationStore(path.join(options.dataDir, "orchestration", "state.jsonl"));
    const compactionStore = new JsonlCompactionStore(path.join(options.dataDir, "compactions"));
    const processService = await ProcessService.create(workspace.root, { sandboxMode: options.sandboxMode ?? "auto" });
    const processPermissions = new JsonlProcessPermissionStore(path.join(options.dataDir, "process", "permissions.jsonl"));
    const browserService = await BrowserService.create(options.browserExecutablePath === undefined ? {} : { executablePath: options.browserExecutablePath });
    state.browserService = browserService;
    const mcpManager = await McpManager.connect(options.mcpServers ?? [], {
      clientVersion: options.version,
      ...(options.mcpClientFactory === undefined ? {} : { clientFactory: options.mcpClientFactory }),
    });
    state.memoryStore = memoryStore;
    state.orchestrationStore = orchestrationStore;
    state.compactionStore = compactionStore;
    state.browserService = browserService;
    state.mcpManager = mcpManager;
    state.processService = processService;
    state.processPermissions = processPermissions;

    const tools = new ToolRegistry();
    tools.registerPack({ id: "workspace", tools: createWorkspaceTools(workspace) });
    tools.registerPack({ id: "process", tools: createProcessTools(processService, processPermissions, workspace) });
    tools.registerPack({ id: "web", tools: createWebTools() });
    if (browserService.status.available) tools.registerPack({ id: "browser", tools: createBrowserTools(browserService) });
    const mcpTools = createMcpTools(mcpManager);
    if (mcpTools.length > 0) tools.registerPack({ id: "mcp", tools: mcpTools });
    tools.registerPack({ id: "skills", tools: createSkillTools(workspace) });
    tools.registerPack({ id: "memory", tools: createMemoryTools(memoryStore) });

    const childExcludedTools = new Set(["run_package_script", "memory_remember", "memory_update", "memory_forget"]);
    const childTools = new ToolRegistry(tools.definitions().filter((definition) => !childExcludedTools.has(definition.name)));

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
    const orchestrationContextProvider: OrchestrationContextProvider = async (input) => {
      const snapshot = await orchestrationStore.snapshot(input.accountId, input.scopeId, input.sessionId);
      const goals = snapshot.goals
        .filter((goal) => goal.status === "active" || goal.status === "blocked")
        .slice(0, 8)
        .map((goal) => ({ id: goal.id, title: goal.title, status: goal.status, revision: goal.revision, steps: goal.steps, note: goal.note }));
      const workflows = snapshot.workflows.slice(0, 12).map((workflow) => ({ id: workflow.id, name: workflow.name, description: workflow.description, stepCount: workflow.steps.length }));
      const workflowRuns = snapshot.workflowRuns.slice(-8).map((run) => ({ id: run.id, workflowId: run.workflowId, status: run.status, steps: run.steps }));
      const childRuns = snapshot.childRuns.slice(-8).map((run) => ({ id: run.id, status: run.status, instruction: run.instruction.slice(0, 500), finalText: run.finalText.slice(0, 800) }));
      if (goals.length === 0 && workflows.length === 0 && workflowRuns.length === 0 && childRuns.length === 0) return null;
      return JSON.stringify({ goals, workflows, workflowRuns, childRuns });
    };
    const promptRegistry = createLocalPromptRegistry({
      workspace,
      workspaceSummary: state.workspaceSummary,
      sandboxStatus: processService.sandboxStatus,
      memoryContextProvider,
      orchestrationContextProvider,
    });
    const childRunner = new ChildAgentRunner({
      model: state.model,
      tools: childTools,
      events,
      promptRegistry,
      store: orchestrationStore,
      compactionStore,
    });
    const workflowService = new WorkflowService(orchestrationStore, childRunner);
    tools.registerPack({ id: "orchestration", tools: createOrchestrationTools({ store: orchestrationStore, children: childRunner, workflows: workflowService }) });
    state.tools = tools;
    state.promptRegistry = promptRegistry;
    return state;
  } catch (error) {
    await Promise.allSettled([state.browserService?.close(), state.mcpManager?.close()]);
    throw error;
  }
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
      authentication: state.authentication === null ? "planned" : "ready",
      modelGateway: state.model === null
        ? "planned"
        : state.authentication === null || state.authentication.status().status === "signed_in" ? "ready" : "unavailable",
      browser: state.browserService === null ? "planned" : state.browserService.status.available ? "ready" : "unavailable",
      mcp: state.mcpManager === null ? "planned" : state.mcpManager.configuredCount === 0 || state.mcpManager.connectedCount > 0 ? "ready" : "unavailable",
      orchestration: state.orchestrationStore === null ? "planned" : "ready",
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
  orchestrationStore: JsonlOrchestrationStore;
  compactionStore: SessionCompactionStore;
  promptRegistry: SystemPromptRegistry;
} {
  if (state.catalog === null || state.events === null || state.workspace === null || state.workspaceSummary === null || state.resourceScopeId === null || state.tools === null || state.processService === null || state.processPermissions === null || state.memoryStore === null || state.orchestrationStore === null || state.compactionStore === null || state.promptRegistry === null) {
    throw Object.assign(new Error("本地工作区运行时尚未初始化。"), { code: "RUNTIME_NOT_INITIALIZED" });
  }
}

function subscribeSessionEvents(state: RuntimeState, sessionId: string, subscriber: SessionEventSubscriber): () => void {
  const subscribers = state.eventSubscribers.get(sessionId) ?? new Set<SessionEventSubscriber>();
  subscribers.add(subscriber);
  state.eventSubscribers.set(sessionId, subscribers);
  return () => {
    const current = state.eventSubscribers.get(sessionId);
    current?.delete(subscriber);
    if (current?.size === 0) state.eventSubscribers.delete(sessionId);
  };
}

function publishSessionEvent(state: RuntimeState, event: AgentEvent, session: LocalSessionSummary): void {
  const message: LiveSessionEventMessage = { type: "event", event, session };
  for (const subscriber of state.eventSubscribers.get(event.sessionId) ?? []) {
    try {
      subscriber(message);
    } catch {
      // WebSocket subscribers are transient; persisted event replay remains authoritative.
    }
  }
}

function isTerminalTurnEvent(event: AgentEvent, turnId: string): boolean {
  return event.turnId === turnId && (
    event.type === "turn.completed" ||
    event.type === "turn.failed" ||
    event.type === "turn.cancelled" ||
    event.type === "turn.interrupted"
  );
}

function isSafeForkBoundary(event: AgentEvent): boolean {
  return event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled" || event.type === "turn.interrupted";
}

interface SessionReconcileResult {
  session: LocalSessionSummary;
  interruptedTurnId: string | null;
  interruptionEventSeq: number | null;
}

async function reconcileSessionActivity(
  state: RuntimeState & { catalog: JsonSessionCatalog; events: JsonlSessionStore; resourceScopeId: string },
  session: LocalSessionSummary,
): Promise<SessionReconcileResult> {
  if (session.activeTurnId === null) return { session, interruptedTurnId: null, interruptionEventSeq: null };
  const activeTurnId = session.activeTurnId;
  const events = await state.events.read(session.id);
  if (events.some((event) => isTerminalTurnEvent(event, activeTurnId))) {
    const updated = await state.catalog.update(session.id, { activeTurnId: null, updatedAt: new Date().toISOString() });
    return { session: updated, interruptedTurnId: null, interruptionEventSeq: null };
  }
  if (state.activeTurns.has(activeTurnId)) return { session, interruptedTurnId: null, interruptionEventSeq: null };

  const previousEventSeq = events.at(-1)?.eventSeq ?? 0;
  const interruption = await state.events.append({
    type: "turn.interrupted",
    accountId: state.accountId,
    scopeId: state.resourceScopeId,
    sessionId: session.id,
    turnId: activeTurnId,
    payload: {
      status: "interrupted",
      reason: "runtime_restart",
      lastCompletedEventSeq: previousEventSeq,
    },
  });
  const updated = await state.catalog.update(session.id, {
    activeTurnId: null,
    lastEventSeq: interruption.eventSeq,
    updatedAt: interruption.occurredAt,
  });
  publishSessionEvent(state, interruption, updated);
  return { session: updated, interruptedTurnId: activeTurnId, interruptionEventSeq: interruption.eventSeq };
}

function forkBoundary(events: readonly AgentEvent[], requested: number | undefined): number {
  const safe = events.filter(isSafeForkBoundary).map((event) => event.eventSeq);
  if (requested === undefined) return safe.at(-1) ?? 0;
  if (!Number.isSafeInteger(requested) || requested < 0) {
    throw Object.assign(new Error("分叉边界必须是非负整数。"), { code: "SESSION_FORK_BOUNDARY_INVALID" });
  }
  if (requested === 0) return 0;
  if (!safe.includes(requested)) {
    throw Object.assign(new Error("分叉只能落在已持久化的终止回合边界。"), {
      code: "SESSION_FORK_BOUNDARY_INVALID",
      details: { requestedEventSeq: requested, latestSafeEventSeq: safe.at(-1) ?? 0 },
    });
  }
  return requested;
}

async function inheritedEventsForSession(
  state: RuntimeState & { catalog: JsonSessionCatalog; events: JsonlSessionStore },
  session: LocalSessionSummary,
): Promise<AgentEvent[]> {
  const segments: AgentEvent[][] = [];
  const seen = new Set<string>([session.id]);
  let cursor = session;
  while (cursor.forkedFrom !== undefined) {
    const reference = cursor.forkedFrom;
    if (seen.has(reference.sourceSessionId)) {
      throw Object.assign(new Error("Session fork ancestry contains a cycle."), { code: "SESSION_FORK_CYCLE" });
    }
    seen.add(reference.sourceSessionId);
    const source = await state.catalog.get(reference.sourceSessionId);
    if (source === undefined) throw Object.assign(new Error("Fork source session no longer exists."), { code: "SESSION_FORK_SOURCE_MISSING" });
    const sourceEvents = await state.events.read(source.id);
    segments.unshift(sourceEvents.filter((event) => event.eventSeq <= reference.sourceEventSeq));
    cursor = source;
  }
  return segments.flat();
}

async function searchSessions(
  state: RuntimeState & { catalog: JsonSessionCatalog; events: JsonlSessionStore },
  rawQuery: unknown,
  rawLimit: unknown,
): Promise<SessionSearchResponse> {
  const query = normalizedSearchQuery(rawQuery);
  if (query.length === 0) return { query: "", hits: [] };
  const parsedLimit = typeof rawLimit === "string" ? Number(rawLimit) : 20;
  const limit = Number.isSafeInteger(parsedLimit) ? Math.max(1, Math.min(50, parsedLimit)) : 20;
  const sessions = await state.catalog.list();
  const hits: SessionSearchHit[] = [];
  for (const session of sessions.slice(0, 500)) {
    let bestScore = searchScore(session.title, query) * 2;
    let bestText = bestScore > 0 ? session.title : "";
    let bestEventSeq: number | null = null;
    let bestTurnId: string | null = null;
    const events = await state.events.read(session.id);
    for (const event of events) {
      let text = "";
      if (event.type === "turn.started") text = event.payload.userMessage;
      else if (event.type === "assistant.delta") text = event.payload.delta;
      else if (event.type === "tool.completed") text = `${event.payload.toolName} ${event.payload.summary}`;
      else if (event.type === "tool.failed") text = `${event.payload.toolName} ${event.payload.code} ${event.payload.message}`;
      if (text.length === 0) continue;
      const score = searchScore(text, query);
      if (score <= bestScore) continue;
      bestScore = score;
      bestText = text;
      bestEventSeq = event.eventSeq;
      bestTurnId = event.turnId;
    }
    if (bestScore > 0) {
      hits.push({
        session,
        score: bestScore,
        matchedText: searchSnippet(bestText, query),
        eventSeq: bestEventSeq,
        turnId: bestTurnId,
      });
    }
  }
  hits.sort((left, right) => right.score - left.score || right.session.updatedAt.localeCompare(left.session.updatedAt));
  return { query, hits: hits.slice(0, limit) };
}

async function apiFailure(reply: import("fastify").FastifyReply, error: unknown): Promise<void> {
  const candidate = error as { code?: unknown; message?: unknown };
  const code = typeof candidate.code === "string" ? candidate.code : "INTERNAL_ERROR";
  const message = typeof candidate.message === "string" ? candidate.message : "本地运行时发生未知错误。";
  const status = code === "SESSION_NOT_FOUND" || code === "SESSION_FORK_SOURCE_MISSING" || code === "PROCESS_PERMISSION_NOT_FOUND" ? 404
    : code === "AUTH_REQUIRED" || code === "MODEL_AUTH_REQUIRED" ? 401
      : code === "PROCESS_PERMISSION_SCOPE_DENIED" || code === "AUTH_IDENTITY_INVALID" ? 403
        : code === "SESSION_BUSY" || code === "SESSION_STILL_RUNNING" || code === "SESSION_FORK_CYCLE" || code === "PROCESS_PERMISSION_CONSUMED" || code === "AUTH_RUNTIME_BUSY" || code === "AUTH_CONTEXT_CHANGED" ? 409
          : code === "INVALID_BODY" || code === "SESSION_FORK_BOUNDARY_INVALID" || code === "WORKSPACE_ROOT_INVALID" ? 400
            : code === "MODEL_AUTH_RATE_LIMITED" ? 429
              : code === "MODEL_AUTH_TIMEOUT" ? 504
                : code === "MODEL_AUTH_NETWORK" || code === "MODEL_AUTH_UNAVAILABLE" ? 503 : 500;
  await reply.code(status).send(invalidRequest(code, message, status >= 500));
}

async function prepareAccountRuntime(options: CreateAppOptions): Promise<{
  state: RuntimeState; history: WorkspaceHistory | null; scopedOptions: CreateAppOptions;
}> {
  const scope = runtimeAccountScope(options.dataDir, options.authentication);
  const scopedOptions: CreateAppOptions = { ...options, ...(scope.dataDir === undefined ? {} : { dataDir: scope.dataDir }) };
  const initialRoot = options.workspaceRoot === undefined ? undefined : await validateWorkspaceRoot(options.workspaceRoot);
  const history = scope.dataDir === undefined || initialRoot === undefined ? null : await WorkspaceHistory.open(scope.dataDir, initialRoot);
  let startupRoot = initialRoot;
  if (options.restoreLastWorkspace && history?.recent[0] !== undefined) {
    try { startupRoot = await validateWorkspaceRoot(history.recent[0].root); } catch { /* Keep the explicit startup fallback. */ }
  }
  const state = await createRuntimeState({ ...scopedOptions, ...(startupRoot === undefined ? {} : { workspaceRoot: startupRoot }) }, startupRoot === undefined ? undefined : history?.catalogDirectory(startupRoot), scope.accountId);
  try {
    if (scope.accountId !== runtimeAccountScope(options.dataDir, options.authentication).accountId) {
      throw Object.assign(new Error("账号在初始化期间发生变化，请重新加载。"), { code: "AUTH_CONTEXT_CHANGED" });
    }
    if (startupRoot !== undefined) await history?.remember(startupRoot);
    return { state, history, scopedOptions };
  } catch (error) {
    await Promise.allSettled([state.browserService?.close(), state.mcpManager?.close()]);
    throw error;
  }
}

export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  let { state, history, scopedOptions } = await prepareAccountRuntime(options);
  let workspaceRevision = randomBytes(16).toString("hex");
  let switching = false;
  const inFlight = new Set<string>();
  const executingRequests = new Set<string>();
  const sockets = new Set<{ close(code: number, reason: string): void }>();

  function requireIdleAuthentication(): void {
    if (state.activeTurns.size > 0 || inFlight.size > 1) {
      throw Object.assign(new Error("当前仍有任务或操作在进行，请完成或停止后再切换账号。"), { code: "AUTH_RUNTIME_BUSY" });
    }
  }
  async function rebindAccountRuntime(): Promise<void> {
    // Called only while the exclusive switching gate is held. A failed rebuild
    // leaves the old files intact; the identity guard below fails closed.
    const prepared = await prepareAccountRuntime(options);
    const previous = state;
    state = prepared.state;
    history = prepared.history;
    scopedOptions = prepared.scopedOptions;
    workspaceRevision = randomBytes(16).toString("hex");
    for (const socket of sockets) socket.close(1008, "account changed; refresh required");
    await Promise.allSettled([previous.browserService?.close(), previous.mcpManager?.close()]);
  }
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: false,
  });
  await app.register(fastifyWebsocket);
  app.addHook("onRoute", (route) => {
    if (!route.url.startsWith("/api/v1/")) return;
    const handler = route.handler;
    route.handler = async function (request, reply) {
      executingRequests.add(request.id);
      try { return await handler.call(this, request, reply); }
      finally {
        executingRequests.delete(request.id);
        inFlight.delete(request.id);
      }
    };
  });
  app.addHook("onClose", async () => {
    await Promise.all([
      state.browserService?.close(),
      state.mcpManager?.close(),
    ]);
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/api/v1/")) {
      if (switching) {
        await reply.code(409).send(invalidRequest("WORKSPACE_SWITCHING", "正在切换工作区，请稍后重试。", true));
        return;
      }
      if (!request.url.startsWith("/api/v1/bootstrap") && request.headers["x-daoyin-workspace"] !== undefined && request.headers["x-daoyin-workspace"] !== workspaceRevision) {
        await reply.code(409).send(invalidRequest("WORKSPACE_CHANGED", "工作区已在其他页面切换，请刷新后继续。"));
        return;
      }
      inFlight.add(request.id);
    }
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

    const routePath = request.url.split("?", 1)[0] ?? request.url;
    if (routePath.startsWith("/api/v1/") && !routePath.startsWith("/api/v1/auth/") && routePath !== "/api/v1/health") {
      try {
        if (runtimeAccountScope(options.dataDir, options.authentication).accountId !== state.accountId) {
          for (const controller of state.activeTurns.values()) controller.abort();
          for (const socket of sockets) socket.close(1008, "account changed; refresh required");
          if (routePath !== "/api/v1/bootstrap") {
            await reply.code(409).send(invalidRequest("AUTH_CONTEXT_CHANGED", "账号状态已改变，请刷新后继续。"));
            return;
          }
          requireIdleAuthentication();
          switching = true;
          try { await rebindAccountRuntime(); }
          finally { switching = false; }
        }
      } catch (error) { await apiFailure(reply, error); return; }
    }
  });

  app.addHook("onResponse", async (request) => { inFlight.delete(request.id); });
  app.addHook("onRequestAbort", async (request) => {
    // A disconnected client must not leave a permanent lock. Work already in a
    // handler keeps the lock until its own completion (e.g. an open folder dialog).
    if (!executingRequests.has(request.id)) inFlight.delete(request.id);
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    void reply
      .header("Content-Security-Policy", `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:${String(options.port)}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`)
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
      workspaceRevision,
      health: healthFor(options, state),
      authentication: state.authentication?.status() ?? { status: "signed_out", account: null },
      sandbox: sandboxStatusFor(options, state),
      workspace: state.workspaceSummary,
      sessions,
      tools: state.tools?.capabilities() ?? [],
      mcpServers: state.mcpManager?.statuses() ?? [],
    };
  });

  async function transitionAuthentication(action: () => Promise<unknown>): Promise<void> {
    requireIdleAuthentication();
    switching = true;
    try {
      await action();
      await rebindAccountRuntime();
    } finally { switching = false; }
  }

  app.post("/api/v1/auth/login", async (_request, reply): Promise<BeginAuthenticationResponse | void> => {
    try {
      requireIdleAuthentication();
      if (state.authentication === null) throw Object.assign(new Error("道引科技账号登录尚未配置。"), { code: "AUTH_NOT_CONFIGURED" });
      return state.authentication.beginAuthorization();
    } catch (error) { await apiFailure(reply, error); }
  });

  app.get("/api/v1/auth/callback", async (request, reply): Promise<void> => {
    const { code, state: callbackState, error } = request.query as { code?: unknown; state?: unknown; error?: unknown };
    let title = "登录成功";
    let message = "账号已连接，正在返回工作台。";
    let ok = true;
    try {
      if (error !== undefined) throw new Error("账号授权未完成，请重新登录。");
      if (typeof code !== "string" || code.length === 0 || code.length > 4096 || typeof callbackState !== "string" || callbackState.length === 0 || callbackState.length > 256) {
        throw new Error("登录回调参数无效，请重新登录。");
      }
      const authentication = state.authentication;
      if (authentication === null) throw new Error("道引账号登录尚未配置。");
      await transitionAuthentication(() => authentication.completeAuthorization(code, callbackState));
      void reply.header("Set-Cookie", sessionCookieHeader(state.sessionCookie));
    } catch (callbackError) {
      ok = false;
      title = "登录失败";
      message = callbackError instanceof Error ? callbackError.message : "登录回调处理失败，请重新登录。";
    }
    const safeTitle = title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const safeMessage = message.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    // External CSS respects the runtime's style-src 'self' policy; no inline exception.
    void reply.type("text/html; charset=utf-8").send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${ok ? '<meta http-equiv="refresh" content="2;url=/">' : ""}<title>${safeTitle}</title><link rel="icon" href="/assets/daoyin-logo.png"><link rel="stylesheet" href="/assets/auth-callback.css"></head><body><main class="auth-result ${ok ? "" : "failed"}"><img src="/assets/daoyin-logo.png" width="40" height="40" alt="道引科技"><h1>${safeTitle}</h1><p role="status">${safeMessage}</p><a href="/">返回工作台</a></main></body></html>`);
  });

  app.post("/api/v1/auth/logout", async (_request, reply): Promise<{ success: true } | void> => {
    try {
      const authentication = state.authentication;
      if (authentication !== null) await transitionAuthentication(() => authentication.logout());
      void reply.header("Set-Cookie", sessionCookieHeader(state.sessionCookie));
      return { success: true };
    } catch (error) { await apiFailure(reply, error); }
  });

  app.get("/api/v1/workspaces", async () => ({
    recent: history?.recent ?? [],
    nativePickerAvailable: options.pickWorkspaceDirectory !== undefined || process.platform === "win32",
  }));

  let pickerBusy = false;
  app.post("/api/v1/workspaces/pick", async (_request, reply): Promise<PickWorkspaceResponse | void> => {
    if (pickerBusy) { await reply.code(409).send(invalidRequest("WORKSPACE_PICKER_BUSY", "文件夹选择窗口已打开。")); return; }
    pickerBusy = true;
    try {
      const root = await (options.pickWorkspaceDirectory ?? pickWorkspaceDirectory)();
      return { root: root === null ? null : await validateWorkspaceRoot(root) };
    } catch (error) {
      await apiFailure(reply, error);
    } finally { pickerBusy = false; }
  });

  app.post("/api/v1/workspaces/switch", async (request, reply): Promise<SwitchWorkspaceResponse | void> => {
    if (state.activeTurns.size > 0 || inFlight.size > 1) {
      await reply.code(409).send(invalidRequest("WORKSPACE_BUSY", "当前工作区仍有任务或操作在进行，请完成或停止后再切换。", true)); return;
    }
    switching = true;
    let next: RuntimeState | null = null;
    try {
      requireRuntime(state);
      if (history === null) throw Object.assign(new Error("工作区管理尚未初始化。"), { code: "RUNTIME_NOT_INITIALIZED" });
      const body = request.body as { root?: unknown } | null;
      const root = await validateWorkspaceRoot(body?.root);
      if (root === state.workspace.root) return { workspace: state.workspaceSummary };
      next = await createRuntimeState({ ...scopedOptions, workspaceRoot: root }, history.catalogDirectory(root), state.accountId);
      await history.remember(root);
      const previous = state;
      next.sessionCookie = previous.sessionCookie;
      state = next;
      next = null;
      workspaceRevision = randomBytes(16).toString("hex");
      for (const socket of sockets) socket.close(1008, "workspace changed; refresh required");
      await Promise.allSettled([previous.browserService?.close(), previous.mcpManager?.close()]);
      requireRuntime(state);
      return { workspace: state.workspaceSummary };
    } catch (error) {
      if (next !== null) await Promise.allSettled([next.browserService?.close(), next.mcpManager?.close()]);
      await apiFailure(reply, error);
    } finally { switching = false; }
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

  app.get("/api/v1/orchestration", async (request, reply): Promise<OrchestrationSnapshot | void> => {
    try {
      requireRuntime(state);
      const { sessionId } = request.query as { sessionId?: string };
      if (sessionId !== undefined && await state.catalog.get(sessionId) === undefined) {
        throw Object.assign(new Error("会话不存在。"), { code: "SESSION_NOT_FOUND" });
      }
      return state.orchestrationStore.snapshot(state.accountId, state.resourceScopeId, sessionId);
    } catch (error) {
      await apiFailure(reply, error);
    }
  });

  app.get("/api/v1/process/permissions", async (request, reply): Promise<ProcessPermissionRequest[] | void> => {
    try {
      requireRuntime(state);
      const { sessionId } = request.query as { sessionId?: string };
      return state.processPermissions.list(state.accountId, state.resourceScopeId, sessionId);
    } catch (error) {
      await apiFailure(reply, error);
    }
  });

  app.post("/api/v1/process/permissions/:requestId/decision", async (request, reply): Promise<ProcessPermissionRequest | void> => {
    try {
      requireRuntime(state);
      const { requestId } = request.params as { requestId: string };
      const { approve } = parsePermissionDecisionBody(request.body);
      return await state.processPermissions.decide(requestId, state.accountId, state.resourceScopeId, approve);
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

  app.get("/api/v1/sessions/search", async (request, reply): Promise<SessionSearchResponse | void> => {
    try {
      requireRuntime(state);
      const { q, limit } = request.query as { q?: string; limit?: string };
      return searchSessions(state, q, limit);
    } catch (error) {
      await apiFailure(reply, error);
    }
  });

  app.post("/api/v1/sessions/:sessionId/forks", async (request, reply): Promise<ForkSessionResponse | void> => {
    try {
      requireRuntime(state);
      const { sessionId } = request.params as { sessionId: string };
      const sourceSession = await state.catalog.get(sessionId);
      if (sourceSession === undefined) throw Object.assign(new Error("会话不存在。"), { code: "SESSION_NOT_FOUND" });
      const body = parseForkBody(request.body);
      const sourceEvents = await state.events.read(sessionId);
      const sourceEventSeq = forkBoundary(sourceEvents, body.eventSeq);
      const session = await state.catalog.createFork(sessionId, sourceEventSeq, body.title);
      void reply.code(201);
      return { session, sourceSession, sourceEventSeq };
    } catch (error) {
      await apiFailure(reply, error);
    }
  });

  app.post("/api/v1/sessions/:sessionId/resume", async (request, reply): Promise<ResumeSessionResponse | void> => {
    try {
      requireRuntime(state);
      const { sessionId } = request.params as { sessionId: string };
      const found = await state.catalog.get(sessionId);
      if (found === undefined) throw Object.assign(new Error("会话不存在。"), { code: "SESSION_NOT_FOUND" });
      const result = await reconcileSessionActivity(state, found);
      if (result.session.activeTurnId !== null) {
        throw Object.assign(new Error("这个会话的任务仍在当前进程中运行，不能执行恢复。"), { code: "SESSION_STILL_RUNNING" });
      }
      return result;
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

  app.get("/api/v1/sessions/:sessionId/events/ws", { websocket: true }, (socket, request) => {
    // A replay keeps its original runtime even if the workspace switches while IO is pending.
    const streamState = state;
    inFlight.delete(request.id);
    sockets.add(socket);
    socket.once("close", () => { sockets.delete(socket); });
    const { sessionId } = request.params as { sessionId: string };
    const { after } = request.query as { after?: string };
    let lastSent = parsePositiveInteger(after, 0);
    let live = false;
    let closed = false;
    const pending: LiveSessionEventMessage[] = [];
    let unsubscribe = (): void => undefined;

    const send = (message: SessionEventStreamMessage): void => {
      if (!closed && socket.readyState === 1) socket.send(JSON.stringify(message));
    };
    const sendEvent = (message: LiveSessionEventMessage): void => {
      if (message.event.eventSeq <= lastSent) return;
      lastSent = message.event.eventSeq;
      send(message);
    };
    const subscriber: SessionEventSubscriber = (message) => {
      if (!live) {
        pending.push(message);
        return;
      }
      sendEvent(message);
    };

    socket.once("close", () => {
      closed = true;
      unsubscribe();
    });

    void (async () => {
      try {
        requireRuntime(streamState);
        if (cookieValue(request.headers.cookie, "daoyin_harness_session") !== streamState.sessionCookie) {
          send({ type: "error", code: "LOCAL_SESSION_REQUIRED", message: "本地浏览器会话无效，请刷新页面。" });
          socket.close(1008, "local session required");
          return;
        }
        let session = await streamState.catalog.get(sessionId);
        if (session === undefined) {
          send({ type: "error", code: "SESSION_NOT_FOUND", message: "会话不存在。" });
          socket.close(1008, "session not found");
          return;
        }

        unsubscribe = subscribeSessionEvents(streamState, sessionId, subscriber);
        const replay = await streamState.events.read(sessionId, lastSent);
        session = (await streamState.catalog.get(sessionId)) ?? session;
        for (const event of replay) sendEvent({ type: "event", event, session });
        pending.sort((left, right) => left.event.eventSeq - right.event.eventSeq);
        for (const message of pending) sendEvent(message);
        pending.length = 0;
        live = true;
        session = (await streamState.catalog.get(sessionId)) ?? session;
        send({ type: "ready", session, lastEventSeq: lastSent });
      } catch (error) {
        const candidate = error as { code?: unknown; message?: unknown };
        send({
          type: "error",
          code: typeof candidate.code === "string" ? candidate.code : "EVENT_STREAM_FAILED",
          message: typeof candidate.message === "string" ? candidate.message : "事件流初始化失败。",
        });
        socket.close(1011, "event stream failed");
      }
    })();
  });

  app.post("/api/v1/sessions/:sessionId/turns", async (request, reply): Promise<StartTurnResponse | void> => {
    const turnState = state;
    try {
      requireRuntime(turnState);
      if (turnState.authentication !== null && turnState.authentication.status().status !== "signed_in") {
        throw Object.assign(new Error("请先登录道引账号。"), { code: "AUTH_REQUIRED" });
      }
      const { sessionId } = request.params as { sessionId: string };
      const found = await turnState.catalog.get(sessionId);
      if (found === undefined) throw Object.assign(new Error("会话不存在。"), { code: "SESSION_NOT_FOUND" });
      const reconciled = await reconcileSessionActivity(turnState, found);
      const current = reconciled.session;
      if (current.activeTurnId !== null) throw Object.assign(new Error("这个会话已有任务正在执行。"), { code: "SESSION_BUSY" });

      const body = parseTurnBody(request.body);
      const inheritedEvents = await inheritedEventsForSession(turnState, current);
      const turnId = `turn_${crypto.randomUUID().replaceAll("-", "")}`;
      const controller = new AbortController();
      turnState.activeTurns.set(turnId, controller);
      await turnState.catalog.update(sessionId, {
        activeTurnId: turnId,
        updatedAt: new Date().toISOString(),
        title: current.title === "新对话" ? body.message.slice(0, 40) : current.title,
      });

      const model: ModelClient = turnState.model ?? {
        async complete() {
          throw new Error("真实模型网关尚未登录。会话与工作区已经接通，但当前不会伪造模型执行结果。");
        },
      };
      const engine = new AgentEngine({
        model,
        tools: turnState.tools,
        events: turnState.events,
        promptRegistry: turnState.promptRegistry,
        compactionStore: turnState.compactionStore,
        ...(options.compactionRetainRecentTurns === undefined ? {} : { compactionRetainRecentTurns: options.compactionRetainRecentTurns }),
        ...(options.compactionTriggerUncompactedTurns === undefined ? {} : { compactionTriggerUncompactedTurns: options.compactionTriggerUncompactedTurns }),
        ...(options.compactionTriggerCharacters === undefined ? {} : { compactionTriggerCharacters: options.compactionTriggerCharacters }),
        ...(options.compactionMaxSummaryCharacters === undefined ? {} : { compactionMaxSummaryCharacters: options.compactionMaxSummaryCharacters }),
        onEvent: async (event) => {
          const terminal = event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled" || event.type === "turn.interrupted";
          const session = await turnState.catalog.update(sessionId, {
            lastEventSeq: event.eventSeq,
            updatedAt: event.occurredAt,
            ...(terminal ? { activeTurnId: null } : {}),
          });
          publishSessionEvent(turnState, event, session);
        },
      });

      void engine.runTurn({
        accountId: turnState.accountId,
        scopeId: turnState.resourceScopeId,
        sessionId,
        turnId,
        userMessage: body.message,
        ...(inheritedEvents.length === 0 ? {} : { inheritedEvents }),
        ...(body.planning ? { systemInstruction: "Before acting, reason through the task structure and dependencies carefully. Keep the visible answer concise unless the user asks for detail." } : {}),
        signal: controller.signal,
      }).finally(async () => {
        turnState.activeTurns.delete(turnId);
        const latest = await turnState.catalog.get(sessionId);
        if (latest?.activeTurnId === turnId) {
          await turnState.catalog.update(sessionId, { activeTurnId: null, updatedAt: new Date().toISOString() });
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
