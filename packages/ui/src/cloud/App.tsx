import { useEffect, useRef, useState } from "react";
import type { AgentEvent } from "@daoyin/harness-protocol";
import { MarkdownMessage } from "../MarkdownMessage.js";
import { WorkbenchClient, WorkbenchError, type AccountProfile, type CloudRun, type CloudSession, type SessionAction } from "./client.js";
import { SessionHistory } from "./SessionHistory.js";
import { projectTurns } from "./projection.js";
import { watchCloudSession } from "./event-feed.js";
import { PluginWorkspace } from "./PluginWorkspace.js";
import { HarnessLogo } from "./HarnessLogo.js";
import { WorkbenchIcon } from "./WorkbenchIcon.js";
import { AccountIdentity } from "./AccountIdentity.js";
import { scheduleExpiry } from "./expiry.js";
import { SettingsDialog } from "./SettingsDialog.js";
import { ToolActivity } from "./ToolActivity.js";
import { StoryVideos } from "./StoryVideos.js";
import { StoryUpload, type StoryReference } from "./StoryUpload.js";
import { ImageGallery } from "./ImageGallery.js";
import { DEFAULT_PREFERENCES, PREFERENCES_KEY, isSendShortcut, readPreferences, type WorkbenchPreferences } from "./preferences.js";

const APPLICATION = "saishi" as const;
const entryUrl = new URL(window.location.href);
if (entryUrl.searchParams.has("app")) {
  entryUrl.searchParams.delete("app");
  window.history.replaceState(null, "", entryUrl.pathname + entryUrl.search + entryUrl.hash);
}
const SELECTED = "daoyin-harness-cloud-selected-v2";
const storage = {
  getItem: (key: string): string | null => window.localStorage.getItem(key),
  setItem: (key: string, value: string): void => window.localStorage.setItem(key, value),
  removeItem: (key: string): void => window.localStorage.removeItem(key),
};
const statusText = { queued: "等待中", running: "进行中", completed: "已完成", failed: "未完成", cancelled: "已停止", interrupted: "已中断" };

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function referenceLine(reference: StoryReference): string {
  return `[已上传参考${reference.mimeType === "video/mp4" ? "视频" : "图片"}，文件名：${reference.name}，素材 ID：${reference.id}]`;
}

function visibleUserMessage(message: string): string {
  return message.replace(/\[已上传参考(图片|视频)，文件名：([^，\]]+)，素材 ID：[^\]]+\]/gu, "参考$1：$2")
    .replace(/\[已上传参考(图片|视频)，素材 ID：[^\]]+\]/gu, "已添加参考$1").trim();
}

function MessageTime({ value }: { value: string }): React.JSX.Element | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return <time className="message-time" dateTime={value}>{new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date)}</time>;
}

export function App(): React.JSX.Element {
  const [client] = useState(() => new WorkbenchClient(storage, undefined, APPLICATION));
  const [phase, setPhase] = useState<"connecting" | "ready" | "error" | "expired">("connecting");
  const [expiresAt, setExpiresAt] = useState(0);
  const [account, setAccount] = useState<AccountProfile>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [preferences, setPreferences] = useState(() => { try { return readPreferences(window.localStorage); } catch { return DEFAULT_PREFERENCES; } });
  const [preferenceError, setPreferenceError] = useState("");
  const [sessions, setSessions] = useState<CloudSession[]>([]);
  const [selected, setSelected] = useState("");
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [managing, setManaging] = useState("");
  const sessionMutation = useRef(false);
  const [runs, setRuns] = useState<CloudRun[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [loginUrl, setLoginUrl] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [references, setReferences] = useState<StoryReference[]>([]);
  const [sendingMessage, setSendingMessage] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [revision, setRevision] = useState(0);
  const [sidebar, setSidebar] = useState(false);
  const [view, setView] = useState<"chat" | "plugins">(() => window.location.hash.startsWith("#plugins") ? "plugins" : "chat");
  const submission = useRef<Promise<CloudRun> | null>(null);
  const connecting = useRef(false);
  const loggingOut = useRef(false);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const accountEpoch = useRef(0);
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  const bottom = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const feed = useRef<{ key: string; events: AgentEvent[] }>({ key: "", events: [] });
  const active = runs.find((run) => run.status === "running" || run.status === "queued");
  const pending = selected ? client.pending(selected) : undefined;
  const turns = projectTurns(runs, events);
  const session = sessions.find((item) => item.id === selected);
  const authorizedProfiles = phase === "ready" ? ["daoyin-workbench", "company-public", "saishi-readonly", "story-quick"] : [];
  const plugin = { id: "all", name: "全部插件", profileId: "daoyin-workbench" };
  const pluginBusy = uploading || submitting || loading || !!active || !!pending;

  function fail(cause: unknown): void {
    setError(cause instanceof WorkbenchError ? cause.message : "连接未完成，请重试。");
    setLoginUrl(cause instanceof WorkbenchError ? cause.loginUrl : undefined);
    if (cause instanceof WorkbenchError && (cause.status === 401 || cause.status === 403)) {
      accountEpoch.current++;
      setAccount(undefined); setSettingsOpen(false); setSendingMessage("");
      setPhase("expired"); setRuns([]); setEvents([]); setSessions([]); setSelected(""); setDraft(""); setReferences([]);
    }
  }
  async function connect(background = false): Promise<void> {
    if (connecting.current || loggingOut.current) return;
    const quiet = background && phaseRef.current === "ready";
    const previousScope = client.accountScope;
    const savedDraft = currentDraft.current;
    connecting.current = true;
    if (!quiet) { setPhase("connecting"); setError(""); setLoginUrl(undefined); }
    function resetAccount(): void { accountEpoch.current++; setAccount(undefined); setSettingsOpen(false); setSendingMessage(""); setRuns([]); setEvents([]); setSessions([]); setSelected(""); setDraft(""); setReferences([]); }
    if (!quiet) resetAccount();
    try {
      const expiry = await client.bootstrap(quiet);
      if (loggingOut.current) return;
      if (quiet && previousScope && previousScope === client.accountScope) {
        setExpiresAt(expiry); setAccount(client.account);
        return; // A routine identity check must not reset history, draft, focus or a running turn.
      }
      if (quiet) { resetAccount(); setPhase("connecting"); setError(""); setLoginUrl(undefined); }
      const list = await client.sessions();
      if (loggingOut.current) return;
      let saved = "";
      try { saved = storage.getItem(SELECTED) ?? ""; } catch { /* Submission provides a storage error if necessary. */ }
      setExpiresAt(expiry); setAccount(client.account); setSessions(list);
      if (previousScope && previousScope === client.accountScope) setDraft(savedDraft);
      setSelected(list.some((item) => item.id === saved && !item.archivedAt) ? saved : list.find((item) => !item.archivedAt)?.id ?? "");
      setPhase("ready"); setRevision((value) => value + 1);
    } catch (cause) {
      if (!loggingOut.current) {
        if (!quiet || previousScope !== client.accountScope) { if (quiet) resetAccount(); setPhase("error"); }
        fail(cause);
      }
    }
    finally { connecting.current = false; }
  }
  useEffect(() => { void connect(); }, []); // One bootstrap; the entry intentionally does not double-mount effects.
  useEffect(() => {
    let timer: number | undefined;
    const checkAccount = (): void => {
      window.clearTimeout(timer);
      if (document.visibilityState === "visible") timer = window.setTimeout(() => { void connect(true); }, 100);
    };
    window.addEventListener("focus", checkAccount);
    document.addEventListener("visibilitychange", checkAccount);
    return () => { window.clearTimeout(timer); window.removeEventListener("focus", checkAccount); document.removeEventListener("visibilitychange", checkAccount); };
  }, []);
  useEffect(() => {
    if (phase !== "ready") return;
    return scheduleExpiry(expiresAt, () => {
      void connect(); return;
    });
  }, [phase, expiresAt]);
  useEffect(() => {
    const key = phase === "ready" && selected ? `${accountEpoch.current}:${selected}` : "";
    const changed = feed.current.key !== key;
    if (changed) { feed.current = { key, events: [] }; setRuns([]); setEvents([]); nearBottom.current = true; }
    if (!key) { setLoading(false); return; }
    const epoch = accountEpoch.current;
    let recoveryError = "";
    if (changed) setLoading(true);
    try { storage.setItem(SELECTED, selected); } catch { /* No model work occurs here. */ }
    return watchCloudSession(client, selected, {
      events: feed.current.events,
      onUpdate: (nextRuns, accumulated) => {
        if (epoch !== accountEpoch.current || loggingOut.current) return;
        feed.current = { key, events: accumulated };
        setRuns(nextRuns); setEvents(accumulated); setLoading(false);
        if (recoveryError) { const recovered = recoveryError; setError(current => current === recovered ? "" : current); recoveryError = ""; }
      },
      onError: (cause) => {
        if (epoch !== accountEpoch.current || loggingOut.current) return;
        recoveryError = cause instanceof WorkbenchError ? cause.message : "连接未完成，请重试。";
        setLoading(false); fail(cause);
      },
    });
  }, [selected, phase, revision, client]);
  useEffect(() => {
    if (preferences.autoScroll && nearBottom.current) bottom.current?.scrollIntoView({ block: "end" });
  }, [events.length, runs.length, sendingMessage, preferences.autoScroll]);

  function savePreferences(value: WorkbenchPreferences): void {
    setPreferences(value);
    try { window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(value)); setPreferenceError(""); }
    catch { setPreferenceError("设置已在当前页面生效，浏览器未能保存。"); }
  }
  function closeSettings(): void {
    setSettingsOpen(false);
    window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".account-identity")?.focus());
  }
  function closeSidebar(): void {
    setSidebar(false);
    window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".mobile-menu-button")?.focus());
  }
  async function logout(): Promise<void> {
    if (loggingOut.current) return;
    loggingOut.current = true;
    try {
      try { await client.disconnectApplication(); } catch (cause) { if (!(cause instanceof WorkbenchError && cause.status === 401)) throw cause; }
      // Match the platform's legacy user-store sign-out contract; never read the token.
      window.localStorage.removeItem("athletereel_token");
      accountEpoch.current++; setAccount(undefined); setSettingsOpen(false); setSessions([]); setRuns([]); setEvents([]); setSelected(""); setDraft(""); setReferences([]); setPhase("expired");
      window.location.replace("/harness/");
    } catch (cause) { loggingOut.current = false; throw cause; }
  }

  function choose(id: string): void {
    setSelected(id); setDraft(""); setReferences([]); setError(""); setSidebar(false); setView("chat");
    if (!id) try { storage.removeItem(SELECTED); } catch { /* Optional selection history. */ }
  }
  function isSessionProtected(id: string): boolean {
    return !!client.pending(id) || (id === selected && (loading || submitting || !!active));
  }
  async function manageSession(id: string, action: SessionAction, confirm = false): Promise<void> {
    if (sessionMutation.current || submitting || phase !== "ready") throw new WorkbenchError("请等待当前操作完成。");
    if ((action === "archive" || action === "delete") && isSessionProtected(id)) throw new WorkbenchError("请先停止生成或确认原提交结果。");
    const epoch = accountEpoch.current;
    sessionMutation.current = true; setManaging(id); setError("");
    try {
      const updated = await client.manageSession(id, action, confirm);
      if (epoch !== accountEpoch.current || loggingOut.current) throw new WorkbenchError("账号已变化，请在当前账号中重新查看会话。");
      setSessions((list) => updated ? list.map((item) => item.id === id ? updated : item) : list.filter((item) => item.id !== id));
      if (selectedRef.current === id && (action === "archive" || action === "delete")) choose("");
    } catch (cause) {
      if (epoch === accountEpoch.current) fail(cause);
      throw cause;
    } finally { sessionMutation.current = false; setManaging(""); }
  }
  function browsePlugins(): void {
    setView("plugins"); setSidebar(false);
    window.requestAnimationFrame(() => document.getElementById("conversation")?.focus());
  }
  function usePlugin(id: string, focusComposer = true): void {
    if (pluginBusy) return;
    void id; setView("chat"); setSidebar(false); setError("");
    if (focusComposer) window.requestAnimationFrame(() => document.getElementById("message")?.focus());
  }
  async function send(message?: string): Promise<void> {
    const visibleMessage = message === undefined ? draft.trim() : visibleUserMessage(message);
    const submittedMessage = message === undefined && references.length
      ? `${visibleMessage}\n\n${references.map(referenceLine).join("\n")}` : message ?? visibleMessage;
    if (uploading || !visibleMessage || submission.current || sessionMutation.current || active || phase !== "ready" || loading) return;
    if (session?.archivedAt) { setError("请先恢复已归档的会话，或新建会话。"); return; }
    if (!plugin?.profileId) { setError("当前会话的插件尚未支持，请新建会话并选择可用插件。"); return; }
    setSubmitting(true); setSendingMessage(visibleMessage); setError(""); nearBottom.current = true;
    const epoch = accountEpoch.current;
    const operation = (async (): Promise<CloudRun> => {
      let id = selected;
      if (!id) {
        const created = await client.createSession(visibleMessage, plugin.profileId);
        if (epoch !== accountEpoch.current) throw new WorkbenchError("账号连接已变化，原问题未继续提交。");
        id = created.id; setSessions((list) => [created, ...list]); setSelected(id);
      }
      return client.submit(id, submittedMessage);
    })();
    submission.current = operation;
    try {
      const accepted = await operation;
      if (epoch === accountEpoch.current) {
        setRuns((current) => [accepted, ...current.filter((run) => run.id !== accepted.id)]);
        setDraft(""); setReferences([]); nearBottom.current = true;
      }
    } catch (cause) { if (epoch === accountEpoch.current) fail(cause); }
    finally { submission.current = null; setSubmitting(false); setSendingMessage(""); if (epoch === accountEpoch.current) setRevision((value) => value + 1); }
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
    <aside className={`sidebar ${sidebar ? "is-open" : ""}`} aria-label="会话导航" onKeyDown={(event) => { if (event.key === "Escape" && sidebar) { event.preventDefault(); closeSidebar(); } }}>
      <button type="button" className="sidebar-close" aria-label="关闭会话导航" onClick={closeSidebar}>×</button>
      <a className="brand" href="/harness/"><span className="brand-mark" aria-hidden="true"><HarnessLogo /></span><span>道引 Harness</span></a>
      <nav className="workspace-tabs" aria-label="工作台导航"><button aria-current={view === "chat" ? "page" : undefined} onClick={() => { setView("chat"); setSidebar(false); }}><WorkbenchIcon name="chat" />会话</button><button aria-current={view === "plugins" ? "page" : undefined} onClick={browsePlugins}><WorkbenchIcon name="plugin" />插件</button></nav>
      <SessionHistory key={`${APPLICATION}:${client.accountScope}:${accountEpoch.current}:${phase}`} sessions={sessions} selected={selected} chatActive={view === "chat"}
        disabled={phase !== "ready" || submitting || !!managing} isProtected={isSessionProtected} onChoose={choose} onManage={manageSession} />
      {phase === "ready" && account && <footer className="sidebar-footer"><AccountIdentity key={client.accountScope} account={account} onSettings={() => setSettingsOpen(true)} onLogout={logout} /></footer>}
    </aside>
    <main id="conversation" className="main" tabIndex={-1}>
      <button className="mobile-menu-button" aria-label={sidebar ? "收起会话导航" : "展开会话导航"} aria-expanded={sidebar} onClick={() => setSidebar(!sidebar)}><WorkbenchIcon name="menu" /></button>
      {view === "plugins" && <div className="transcript plugin-transcript"><PluginWorkspace key={`${APPLICATION}:${client.accountScope}`} selectedId={plugin?.id ?? ""} onSelect={(id) => usePlugin(id)} busy={pluginBusy} authorizedProfiles={authorizedProfiles} /></div>}
      <div className="transcript" hidden={view !== "chat"} onScroll={(event) => { const element = event.currentTarget; nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 160; }}>
        <div className="conversation-content">
          {phase === "connecting" && <p className="connection-message" role="status"><span className="spinner" /> 正在连接工作台…</p>}
          {phase === "ready" && loading && !sendingMessage && <p className="connection-message" role="status">正在恢复会话…</p>}
          {phase === "ready" && !loading && !sendingMessage && turns.length === 0 && <section className="empty-state"><span className="empty-mark" aria-hidden="true"><HarnessLogo /></span><h2>今天，想完成什么？</h2><div className="suggestions">{[{ label: "生成口播视频", text: "我想新生成一段女声普通话口播视频", icon: "story" as const }, { label: "查看我的赛事", text: "列出我当前账号的赛事", icon: "pin" as const }, { label: "了解道引产品", text: "道引科技有哪些产品？", icon: "book" as const }].map(({ label, text, icon }) => <button key={text} onClick={() => { setDraft(text); document.getElementById("message")?.focus(); }}><WorkbenchIcon name={icon} />{label}<WorkbenchIcon name="chevron" /></button>)}</div></section>}
          {turns.map((turn) => <article className="turn" key={turn.run.id} aria-label="一轮对话">
            <div className="user-message"><div className="message-meta"><span className="message-label">你</span><MessageTime value={turn.run.createdAt} /></div><p>{visibleUserMessage(turn.run.userMessage)}</p></div>
            <div className="assistant-message"><div className="assistant-label"><span className="mini-mark" aria-hidden="true"><HarnessLogo /></span><span>Harness</span><span className="run-status">{statusText[turn.run.status]}</span><MessageTime value={turn.assistantOccurredAt} /></div>
              {turn.tools.length > 0 && <ToolActivity tools={turn.tools} />}
              <div className="markdown">{turn.text && <MarkdownMessage text={turn.text} />}</div>
              <StoryVideos key={`${client.accountScope}:${turn.run.id}`} events={events} runId={turn.run.id} client={client} />
              {turn.images.length > 0 && <ImageGallery key={`${client.accountScope}:${turn.run.id}`} images={turn.images} accountScope={client.accountScope} />}
              {(turn.run.status === "running" || turn.run.status === "queued") && !turn.tools.some((tool) => tool.status === "running") && <p className="thinking" role="status"><span className="spinner" />{turn.run.status === "queued" ? "正在等待处理…" : turn.text ? "正在回复…" : "正在处理你的问题…"}</p>}
              {turn.sources.length > 0 && <details className="sources"><summary>参考资料 <span>{turn.sources.length}</span></summary>{turn.sources.map((source) => <details className="source" key={source.id}><summary>{source.title || "公开资料"}{source.location && <small>{source.location}</small>}</summary><p>{source.content}</p></details>)}</details>}
              {turn.run.cancelRequested && turn.run.status === "running" && <p role="status" className="muted">正在停止，已完成的记录会保留。</p>}
            </div>
          </article>)}
          {sendingMessage && <article className="turn" aria-label="正在发送的问题"><div className="user-message"><span className="message-label">你</span><p>{sendingMessage}</p></div><p className="thinking" role="status"><span className="spinner" />正在发送…</p></article>}
          <div ref={bottom} />
        </div>
      </div>
      <div className="composer-area" hidden={view !== "chat"}>
        {error && <div className="error-message" role="alert">{error}</div>}
        {loginUrl && phase !== "ready" && phase !== "connecting" && <button type="button" className="primary reconnect" onClick={() => window.location.assign(loginUrl)}>登录道引账号</button>}
        {!loginUrl && phase !== "connecting" && (phase !== "ready" || error) && <button className="primary reconnect" onClick={() => { void connect(); }}>重新连接工作台</button>}
        {pending && phase === "ready" && !submitting && <div className="recovery"><span>上次提交结果尚未确认。</span><button disabled={loading || !!active} onClick={() => { void send(pending.message); }}>恢复原提交</button></div>}
        {session?.archivedAt && <div className="archived-notice" role="status"><span>会话已归档，恢复后可继续发送。</span><button type="button" disabled={!!managing || phase !== "ready"} onClick={() => { void manageSession(session.id, "restore").catch(() => undefined); }}>恢复会话</button></div>}
        <form className="composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
          <label htmlFor="message" className="sr-only">发送给 Harness 的问题</label>
          <textarea id="message" value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={10000} rows={2} disabled={phase !== "ready" || submitting || !!pending || !!managing || !!session?.archivedAt} placeholder="描述你的问题…" onKeyDown={(event) => { if (isSendShortcut({ key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, isComposing: event.nativeEvent.isComposing }, preferences)) { event.preventDefault(); void send(); } }} />
          {references.length > 0 && <div className="composer-attachments" aria-label="待发送参考素材">{references.map(reference => <span key={reference.id}><WorkbenchIcon name={reference.mimeType === "video/mp4" ? "story" : "image"} /><b>{reference.name}</b><small>{formatFileSize(reference.size)}</small><button type="button" aria-label={`移除附件：${reference.name}`} onClick={() => setReferences(items => items.filter(item => item.id !== reference.id))}>×</button></span>)}</div>}
          <div className="composer-controls"><div className="composer-plugins"><StoryUpload key={client.accountScope} client={client} disabled={pluginBusy || !!managing || !!session?.archivedAt} onBusy={setUploading} onUploaded={reference => { if (selectedRef.current === selected) setReferences(items => items.some(item => item.id === reference.id) ? items : [...items, reference].slice(0, 5)); }} /><button type="button" className="selected-plugin" onClick={browsePlugins} aria-label="查看已启用插件">全部插件<span className="plugin-check" aria-hidden="true">✓</span></button>{active && <span className="composer-busy">进行中</span>}</div>{submitting || active ? <button type="button" className="stop-button" aria-label={cancelling || active?.cancelRequested ? "正在停止生成" : "停止生成"} title={cancelling || active?.cancelRequested ? "正在停止生成" : "停止生成"} disabled={cancelling || active?.cancelRequested} onClick={() => { void cancel(); }}><WorkbenchIcon name="stop" /></button> : <button type="submit" className="primary send-button" aria-label="发送" title="发送" disabled={uploading || !draft.trim() || phase !== "ready" || loading || !!pending || !!managing || !!session?.archivedAt}><WorkbenchIcon name="arrow" /></button>}</div>
        </form>
        <p className="composer-note">已接入插件自动可用；付费生成使用当前账号额度</p>
        <div className="sr-only" role="status">{submitting ? "正在提交问题" : active ? "任务进行中" : turns.length ? "回答已更新" : ""}</div>
      </div>
    </main>
    {settingsOpen && <SettingsDialog preferences={preferences} onChange={savePreferences} onClose={closeSettings} saveError={preferenceError} />}
  </div>;
}
