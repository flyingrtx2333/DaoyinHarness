export const API_VERSION = "v1" as const;

export type Readiness = "ready" | "planned" | "unavailable";

export interface RuntimeHealth {
  status: "ready";
  apiVersion: typeof API_VERSION;
  version: string;
  startedAt: string;
  checkedAt: string;
  runtime: {
    host: "127.0.0.1";
    port: number;
    node: string;
    pid: number;
  };
  capabilities: {
    process: Readiness;
    sandbox: Readiness;
    database: Readiness;
    workspace: Readiness;
    authentication: Readiness;
    modelGateway: Readiness;
    browser: Readiness;
    mcp: Readiness;
  };
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    requestId: string;
    details: Record<string, unknown>;
  };
}

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type TurnStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type ToolCallStatus = "requested" | "running" | "completed" | "failed" | "cancelled";
export type MemoryScope = "session" | "resource" | "account";
export type MemoryKind = "preference" | "fact" | "goal" | "decision" | "note";
export type ProcessRisk = "inspect" | "workspace_exec" | "network" | "system";
export type ProcessPermissionStatus = "pending" | "approved" | "denied" | "consumed";
export type SandboxMode = "auto" | "required" | "off";
export type SandboxProviderId = "bubblewrap" | "none";
export type SandboxOsIsolation = "bubblewrap" | "none";
export type SandboxNetworkIsolation = "blocked" | "none";

export interface SandboxRuntimeStatus {
  mode: SandboxMode;
  provider: SandboxProviderId;
  available: boolean;
  osIsolation: SandboxOsIsolation;
  networkIsolation: SandboxNetworkIsolation;
  reason: string;
}

export interface ProcessPermissionRequest {
  id: string;
  accountId: string;
  resourceScopeId: string;
  sessionId: string;
  turnId: string;
  operation: string;
  displayCommand: string;
  fingerprint: string;
  risk: ProcessRisk;
  reason: string;
  status: ProcessPermissionStatus;
  createdAt: string;
  decidedAt: string | null;
}

export interface MemoryRecord {
  id: string;
  accountId: string;
  scope: MemoryScope;
  scopeId: string;
  kind: MemoryKind;
  content: string;
  keywords: string[];
  confidence: number;
  sourceEventIds: string[];
  createdAt: string;
  supersedes: string | null;
  tombstone: boolean;
}

export interface MemorySearchHit {
  record: MemoryRecord;
  score: number;
  reasons: string[];
}

export interface SessionCompaction {
  id: string;
  sessionId: string;
  sourceStartSeq: number;
  sourceEndSeq: number;
  summary: string;
  strategy: string;
  createdAt: string;
}

export interface ToolEvidence {
  schemaVersion: 1;
  toolName: string;
  result: JsonValue;
  artifacts: string[];
  diagnostics: string[];
}

export interface AgentEventPayloads {
  "turn.started": {
    status: "running";
    userMessageId: string;
    userMessage: string;
  };
  "assistant.delta": {
    contentBlockId: string;
    delta: string;
  };
  "tool.started": {
    toolCallId: string;
    toolName: string;
    displayText: string;
    input?: JsonValue;
  };
  "tool.completed": {
    toolCallId: string;
    toolName: string;
    summary: string;
    evidence: ToolEvidence;
  };
  "tool.failed": {
    toolCallId: string;
    toolName: string;
    code: string;
    message: string;
    retryable: boolean;
    details?: JsonValue;
  };
  "turn.completed": {
    status: "completed";
    assistantMessageId: string;
    outcomeSummary: string;
  };
  "turn.failed": {
    status: "failed";
    assistantMessageId: string;
    code: string;
    outcomeSummary: string;
  };
  "turn.cancelled": {
    status: "cancelled";
    source: "user" | "runtime";
    lastCompletedEventSeq: number;
  };
}

export type AgentEventType = keyof AgentEventPayloads;

type EventBase<TType extends AgentEventType> = {
  id: string;
  eventSeq: number;
  type: TType;
  accountId: string;
  scopeId: string;
  sessionId: string;
  turnId: string;
  occurredAt: string;
  payload: AgentEventPayloads[TType];
};

export type AgentEvent = {
  [TType in AgentEventType]: EventBase<TType>;
}[AgentEventType];

export type PendingAgentEvent<TType extends AgentEventType = AgentEventType> = {
  type: TType;
  accountId: string;
  scopeId: string;
  sessionId: string;
  turnId: string;
  payload: AgentEventPayloads[TType];
};

export interface LocalSessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastEventSeq: number;
  activeTurnId: string | null;
}

export interface WorkspaceSummary {
  name: string;
  root: string;
  fileCount: number;
}

export type ToolCapabilityCategory = "workspace" | "web" | "browser" | "process" | "system" | "extension";

export interface ToolCapabilitySummary {
  name: string;
  description: string;
  category: ToolCapabilityCategory;
  mutating: boolean;
}

export interface McpServerSummary {
  id: string;
  endpoint: string;
  status: "connected" | "failed";
  serverName: string | null;
  serverVersion: string | null;
  toolCount: number;
  errorCode?: string;
  message?: string;
}

export interface RuntimeBootstrap {
  csrfToken: string;
  health: RuntimeHealth;
  sandbox: SandboxRuntimeStatus;
  workspace: WorkspaceSummary | null;
  sessions: LocalSessionSummary[];
  tools: ToolCapabilitySummary[];
  mcpServers: McpServerSummary[];
}

export interface SessionEventsResponse {
  session: LocalSessionSummary;
  events: AgentEvent[];
  lastEventSeq: number;
}

export type SessionEventStreamMessage =
  | { type: "ready"; session: LocalSessionSummary; lastEventSeq: number }
  | { type: "event"; session: LocalSessionSummary; event: AgentEvent }
  | { type: "error"; code: string; message: string };

export interface CreateSessionRequest {
  title?: string;
}

export interface CreateSessionResponse {
  session: LocalSessionSummary;
}

export interface StartTurnRequest {
  message: string;
  planning?: boolean;
}

export interface StartTurnResponse {
  sessionId: string;
  turnId: string;
  status: "accepted";
}

export interface WorkspaceFilesResponse {
  root: string;
  files: string[];
}
