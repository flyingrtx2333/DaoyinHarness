import { useEffect, useRef, useState } from "react";
import type { AgentEvent } from "@daoyin/harness-protocol";
import { MarkdownMessage } from "../MarkdownMessage.js";
import { WorkbenchClient, WorkbenchError, type AccountProfile, type CloudRun, type CloudSession } from "./client.js";
import { projectTurns } from "./projection.js";
import { PluginCatalog, PluginPicker } from "./PluginBrowser.js";
import { selectablePlugin, sessionPlugin } from "./plugins.js";
import { HarnessLogo } from "./HarnessLogo.js";
import { WorkbenchIcon } from "./WorkbenchIcon.js";
import { AccountIdentity } from "./AccountIdentity.js";
import { scheduleExpiry } from "./expiry.js";
import { SettingsDialog } from "./SettingsDialog.js";
import { ToolActivity } from "./ToolActivity.js";
import { DEFAULT_PREFERENCES, PREFERENCES_KEY, isSendShortcut, readPreferences, type WorkbenchPreferences } from "./preferences.js";

const APPLICATION = new URLSearchParams(window.location.search).get("app") === "saishi" ? "saishi" : "company";
const SELECTED = "daoyin-harness-cloud-selected-v1" + (APPLICATION === "saishi" ? ":saishi" : "");
const ACCOUNT_LOGIN_PATH = "/login?redirect=%2Fharness%2F%3Fapp%3Dsaishi";
const ACCOUNT_REGISTER_PATH = "/login?mode=register&redirect=%2Fharness%2F%3Fapp%3Dsaishi";
const storage = {
  getItem: (key: string): string | null => window.sessionStorage.getItem(key),
  setItem: (key: string, value: string): void => window.sessionStorage.setItem(key, value),
  removeItem: (key: string): void => window.sessionStorage.removeItem(key),
};
const statusText = { queued: "等待中", running: "进行中", completed: "已完成", failed: "未完成", cancelled: "已停止", interrupted: "已中断" };

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
  const [runs, setRuns] = useState<CloudRun[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [loginUrl, setLoginUrl] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [sendingMessage, setSendingMessage] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [revision, setRevision] = useState(0);
  const [sidebar, setSidebar] = useState(false);
  const [view, setView] = useState<"chat" | "plugins">("chat");
  const [chosenPlugin, setChosenPlugin] = useState(APPLICATION === "saishi" ? "saishi" : "company-knowledge");
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
  const authorizedProfiles = APPLICATION === "saishi" && phase === "ready" ? ["saishi-readonly"] : [];
  const plugin = selected ? session && sessionPlugin(session.profileId) : selectablePlugin(chosenPlugin, authorizedProfiles);
  const pluginBusy = submitting || loading || !!active || !!pending;

  function fail(cause: unknown): void {
    setError(cause instanceof WorkbenchError ? cause.message : "连接未完成，请重试。");
    setLoginUrl(cause instanceof WorkbenchError ? cause.loginUrl : undefined);
    if (cause instanceof WorkbenchError && (cause.status === 401 || (APPLICATION === "saishi" && cause.status === 403))) {
      accountEpoch.current++;
      setAccount(undefined); setSettingsOpen(false); setSendingMessage("");
      setPhase("expired"); setRuns([]); setEvents([]); setSessions([]); setSelected(""); setDraft("");
    }
  }
  async function connect(background = false): Promise<void> {
    if (connecting.current || loggingOut.current) return;
    const quiet = background && phaseRef.current === "ready";
    const previousScope = client.accountScope;
    const savedDraft = currentDraft.current;
    connecting.current = true;
    if (!quiet) { setPhase("connecting"); setError(""); setLoginUrl(undefined); }
    function resetAccount(): void { accountEpoch.current++; setAccount(undefined); setSettingsOpen(false); setSendingMessage(""); setRuns([]); setEvents([]); setSessions([]); setSelected(""); setDraft(""); }
    if (APPLICATION === "saishi" && !quiet) resetAccount();
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
      if (APPLICATION === "saishi" && previousScope && previousScope === client.accountScope) setDraft(savedDraft);
      setSelected(list.some((item) => item.id === saved) ? saved : list[0]?.id ?? "");
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
    if (APPLICATION !== "saishi") return;
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
      if (APPLICATION === "saishi") { void connect(); return; }
      setPhase("expired"); setRuns([]); setEvents([]); setSessions([]);
      setSelected(""); setDraft("");
      setError("访客授权已到期。重新进入将创建新的访客空间，旧空间的会话不会转入。");
    });
  }, [phase, expiresAt]);
  useEffect(() => {
    const key = phase === "ready" && selected ? `${accountEpoch.current}:${selected}` : "";
    const changed = feed.current.key !== key;
    if (changed) { feed.current = { key, events: [] }; setRuns([]); setEvents([]); nearBottom.current = true; }
    if (!key) { setLoading(false); return; }
    const controller = new AbortController();
    let timer: number | undefined;
    let accumulated = feed.current.events;
    let recoveryError = "";
    if (changed) setLoading(true);
    try { storage.setItem(SELECTED, selected); } catch { /* No model work occurs here. */ }
    async function refresh(): Promise<void> {
      try {
        const [nextRuns, additions] = await Promise.all([
          client.runs(selected, controller.signal),
          client.events(selected, accumulated.at(-1)?.eventSeq ?? 0, controller.signal),
        ]);
        if (controller.signal.aborted) return;
        accumulated = [...accumulated, ...additions];
        feed.current = { key, events: accumulated };
        setRuns(nextRuns); setEvents(accumulated); setLoading(false);
        if (recoveryError) { const recovered = recoveryError; setError(current => current === recovered ? "" : current); recoveryError = ""; }
        if (nextRuns.some((run) => run.status === "running" || run.status === "queued" || run.lastEventSeq > (accumulated.at(-1)?.eventSeq ?? 0))) timer = window.setTimeout(() => { void refresh(); }, 500);
      } catch (cause) {
        if (!controller.signal.aborted) {
          recoveryError = cause instanceof WorkbenchError ? cause.message : "连接未完成，请重试。";
          setLoading(false); fail(cause);
          if (!(cause instanceof WorkbenchError && [401, 403].includes(cause.status ?? 0))) timer = window.setTimeout(() => { void refresh(); }, 2000);
        }
      }
    }
    void refresh();
    return () => { controller.abort(); window.clearTimeout(timer); };
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
      accountEpoch.current++; setAccount(undefined); setSettingsOpen(false); setSessions([]); setRuns([]); setEvents([]); setSelected(""); setDraft(""); setPhase("expired");
      window.location.replace("/harness/");
    } catch (cause) { loggingOut.current = false; throw cause; }
  }

  function choose(id: string): void {
    setSelected(id); setDraft(""); setError(""); setSidebar(false); setView("chat");
    if (!id) try { storage.removeItem(SELECTED); } catch { /* Optional selection history. */ }
  }
  function browsePlugins(): void {
    setView("plugins"); setSidebar(false);
    window.requestAnimationFrame(() => document.getElementById("conversation")?.focus());
  }
  function usePlugin(id: string, focusComposer = true): void {
    if (pluginBusy) return;
    const destination = id === "saishi" ? "saishi" : id === "company-knowledge" ? "company" : null;
    if (destination && destination !== APPLICATION) {
      const url = new URL(window.location.href);
      if (destination === "saishi") url.searchParams.set("app", "saishi"); else url.searchParams.delete("app");
      window.location.assign(url.toString());
      return;
    }
    if (destination === "saishi" && phase !== "ready") {
      setView("chat"); setSidebar(false);
      void connect();
      return;
    }
    const choice = selectablePlugin(id, authorizedProfiles);
    if (!choice) return;
    if (selected && session?.profileId !== choice.profileId) choose("");
    setChosenPlugin(id); setView("chat"); setSidebar(false); setError("");
    if (focusComposer) window.requestAnimationFrame(() => document.getElementById("message")?.focus());
  }
  async function send(message = draft.trim()): Promise<void> {
    if (!message || submission.current || active || phase !== "ready" || loading) return;
    if (!plugin?.profileId) { setError("当前会话的插件尚未支持，请新建会话并选择可用插件。"); return; }
    setSubmitting(true); setSendingMessage(message); setError(""); nearBottom.current = true;
    const epoch = accountEpoch.current;
    const operation = (async (): Promise<CloudRun> => {
      let id = selected;
      if (!id) {
        const created = await client.createSession(message, plugin.profileId);
        if (epoch !== accountEpoch.current) throw new WorkbenchError("账号连接已变化，原问题未继续提交。");
        id = created.id; setSessions((list) => [created, ...list]); setSelected(id);
      }
      return client.submit(id, message);
    })();
    submission.current = operation;
    try {
      const accepted = await operation;
      if (epoch === accountEpoch.current) {
        setRuns((current) => [accepted, ...current.filter((run) => run.id !== accepted.id)]);
        setDraft(""); nearBottom.current = true;
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

  const visibleSessions = sessions.filter((item) => item.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()));

  return <div className="workbench">
    <a className="skip-link" href="#conversation">跳到对话</a>
    <aside className={`sidebar ${sidebar ? "is-open" : ""}`} aria-label="会话导航" onKeyDown={(event) => { if (event.key === "Escape" && sidebar) { event.preventDefault(); closeSidebar(); } }}>
      <button type="button" className="sidebar-close" aria-label="关闭会话导航" onClick={closeSidebar}>×</button>
      <a className="brand" href="/harness/"><span className="brand-mark" aria-hidden="true"><HarnessLogo /></span><span>道引 Harness</span></a>
      <button className="new-session" disabled={phase !== "ready" || submitting} onClick={() => choose("")}><span aria-hidden="true">＋</span>新建会话</button>
      <nav className="workspace-tabs" aria-label="工作台导航"><button aria-current={view === "chat" ? "page" : undefined} onClick={() => { setView("chat"); setSidebar(false); }}><WorkbenchIcon name="chat" />会话</button><button aria-current={view === "plugins" ? "page" : undefined} onClick={browsePlugins}><WorkbenchIcon name="plugin" />插件</button></nav>
      <section className="sidebar-history" aria-labelledby="history-heading">
        <div className="sidebar-label"><h2 id="history-heading">最近会话</h2><span>{sessions.length}</span></div>
        <label className="search"><span>搜索会话</span><WorkbenchIcon name="search" /><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索会话" /></label>
        <nav aria-label="最近会话" className="session-list">
          {visibleSessions.map((item) =>
            <button key={item.id} aria-current={view === "chat" && selected === item.id ? "page" : undefined} disabled={submitting} onClick={() => choose(item.id)} title={item.title}><WorkbenchIcon name="chat" /><span>{item.title || "未命名会话"}</span></button>)}
          {visibleSessions.length === 0 && <p className="muted" role="status">{sessions.length === 0 ? "暂无会话" : "没有匹配的会话"}</p>}
        </nav>
      </section>
      {APPLICATION === "company" && <footer className="sidebar-footer"><div className="account-actions" aria-label="道引账号入口"><a className="account-login" href={ACCOUNT_LOGIN_PATH}>登录道引账号</a><a href={ACCOUNT_REGISTER_PATH}>注册账号</a></div></footer>}
      {APPLICATION === "saishi" && phase === "ready" && account && <footer className="sidebar-footer"><AccountIdentity key={client.accountScope} account={account} onSettings={() => setSettingsOpen(true)} onLogout={logout} /></footer>}
    </aside>
    <main id="conversation" className="main" tabIndex={-1}>
      <button className="mobile-menu-button" aria-label={sidebar ? "收起会话导航" : "展开会话导航"} aria-expanded={sidebar} onClick={() => setSidebar(!sidebar)}><WorkbenchIcon name="menu" /></button>
      {view === "plugins" && <div className="transcript plugin-transcript"><PluginCatalog selectedId={plugin?.id ?? ""} onSelect={(id) => usePlugin(id)} busy={pluginBusy} authorizedProfiles={authorizedProfiles} /></div>}
      <div className="transcript" hidden={view !== "chat"} onScroll={(event) => { const element = event.currentTarget; nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 160; }}>
        <div className="conversation-content">
          {phase === "connecting" && <p className="connection-message" role="status"><span className="spinner" /> 正在连接工作台…</p>}
          {phase === "ready" && loading && !sendingMessage && <p className="connection-message" role="status">正在恢复会话…</p>}
          {phase === "ready" && !loading && !sendingMessage && turns.length === 0 && <section className="empty-state"><span className="empty-mark" aria-hidden="true"><HarnessLogo /></span><h2>今天，想完成什么？</h2><div className="suggestions">{(APPLICATION === "saishi" ? [{ label: "查看我的赛事", text: "列出我当前账号的赛事", icon: "book" as const }, { label: "检查素材状态", text: "查询我的赛事素材处理状态", icon: "pin" as const }] : [{ label: "了解道引的产品", text: "道引科技有哪些产品？", icon: "book" as const }, { label: "查看文旅方案", text: "介绍一下互动文旅方案", icon: "pin" as const }]).map(({ label, text, icon }) => <button key={text} onClick={() => { setDraft(text); document.getElementById("message")?.focus(); }}><WorkbenchIcon name={icon} />{label}<WorkbenchIcon name="chevron" /></button>)}</div>{APPLICATION === "company" && <div className="visitor-account-prompt"><span>想查看你的赛事和专属数据？</span><div><a className="account-login" href={ACCOUNT_LOGIN_PATH}>登录道引账号</a><a href={ACCOUNT_REGISTER_PATH}>注册账号</a></div></div>}</section>}
          {turns.map((turn) => <article className="turn" key={turn.run.id} aria-label="一轮对话">
            <div className="user-message"><div className="message-meta"><span className="message-label">你</span><MessageTime value={turn.run.createdAt} /></div><p>{turn.run.userMessage}</p></div>
            <div className="assistant-message"><div className="assistant-label"><span className="mini-mark" aria-hidden="true"><HarnessLogo /></span><span>Harness</span><span className="run-status">{statusText[turn.run.status]}</span><MessageTime value={turn.assistantOccurredAt} /></div>
              {turn.tools.length > 0 && <ToolActivity tools={turn.tools} />}
              <div className="markdown">{turn.text && <MarkdownMessage text={turn.text} />}</div>
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
        {APPLICATION === "saishi" && loginUrl && phase !== "ready" && phase !== "connecting" && <button type="button" className="primary reconnect" onClick={() => window.location.assign(loginUrl)}>登录道引账号</button>}
        {APPLICATION === "company" && phase !== "ready" && phase !== "connecting" && <button className="primary reconnect" onClick={() => { void connect(); }}>重新进入工作台</button>}
        {APPLICATION === "saishi" && !loginUrl && phase !== "connecting" && (phase !== "ready" || error) && <button className="primary reconnect" onClick={() => { void connect(); }}>重新连接工作台</button>}
        {pending && phase === "ready" && !submitting && <div className="recovery"><span>上次提交结果尚未确认。</span><button disabled={loading || !!active} onClick={() => { void send(pending.message); }}>恢复原提交</button></div>}
        <form className="composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
          <label htmlFor="message" className="sr-only">发送给 Harness 的问题</label>
          <textarea id="message" value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={10000} rows={2} disabled={phase !== "ready" || submitting || !!pending} placeholder="描述你的问题…" onKeyDown={(event) => { if (isSendShortcut({ key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, isComposing: event.nativeEvent.isComposing }, preferences)) { event.preventDefault(); void send(); } }} />
          <div className="composer-controls"><div className="composer-plugins"><PluginPicker selectedId={plugin?.id ?? ""} onSelect={(id) => usePlugin(id, false)} onBrowse={browsePlugins} busy={pluginBusy} authorizedProfiles={authorizedProfiles} /><button type="button" className="selected-plugin" onClick={browsePlugins} aria-label={`查看${plugin?.name ?? "会话插件"}详情`}>{plugin?.name ?? "选择插件"}{plugin && <span className="plugin-check" aria-hidden="true">✓</span>}</button>{active && <span className="composer-busy">进行中</span>}</div>{submitting || active ? <button type="button" className="stop-button" disabled={cancelling || active?.cancelRequested} onClick={() => { void cancel(); }}>{cancelling || active?.cancelRequested ? "正在停止…" : "停止生成"}</button> : <button type="submit" className="primary send-button" aria-label="发送" disabled={!draft.trim() || phase !== "ready" || loading || !!pending || !plugin}><WorkbenchIcon name="arrow" /></button>}</div>
        </form>
        <p className="composer-note">{APPLICATION === "saishi" ? "使用当前账号的赛事数据；摄像机观察不等于正式打卡成绩" : "依据公开资料回答，请核对引用"}</p>
        <div className="sr-only" role="status">{submitting ? "正在提交问题" : active ? "任务进行中" : turns.length ? "回答已更新" : ""}</div>
      </div>
    </main>
    {settingsOpen && <SettingsDialog preferences={preferences} onChange={savePreferences} onClose={closeSettings} saveError={preferenceError} />}
  </div>;
}
