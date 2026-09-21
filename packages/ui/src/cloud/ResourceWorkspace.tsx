import { useCallback, useEffect, useMemo, useState } from "react";
import type { WorkbenchClient } from "./client.js";
import "./projects.css";

interface Resource { id: string; kind: string; title: string; version: number; updatedAt: string }
interface Entry { name: string; kind: "file" | "directory" | "symlink" }
interface Snapshot { id: string; digest: string; createdAt: string; entries: unknown[] }
interface Process { id: string; executable: string; status: string; mode: string; startedAt: string }
interface Artifact { id: string; title: string; mediaType: string; size: number; createdAt: string }
interface Deployment { id: string; status: string; endpoint: string | null; createdAt: string }
interface NetworkRow { id: number; hostname: string; port: number; method: string | null; decision: string; bytesReceived: string }
interface ResourceEvent { sequence: number; eventType: string; occurredAt: string; runId: string | null; payload: unknown }
interface Inspection { workspace: Resource; snapshots: Snapshot[]; processes: Process[]; artifacts: Artifact[]; deployments: Deployment[]; network: NetworkRow[]; events: ResourceEvent[] }
type RuntimeId = "node22" | "python313" | "go125" | "rust190";
const labels: Record<string, string> = { workspace: "工作区", artifact: "制品", deployment: "部署", database: "数据库", browser: "浏览器", business: "业务资源" };

export function ResourceWorkspace({ client, ready, sessionId, onDevelop }: {
  client: WorkbenchClient; ready: boolean; sessionId: string; onDevelop: (sessionId: string) => Promise<void>;
}): React.JSX.Element {
  const [resources, setResources] = useState<Resource[]>([]), [attached, setAttached] = useState<Resource[]>([]);
  const [selected, setSelected] = useState(""), [inspection, setInspection] = useState<Inspection>();
  const [entries, setEntries] = useState<Entry[]>([]), [file, setFile] = useState(""), [content, setContent] = useState("");
  const [tab, setTab] = useState<"files" | "processes" | "snapshots" | "artifacts" | "network" | "deployments" | "events">("files");
  const [title, setTitle] = useState(""), [runtimeId, setRuntimeId] = useState<RuntimeId>("node22"), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const workspace = useMemo(() => attached.find((item) => item.id === selected && item.kind === "workspace"), [attached, selected]);
  const call = useCallback(<T,>(action: string, input: Record<string, unknown> = {}): Promise<T> => {
    if (!sessionId) return Promise.reject(new Error("请先选择一个会话，再管理其挂载资源。"));
    return client.resource<T>({ action, sessionId, requestId: crypto.randomUUID(), ...input });
  }, [client, sessionId]);
  const refresh = useCallback(async (): Promise<void> => {
    if (!ready || !sessionId) return;
    const result = await call<{ resources: Resource[]; attached: Resource[] }>("resource_list");
    setResources(result.resources); setAttached(result.attached);
    setSelected((current) => result.attached.some((item) => item.id === current && item.kind === "workspace") ? current : result.attached.find((item) => item.kind === "workspace")?.id ?? "");
  }, [call, ready, sessionId]);
  const inspect = useCallback(async (workspaceId: string): Promise<void> => {
    const [details, files] = await Promise.all([call<Inspection>("workspace_inspect", { workspaceId }), call<{ entries: Entry[] }>("file_list", { workspaceId })]);
    setInspection(details); setEntries(files.entries); setFile(""); setContent("");
  }, [call]);
  useEffect(() => { void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : "资源加载失败。")); }, [refresh]);
  useEffect(() => { if (selected) void inspect(selected).catch((cause) => setError(cause instanceof Error ? cause.message : "工作区读取失败。")); }, [inspect, selected]);
  async function perform(work: () => Promise<void>): Promise<void> { if (busy) return; setBusy(true); setError(""); try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : "操作未完成。"); } finally { setBusy(false); } }
  async function readEntry(entry: Entry): Promise<void> {
    if (!workspace || entry.kind !== "file") return;
    const result = await call<{ content: string }>("file_read", { workspaceId: workspace.id, path: entry.name, maximumBytes: 1_000_000 });
    setFile(entry.name); setContent(result.content);
  }
  const tabs = [["files", "文件"], ["processes", "进程"], ["snapshots", "快照"], ["artifacts", "制品"], ["network", "网络"], ["deployments", "部署"], ["events", "活动"]] as const;
  return <section className="project-workspace resource-workspace" aria-label="资源">
    <header className="project-heading"><h1>资源</h1><button disabled={!ready || busy || !sessionId} onClick={() => void perform(refresh)}>刷新</button></header>
    {error && <p className="project-error" role="alert">{error}</p>}
    {!ready ? <p>请先登录道引账号。</p> : !sessionId ? <p>选择一个会话后查看挂载资源。</p> : <>
      <form className="project-create" onSubmit={(event) => { event.preventDefault(); void perform(async () => { const result = await call<{ workspace: Resource }>("workspace_create", { title, source: { kind: "empty" }, runtimeId }); setTitle(""); await refresh(); setSelected(result.workspace.id); }); }}>
        <input aria-label="新工作区名称" placeholder="新工作区名称" value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} required />
        <select aria-label="运行时" value={runtimeId} onChange={(event) => setRuntimeId(event.target.value as RuntimeId)}>
          <option value="node22">Node.js 22</option><option value="python313">Python 3.13</option><option value="go125">Go 1.25</option><option value="rust190">Rust 1.90</option>
        </select>
        <button disabled={busy || !title.trim()}>创建工作区</button>
      </form>
      <div className="project-layout"><aside className="project-list" aria-label="资源列表">
        {attached.length === 0 && <p>本会话尚未挂载资源。</p>}
        {attached.map((item) => <button key={item.id} className={item.id === selected ? "selected" : ""} onClick={() => item.kind === "workspace" && setSelected(item.id)} disabled={item.kind !== "workspace"}><strong>{item.title}</strong><span>{labels[item.kind] ?? item.kind} · v{item.version}</span></button>)}
        {resources.filter((item) => !attached.some((value) => value.id === item.id)).map((item) => <button key={item.id} onClick={() => void perform(async () => { await call("resource_attach", { resourceId: item.id }); await refresh(); if (item.kind === "workspace") setSelected(item.id); })}><strong>{item.title}</strong><span>挂载{labels[item.kind] ?? item.kind}</span></button>)}
      </aside><div className="project-detail">
        {!workspace || !inspection ? <p>选择工作区查看文件、进程和制品。</p> : <>
          <header className="project-heading"><h2>{workspace.title}</h2><button disabled={busy} onClick={() => void onDevelop(sessionId)}>在会话中继续</button></header>
          <div className="resource-summary"><span>版本 {workspace.version}</span><span>{entries.length} 个根目录项</span><span>{inspection.processes.filter((item) => item.status === "running").length} 个运行进程</span></div>
          <div className="resource-tabs" role="tablist" aria-label="工作区内容">{tabs.map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>)}</div>
          {tab === "files" && <div className="resource-split"><div className="resource-table">{entries.length === 0 ? <p>工作区为空。</p> : entries.map((entry) => <button key={entry.name} className={file === entry.name ? "selected" : ""} disabled={entry.kind !== "file"} onClick={() => void perform(() => readEntry(entry))}><span>{entry.name}</span><small>{entry.kind}</small></button>)}</div><pre className="project-source" tabIndex={0}><code>{file ? content : "选择文本文件查看内容"}</code></pre></div>}
          {tab === "processes" && <div className="resource-table">{inspection.processes.length === 0 ? <p>暂无进程记录。</p> : inspection.processes.map((item) => <div key={item.id}><strong>{item.executable}</strong><span>{item.mode} · {item.status}</span>{item.status === "running" && <button onClick={() => void perform(async () => { await call("process_stop", { workspaceId: workspace.id, processId: item.id }); await inspect(workspace.id); })}>停止</button>}</div>)}</div>}
          {tab === "snapshots" && <div className="resource-table"><button className="primary" disabled={busy} onClick={() => void perform(async () => { await call("workspace_snapshot", { workspaceId: workspace.id }); await inspect(workspace.id); })}>保存当前快照</button>{inspection.snapshots.map((item) => <div key={item.id}><strong>{item.digest.slice(0, 20)}…</strong><span>{new Date(item.createdAt).toLocaleString()}</span><button onClick={() => void perform(async () => { await call("workspace_restore", { workspaceId: workspace.id, snapshotId: item.id }); await inspect(workspace.id); })}>恢复</button></div>)}</div>}
          {tab === "artifacts" && <div className="resource-table">{inspection.artifacts.length === 0 ? <p>暂无制品。</p> : inspection.artifacts.map((item) => <div key={item.id}><strong>{item.title}</strong><span>{item.mediaType} · {item.size} B</span></div>)}</div>}
          {tab === "network" && <div className="resource-table">{inspection.network.length === 0 ? <p>暂无网络活动。</p> : inspection.network.map((item) => <div key={item.id}><strong>{item.hostname}:{item.port}</strong><span>{item.method ?? "连接"} · {item.decision} · {item.bytesReceived} B</span></div>)}</div>}
          {tab === "deployments" && <div className="resource-table">{inspection.deployments.length === 0 ? <p>暂无部署。</p> : inspection.deployments.map((item) => <div key={item.id}><strong>{item.status}</strong>{item.endpoint ? <a href={item.endpoint} target="_blank" rel="noreferrer">打开 ↗</a> : <span>无公开地址</span>}</div>)}</div>}
          {tab === "events" && <div className="resource-table">{inspection.events.length === 0 ? <p>暂无活动记录。</p> : inspection.events.map((item) => <details key={item.sequence}><summary><strong>{item.eventType}</strong><span>{new Date(item.occurredAt).toLocaleString()}</span></summary><pre className="project-source"><code>{JSON.stringify(item.payload, null, 2)}</code></pre></details>)}</div>}
        </>}
      </div></div>
    </>}
  </section>;
}
