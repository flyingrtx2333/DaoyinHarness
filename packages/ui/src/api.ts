import type {
  CreateSessionResponse,
  OrchestrationSnapshot,
  ProcessPermissionRequest,
  RuntimeBootstrap,
  SessionEventsResponse,
  StartTurnResponse,
  WorkspaceFilesResponse,
} from "@daoyin/harness-protocol";

let csrfToken = "";

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
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  if (csrfToken.length > 0 && init.method !== undefined && init.method !== "GET") {
    headers.set("X-Daoyin-CSRF", csrfToken);
  }
  const response = await fetch(url, { ...init, headers, credentials: "same-origin" });
  if (!response.ok) throw await responseError(response);
  return (await response.json()) as T;
}

export async function bootstrapRuntime(signal?: AbortSignal): Promise<RuntimeBootstrap> {
  const payload = await request<RuntimeBootstrap>("/api/v1/bootstrap", signal === undefined ? {} : { signal });
  csrfToken = payload.csrfToken;
  return payload;
}

export function createSession(title?: string): Promise<CreateSessionResponse> {
  return request<CreateSessionResponse>("/api/v1/sessions", {
    method: "POST",
    body: JSON.stringify(title === undefined ? {} : { title }),
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
