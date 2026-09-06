import { useEffect, useRef, useState } from "react";
import type { AgentEvent } from "@daoyin/harness-protocol";
import { MarkdownMessage } from "../MarkdownMessage.js";
import { WorkbenchClient, WorkbenchError, type CloudRun, type CloudSession } from "./client.js";
import { projectTurns } from "./projection.js";
import { PluginCatalog, PluginPicker } from "./PluginBrowser.js";
import { selectablePlugin, sessionPlugin } from "./plugins.js";
import { HarnessLogo } from "./HarnessLogo.js";
import { WorkbenchIcon } from "./WorkbenchIcon.js";

const SELECTED = "daoyin-harness-cloud-selected-v1";
const storage = {
  getItem: (key: string): string | null => window.sessionStorage.getItem(key),
  setItem: (key: string, value: string): void => window.sessionStorage.setItem(key, value),
  removeItem: (key: string): void => window.sessionStorage.removeItem(key),
};
const statusText = { queued: "等待中", running: "进行中", completed: "已完成", failed: "未完成", cancelled: "已停止", interrupted: "已中断" };

export function App(): React.JSX.Element {
  const [client] = useState(() => new WorkbenchClient(storage));
  const [phase, setPhase] = useState<"connecting" | "ready" | "error" | "expired">("connecting");
  const [expiresAt, setExpiresAt] = useState(0);
  const [sessions, setSessions] = useState<CloudSession[]>([]);
  const [selected, setSelected] = useState("");
  const [runs, setRuns] = useState<CloudRun[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [revision, setRevision] = useState(0);
  const [sidebar, setSidebar] = useState(false);
  const [view, setView] = useState<"chat" | "plugins">("chat");
  const [chosenPlugin, setChosenPlugin] = useState("company-knowledge");
  const submission = useRef<Promise<CloudRun> | null>(null);
  const connecting = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const active = runs.find((run) => run.status === "running" || run.status === "queued");
  const pending = selected ? client.pending(selected) : undefined;
  const turns = projectTurns(runs, events);
  const session = sessions.find((item) => item.id === selected);
  const plugin = selected ? session && sessionPlugin(session.profileId) : selectablePlugin(chosenPlugin);
  const pluginBusy = submitting || loading || !!active || !!pending;

  function fail(cause: unknown): void {
    setError(cause instanceof WorkbenchError ? cause.message : "连接未完成，请重试。");
    if (cause instanceof WorkbenchError && cause.status === 401) {
      setPhase("expired"); setRuns([]); setEvents([]); setSessions([]);
    }
  }
  async function connect(): Promise<void> {
    if (connecting.current) return;
    connecting.current = true; setPhase("connecting"); setError("");
    try {
      const expiry = await client.bootstrap();
      const list = await client.sessions();
      let saved = "";
      try { saved = storage.getItem(SELECTED) ?? ""; } catch { /* Submission provides a storage error if necessary. */ }
      setExpiresAt(expiry); setSessions(list);
      setSelected(list.some((item) => item.id === saved) ? saved : list[0]?.id ?? "");
      setPhase("ready"); setRevision((value) => value + 1);
    } catch (cause) { setPhase("error"); fail(cause); }
    finally { connecting.current = false; }
  }
  useEffect(() => { void connect(); }, []); // One bootstrap; the entry intentionally does not double-mount effects.
  useEffect(() => {
    if (phase !== "ready") return;
    const timer = window.setTimeout(() => {
      setPhase("expired"); setRuns([]); setEvents([]); setSessions([]);
      setError("访客授权已到期。重新进入将创建新的访客空间，旧空间的会话不会转入。");
    }, Math.max(0, expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [phase, expiresAt]);
  useEffect(() => {
    setRuns([]); setEvents([]); nearBottom.current = true;
    if (!selected || phase !== "ready") { setLoading(false); return; }
    const controller = new AbortController();
    let timer: number | undefined;
    let accumulated: AgentEvent[] = [];
    setLoading(true);
    try { storage.setItem(SELECTED, selected); } catch { /* No model work occurs here. */ }
    async function refresh(): Promise<void> {
      try {
        const nextRuns = await client.runs(selected, controller.signal);
        const additions = await client.events(selected, accumulated.at(-1)?.eventSeq ?? 0, controller.signal);
        if (controller.signal.aborted) return;
        accumulated = [...accumulated, ...additions];
        setRuns(nextRuns); setEvents(accumulated); setLoading(false);
        if (nextRuns.some((run) => run.status === "running" || run.status === "queued")) timer = window.setTimeout(() => { void refresh(); }, 1400);
      } catch (cause) {
        if (!controller.signal.aborted) { setLoading(false); fail(cause); }
      }
    }
    void refresh();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [selected, phase, revision, client]);
  useEffect(() => {
    if (nearBottom.current) bottom.current?.scrollIntoView({ block: "end" });
  }, [events.length, runs.length]);

  function choose(id: string): void {
    setSelected(id); setDraft(""); setError(""); setSidebar(false); setView("chat");
    if (!id) try { storage.removeItem(SELECTED); } catch { /* Optional selection history. */ }
  }
  function browsePlugins(): void {
    setView("plugins"); setSidebar(false);
    window.requestAnimationFrame(() => document.getElementById("conversation")?.focus());
  }
  function usePlugin(id: string, focusComposer = true): void {
    const choice = selectablePlugin(id);
    if (!choice || pluginBusy) return;
    if (selected && session?.profileId !== choice.profileId) choose("");
    setChosenPlugin(id); setView("chat"); setSidebar(false); setError("");
    if (focusComposer) window.requestAnimationFrame(() => document.getElementById("message")?.focus());
  }
  async function send(message = draft.trim()): Promise<void> {
    if (!message || submission.current || active || phase !== "ready" || loading) return;
    if (!plugin?.profileId) { setError("当前会话的插件尚未支持，请新建会话并选择可用插件。"); return; }
    setSubmitting(true); setError("");
    const operation = (async (): Promise<CloudRun> => {
      let id = selected;
      if (!id) {
        const created = await client.createSession(message, plugin.profileId);
        id = created.id; setSessions((list) => [created, ...list]); setSelected(id);
      }
      return client.submit(id, message);
    })();
    submission.current = operation;
    try {
      await operation; setDraft(""); nearBottom.current = true;
    } catch (cause) { fail(cause); }
    finally { submission.current = null; setSubmitting(false); setRevision((value) => value + 1); }
  }
  async function cancel(): Promise<void> {
    if (cancelling) return;
    setCancelling(true); setError("");
    try {
      const run = submission.current ? await submission.current : active;
      if (run) await client.cancel(run.id);
      setRevision((value) => value + 1);
    } catch (cause) { fail(cause); }
    finally { setCancelling(false); }
  }

  return <div className="workbench">
    <a className="skip-link" href="#conversation">跳到对话</a>
    <aside className={`sidebar ${sidebar ? "is-open" : ""}`} aria-label="会话导航">
      <a className="brand" href="/harness/"><span className="brand-mark" aria-hidden="true"><HarnessLogo /></span><span>道引 Harness</span></a>
      <nav className="workspace-tabs" aria-label="工作台导航"><button aria-current={view === "chat" ? "page" : undefined} onClick={() => { setView("chat"); setSidebar(false); }}><WorkbenchIcon name="chat" />会话</button><button aria-current={view === "plugins" ? "page" : undefined} onClick={browsePlugins}><WorkbenchIcon name="plugin" />插件</button></nav>
      <button className="new-session" disabled={phase !== "ready" || submitting} onClick={() => choose("")}><span aria-hidden="true">＋</span> 新建会话</button>
      <label className="search"><span>搜索会话</span><WorkbenchIcon name="search" /><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索会话" /></label>
      <div className="sidebar-label">最近会话 <span>{sessions.length}</span></div>
      <nav aria-label="最近会话" className="session-list">
        {sessions.filter((item) => item.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map((item) =>
          <button key={item.id} aria-current={view === "chat" && selected === item.id ? "page" : undefined} disabled={submitting} onClick={() => choose(item.id)} title={item.title}>{item.title || "未命名会话"}</button>)}
        {sessions.length === 0 && <p className="muted">暂无会话</p>}
      </nav>
      <div className="scope"><WorkbenchIcon name="user" /><div>访客空间 <span className="scope-dot" aria-hidden="true" /><small>{expiresAt && phase === "ready" ? `授权至 ${new Date(expiresAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : "每次授权 30 分钟"}</small></div></div>
      <a className="site-link" href="/" target="_blank" rel="noopener noreferrer"><WorkbenchIcon name="globe" />官网 <span aria-hidden="true">↗</span></a>
    </aside>
    <main id="conversation" className="main" tabIndex={-1}>
      <header className="topbar">
        <button className="menu-button" aria-label={sidebar ? "收起会话导航" : "展开会话导航"} aria-expanded={sidebar} onClick={() => setSidebar(!sidebar)}><WorkbenchIcon name="menu" /></button>
        <div className="session-heading"><WorkbenchIcon name={view === "plugins" ? "plugin" : "edit"} /><h1>{view === "plugins" ? "插件" : session?.title || "新会话"}</h1></div>
        <button className="refresh-button" disabled={phase === "connecting" || submitting || loading} onClick={() => { setError(""); void connect(); }}><WorkbenchIcon name="connection" />重新连接</button>
      </header>
      {view === "plugins" && <div className="transcript plugin-transcript"><PluginCatalog selectedId={plugin?.id ?? ""} onSelect={(id) => usePlugin(id)} busy={pluginBusy} /></div>}
      <div className="transcript" hidden={view !== "chat"} onScroll={(event) => { const element = event.currentTarget; nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 160; }}>
        <div className="conversation-content">
          {phase === "connecting" && <p className="connection-message" role="status"><span className="spinner" /> 正在连接工作台…</p>}
          {phase === "ready" && loading && <p className="connection-message" role="status">正在恢复会话…</p>}
          {phase === "ready" && !loading && turns.length === 0 && <section className="empty-state"><span className="empty-mark" aria-hidden="true"><HarnessLogo /></span><h2>今天，想完成什么？</h2><div className="suggestions">{[{ label: "了解道引的产品", text: "道引科技有哪些产品？", icon: "book" as const }, { label: "查看文旅方案", text: "介绍一下互动文旅方案", icon: "pin" as const }].map(({ label, text, icon }) => <button key={text} onClick={() => { setDraft(text); document.getElementById("message")?.focus(); }}><WorkbenchIcon name={icon} />{label}<WorkbenchIcon name="chevron" /></button>)}</div></section>}
          {turns.map((turn) => <article className="turn" key={turn.run.id} aria-label="一轮对话">
            <div className="user-message"><span className="message-label">你</span><p>{turn.run.userMessage}</p></div>
            <div className="assistant-message"><div className="assistant-label"><span className="mini-mark" aria-hidden="true"><HarnessLogo /></span> Harness <span className="run-status">{statusText[turn.run.status]}</span></div>
              {turn.tools.length > 0 && <div className="tools">{turn.tools.map((tool) => <div className="tool-line" key={tool.id}>{tool.status === "running" ? <span className="spinner" /> : <span aria-hidden="true">{tool.status === "completed" ? "✓" : "·"}</span>}{tool.text}</div>)}</div>}
              <div className="markdown">{turn.text ? <MarkdownMessage text={turn.text} /> : turn.run.status === "running" ? <p className="thinking"><span className="spinner" /> 正在处理你的问题…</p> : null}</div>
              {turn.sources.length > 0 && <details className="sources"><summary>参考资料 <span>{turn.sources.length}</span></summary>{turn.sources.map((source) => <details className="source" key={source.id}><summary>{source.title || "公开资料"}{source.location && <small>{source.location}</small>}</summary><p>{source.content}</p></details>)}</details>}
              {turn.run.cancelRequested && turn.run.status === "running" && <p role="status" className="muted">正在停止，已完成的记录会保留。</p>}
            </div>
          </article>)}
          <div ref={bottom} />
        </div>
      </div>
      <div className="composer-area" hidden={view !== "chat"}>
        {error && <div className="error-message" role="alert">{error}</div>}
        {phase !== "ready" && phase !== "connecting" && <button className="primary reconnect" onClick={() => { void connect(); }}>重新进入工作台</button>}
        {pending && phase === "ready" && !submitting && <div className="recovery"><span>上次提交结果尚未确认。</span><button disabled={loading || !!active} onClick={() => { void send(pending.message); }}>恢复原提交</button></div>}
        <form className="composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
          <label htmlFor="message" className="sr-only">发送给 Harness 的问题</label>
          <textarea id="message" value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={10000} rows={2} disabled={phase !== "ready" || submitting || !!pending} placeholder="描述你的问题…" onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
          <div className="composer-controls"><div className="composer-plugins"><PluginPicker selectedId={plugin?.id ?? ""} onSelect={(id) => usePlugin(id, false)} onBrowse={browsePlugins} busy={pluginBusy} /><button type="button" className="selected-plugin" onClick={browsePlugins} aria-label={`查看${plugin?.name ?? "会话插件"}详情`}>{plugin?.name ?? "选择插件"}{plugin && <span className="plugin-check" aria-hidden="true">✓</span>}</button>{active && <span className="composer-busy">进行中</span>}</div>{submitting || active ? <button type="button" className="stop-button" disabled={cancelling || active?.cancelRequested} onClick={() => { void cancel(); }}>{cancelling || active?.cancelRequested ? "正在停止…" : "停止生成"}</button> : <button type="submit" className="primary send-button" aria-label="发送" disabled={!draft.trim() || phase !== "ready" || loading || !!pending || !plugin}><WorkbenchIcon name="arrow" /></button>}</div>
        </form>
        <p className="composer-note">依据公开资料回答，请核对引用</p>
        <div className="sr-only" role="status">{submitting ? "正在提交问题" : active ? "任务进行中" : turns.length ? "回答已更新" : ""}</div>
      </div>
    </main>
  </div>;
}
