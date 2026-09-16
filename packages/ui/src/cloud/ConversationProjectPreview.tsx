import { useEffect, useRef, useState } from "react";
import { WorkbenchError, type WorkbenchClient } from "./client.js";
import "./conversation-preview.css";

interface Project { id: string; title: string }
interface Operation {
  id: string;
  kind: string;
  status: string;
  result: { running?: boolean } | null;
}
interface PreviewState {
  project: Project;
  operationId: string;
  url: string;
  updating: boolean;
  error: string;
}

export function completedPreviewOperation(operations: readonly Operation[]): Operation | null {
  return operations.find(operation => operation.kind === "preview" && operation.status === "completed" && operation.result?.running === true) ?? null;
}

export function safePreviewUrl(projectId: string, value: string): string | null {
  if (!/^prj_[a-f0-9]{24}$/u.test(projectId)) return null;
  try {
    const url = new URL(value);
    const expectedHost = `p-${projectId.slice(4)}.demo.daoyintech.com`;
    if (url.protocol !== "https:" || url.hostname !== expectedHost || url.port || url.username || url.password || url.pathname !== "/__preview" || url.hash) return null;
    const keys = [...url.searchParams.keys()];
    const ticket = url.searchParams.get("ticket") ?? "";
    return keys.length === 1 && keys[0] === "ticket" && /^[A-Za-z0-9_-]{40,64}$/u.test(ticket) ? url.href : null;
  } catch { return null; }
}

export function previewNeedsRestart(error: unknown): boolean {
  return error instanceof WorkbenchError && error.status === 409 && error.message === "预览已休眠，请重新启动。";
}

export function ConversationProjectPreview({ client, sessionId, refreshKey }: {
  client: WorkbenchClient;
  sessionId: string;
  refreshKey: string;
}): React.JSX.Element | null {
  const [state, setState] = useState<PreviewState | null>(null);
  const [poll, setPoll] = useState(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => { setState(null); }, [sessionId]);
  useEffect(() => {
    const controller = new AbortController();
    void client.project<{ project: Project | null }>({ action: "bound", sessionId }).then(async bound => {
      if (!bound.project) return null;
      const result = await client.project<{ operations: Operation[] }>({ action: "operations", projectId: bound.project.id });
      const active = result.operations.find(operation => operation.kind === "preview" && ["queued", "running"].includes(operation.status));
      if (active) {
        const previous = stateRef.current;
        return previous?.project.id === bound.project.id
          ? { ...previous, updating: true, error: "" }
          : { project: bound.project, operationId: active.id, url: "", updating: true, error: "" };
      }
      const completed = completedPreviewOperation(result.operations);
      if (!completed) return null;
      const previous = stateRef.current;
      if (previous?.project.id === bound.project.id && previous.operationId === completed.id && previous.url) return { ...previous, updating: false, error: "" };
      let ticket: { url: string };
      try {
        ticket = await client.project<{ url: string }>({ action: "ticket", projectId: bound.project.id });
      } catch (error) {
        if (!previewNeedsRestart(error)) throw error;
        const restarted = await client.project<{ operation: Operation }>({ action: "preview", projectId: bound.project.id, requestId: crypto.randomUUID() });
        return { project: bound.project, operationId: restarted.operation.id, url: "", updating: true, error: "" };
      }
      const url = safePreviewUrl(bound.project.id, ticket.url);
      if (!url) throw new Error("预览地址校验失败。");
      return { project: bound.project, operationId: completed.id, url, updating: false, error: "" };
    }).then(value => { if (!controller.signal.aborted) setState(value); }).catch(cause => {
      if (controller.signal.aborted) return;
      const previous = stateRef.current;
      if (previous) setState({ ...previous, updating: false, error: cause instanceof Error ? cause.message : "预览暂时无法打开。" });
    });
    return () => controller.abort();
  }, [client, sessionId, refreshKey, poll]);

  useEffect(() => {
    if (!state?.updating) return;
    const timer = window.setTimeout(() => setPoll(value => value + 1), 2500);
    return () => window.clearTimeout(timer);
  }, [state?.updating, poll]);

  if (!state) return null;
  return <section className="conversation-preview" aria-label="开发预览">
    <header><div><strong>开发预览</strong><span>{state.project.title}</span></div>
      <button type="button" onClick={() => { setState(previous => previous ? { ...previous, operationId: "", url: "", updating: true, error: "" } : previous); setPoll(value => value + 1); }}>重新加载</button>
    </header>
    {state.updating && !state.url && <p className="conversation-preview-status" role="status"><span className="spinner" />预览正在启动…</p>}
    {state.error && <p className="conversation-preview-error" role="alert">{state.error}</p>}
    {state.url && <div className="conversation-preview-frame"><iframe title={`${state.project.title} 开发预览`} src={state.url} sandbox="allow-scripts allow-forms allow-same-origin allow-downloads" referrerPolicy="no-referrer" />{state.updating && <span role="status"><span className="spinner" />正在更新预览…</span>}</div>}
  </section>;
}
