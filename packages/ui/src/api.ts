import type {
  BeginAuthenticationResponse,
  CreateSessionResponse,
  ForkSessionResponse,
  OrchestrationSnapshot,
  ProcessPermissionRequest,
  ResumeSessionResponse,
  RuntimeBootstrap,
  SessionEventsResponse,
  SessionSearchResponse,
  StartTurnResponse,
  WorkspaceFilesResponse,
  WorkspaceHistoryResponse,
  PickWorkspaceResponse,
  SwitchWorkspaceResponse,
} from "@daoyin/harness-protocol";

let csrfToken = "";
let workspaceRevision = "";
let runtimeInvalidated = false;
export const RUNTIME_CONTEXT_CHANGED_EVENT = "daoyin:runtime-context-changed";

export function invalidateRuntimeContext(): void {
  if (runtimeInvalidated) return;
  runtimeInvalidated = true;
  window.dispatchEvent(new Event(RUNTIME_CONTEXT_CHANGED_EVENT));
}
function staleRuntimeError(): Error {
  return Object.assign(new Error("账号或工作区已改变，请刷新后继续。"), { code: "AUTH_CONTEXT_CHANGED" });
}

interface ApiErrorShape {
  error?: {
    code?: string;
    message?: string;
  };
}

async function responseError(response: Response): Promise<Error> {
  try {
    const payload = (await response.json()) as ApiErrorShape;
    const message = payload.error?.message ?? `请求失败（${String(response.status)}）`;
    return Object.assign(new Error(message), { code: payload.error?.code ?? "HTTP_ERROR" });
  } catch {
    return new Error(`请求失败（${String(response.status)}）`);
  }
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  if (runtimeInvalidated && url !== "/api/v1/bootstrap") throw staleRuntimeError();
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (workspaceRevision.length > 0) headers.set("X-Daoyin-Workspace", workspaceRevision);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  if (csrfToken.length > 0 && init.method !== undefined && init.method !== "GET") {
    headers.set("X-Daoyin-CSRF", csrfToken);
  }
  const response = await fetch(url, { ...init, headers, credentials: "same-origin" });
  if (!response.ok) {
    const error = await responseError(response);
    const code = (error as Error & { code?: string }).code;
    if (code === "WORKSPACE_CHANGED" || code === "AUTH_CONTEXT_CHANGED") invalidateRuntimeContext();
    throw error;
  }
  const payload = (await response.json()) as T;
  if (runtimeInvalidated && url !== "/api/v1/bootstrap" && url !== "/api/v1/auth/logout" && url !== "/api/v1/workspaces/switch") throw staleRuntimeError();
  return payload;
}

export async function bootstrapRuntime(signal?: AbortSignal): Promise<RuntimeBootstrap> {
  const payload = await request<RuntimeBootstrap>("/api/v1/bootstrap", signal === undefined ? {} : { signal });
  csrfToken = payload.csrfToken;
  workspaceRevision = payload.workspaceRevision ?? "";
  runtimeInvalidated = false;
  return payload;
}

export function beginAuthentication(): Promise<BeginAuthenticationResponse> {
  return request<BeginAuthenticationResponse>("/api/v1/auth/login", { method: "POST", body: "{}" });
}

export function logoutAuthentication(): Promise<{ success: true }> {
  return request<{ success: true }>("/api/v1/auth/logout", { method: "POST", body: "{}" });
}

export function createSession(title?: string): Promise<CreateSessionResponse> {
  return request<CreateSessionResponse>("/api/v1/sessions", {
    method: "POST",
    body: JSON.stringify(title === undefined ? {} : { title }),
  });
}

export function searchSessions(query: string, limit = 20, signal?: AbortSignal): Promise<SessionSearchResponse> {
  const search = new URLSearchParams({ q: query, limit: String(limit) });
  return request<SessionSearchResponse>(
    `/api/v1/sessions/search?${search.toString()}`,
    signal === undefined ? {} : { signal },
  );
}

export function forkSession(sessionId: string, eventSeq?: number, title?: string): Promise<ForkSessionResponse> {
  return request<ForkSessionResponse>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/forks`, {
    method: "POST",
    body: JSON.stringify({
      ...(eventSeq === undefined ? {} : { eventSeq }),
      ...(title === undefined ? {} : { title }),
    }),
  });
}

export function resumeSession(sessionId: string): Promise<ResumeSessionResponse> {
  return request<ResumeSessionResponse>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/resume`, {
    method: "POST",
    body: "{}",
  });
}

export function getSessionEvents(sessionId: string, afterEventSeq = 0, signal?: AbortSignal): Promise<SessionEventsResponse> {
  const query = new URLSearchParams({ after: String(afterEventSeq) });
  return request<SessionEventsResponse>(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/events?${query.toString()}`,
    signal === undefined ? {} : { signal },
  );
}

export function openSessionEventStream(sessionId: string, afterEventSeq = 0): WebSocket {
  const url = new URL(window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/v1/sessions/${encodeURIComponent(sessionId)}/events/ws`;
  url.search = new URLSearchParams({ after: String(afterEventSeq) }).toString();
  url.hash = "";
  return new WebSocket(url);
}

export function startTurn(sessionId: string, message: string, planning = false): Promise<StartTurnResponse> {
  return request<StartTurnResponse>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/turns`, {
    method: "POST",
    body: JSON.stringify({ message, planning }),
  });
}

export function cancelTurn(sessionId: string, turnId: string): Promise<{ status: "cancelling" | "idle" }> {
  return request<{ status: "cancelling" | "idle" }>(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/cancel`,
    { method: "POST", body: "{}" },
  );
}

export function getWorkspaceFiles(signal?: AbortSignal): Promise<WorkspaceFilesResponse> {
  return request<WorkspaceFilesResponse>("/api/v1/workspace/files", signal === undefined ? {} : { signal });
}

export function getWorkspaceHistory(): Promise<WorkspaceHistoryResponse> {
  return request<WorkspaceHistoryResponse>("/api/v1/workspaces");
}

export function pickWorkspace(): Promise<PickWorkspaceResponse> {
  return request<PickWorkspaceResponse>("/api/v1/workspaces/pick", { method: "POST", body: "{}" });
}

export function switchWorkspace(root: string): Promise<SwitchWorkspaceResponse> {
  return request<SwitchWorkspaceResponse>("/api/v1/workspaces/switch", { method: "POST", body: JSON.stringify({ root }) });
}

export function getOrchestrationSnapshot(sessionId?: string, signal?: AbortSignal): Promise<OrchestrationSnapshot> {
  const query = sessionId === undefined ? "" : `?${new URLSearchParams({ sessionId }).toString()}`;
  return request<OrchestrationSnapshot>(`/api/v1/orchestration${query}`, signal === undefined ? {} : { signal });
}

export function getProcessPermissions(sessionId: string, signal?: AbortSignal): Promise<ProcessPermissionRequest[]> {
  const query = new URLSearchParams({ sessionId });
  return request<ProcessPermissionRequest[]>(`/api/v1/process/permissions?${query.toString()}`, signal === undefined ? {} : { signal });
}

export function decideProcessPermission(requestId: string, approve: boolean): Promise<ProcessPermissionRequest> {
  return request<ProcessPermissionRequest>(`/api/v1/process/permissions/${encodeURIComponent(requestId)}/decision`, {
    method: "POST",
    body: JSON.stringify({ approve }),
  });
}
