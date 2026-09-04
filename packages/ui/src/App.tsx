import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { AgentEvent, LocalSessionSummary, RuntimeBootstrap } from "@daoyin/harness-protocol";
import {
  bootstrapRuntime,
  cancelTurn,
  createSession,
  decideProcessPermission,
  getProcessPermissions,
  getSessionEvents,
  getWorkspaceFiles,
  startTurn,
} from "./api.js";

type IconName = "chat" | "close" | "file" | "folder" | "menu" | "plus" | "send" | "spark" | "stop";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; bootstrap: RuntimeBootstrap }
  | { kind: "error"; message: string };

interface ProcessPermissionView {
  requestId: string;
  displayCommand: string;
  risk: string;
  reason: string;
  status: "pending" | "approved" | "denied" | "consumed";
}

interface ToolView {
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
  text: string;
  permission?: ProcessPermissionView;
}

interface TurnView {
  turnId: string;
  userMessage: string;
  assistantText: string;
  status: "running" | "completed" | "failed" | "cancelled";
  tools: ToolView[];
}

function Icon({ name }: { name: IconName }): React.JSX.Element {
  const paths: Record<IconName, React.JSX.Element> = {
    chat: <path d="M5 6.5h14v9H10l-5 3.5V6.5Z" />,
    close: <path d="m7 7 10 10M17 7 7 17" />,
    file: <><path d="M7 3.5h7l4 4v13H7z" /><path d="M14 3.5v4h4" /></>,
    folder: <path d="M3.5 7.5h6l1.8 2H20.5v9.5H3.5z" />,
    menu: <path d="M5 7h14M5 12h14M5 17h14" />,
    plus: <path d="M12 5v14M5 12h14" />,
    send: <path d="M12 19V5m0 0-5 5m5-5 5 5" />,
    spark: <path d="m12 3 1.4 5.6L19 10l-5.6 1.4L12 17l-1.4-5.6L5 10l5.6-1.4L12 3Z" />,
    stop: <rect x="7" y="7" width="10" height="10" rx="2" />,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24">{paths[name]}</svg>;
}

function publicError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "";
  return error instanceof Error ? error.message : "本地运行时发生未知错误。";
}

function timeLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function upsertSession(list: LocalSessionSummary[], next: LocalSessionSummary): LocalSessionSummary[] {
  return [next, ...list.filter((session) => session.id !== next.id)]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function capabilityCategoryLabel(category: string): string {
  const labels: Record<string, string> = {
    workspace: "本地文件",
    web: "网页检索",
    process: "受控执行",
    system: "系统能力",
    extension: "扩展能力",
  };
  return labels[category] ?? category;
}

function processPermissionView(details: unknown): ProcessPermissionView | undefined {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
  const candidate = details as Record<string, unknown>;
  const requestId = candidate.permissionRequestId;
  const displayCommand = candidate.displayCommand;
  const risk = candidate.risk;
  const reason = candidate.reason;
  const status = candidate.status;
  if (typeof requestId !== "string" || typeof displayCommand !== "string" || typeof risk !== "string" || typeof reason !== "string") return undefined;
  if (status !== "pending" && status !== "approved" && status !== "denied" && status !== "consumed") return undefined;
  return { requestId, displayCommand, risk, reason, status };
}

function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    list_files: "查看工作区文件",
    read_file: "读取文件",
    search_text: "搜索本地内容",
    write_file: "写入文件",
    apply_patch: "修改文件",
    process_inspect: "检查本地运行环境",
    run_package_script: "运行工作区脚本",
    web_search: "搜索网页",
    web_fetch: "读取网页",
    list_skills: "查看可用技能",
    load_skill: "加载技能",
    memory_search: "检索记忆",
    memory_remember: "保存记忆",
    memory_update: "更新记忆",
    memory_forget: "忘记记忆",
  };
  return labels[name] ?? name;
}

function buildTurns(events: AgentEvent[]): TurnView[] {
  const turns = new Map<string, TurnView>();
  const toolIndexes = new Map<string, Map<string, number>>();
  for (const event of events) {
    if (event.type === "turn.started") {
      turns.set(event.turnId, {
        turnId: event.turnId,
        userMessage: event.payload.userMessage,
        assistantText: "",
        status: "running",
        tools: [],
      });
      toolIndexes.set(event.turnId, new Map());
      continue;
    }
    const turn = turns.get(event.turnId);
    if (turn === undefined) continue;
    if (event.type === "assistant.delta") {
      turn.assistantText += event.payload.delta;
    } else if (event.type === "tool.started") {
      const index = turn.tools.length;
      toolIndexes.get(event.turnId)?.set(event.payload.toolCallId, index);
      turn.tools.push({
        id: event.payload.toolCallId,
        name: event.payload.toolName,
        status: "running",
        text: event.payload.displayText,
      });
    } else if (event.type === "tool.completed") {
      const index = toolIndexes.get(event.turnId)?.get(event.payload.toolCallId);
      const tool = index === undefined ? undefined : turn.tools[index];
      if (tool !== undefined) {
        tool.status = "completed";
        tool.text = event.payload.summary;
      }
    } else if (event.type === "tool.failed") {
      const index = toolIndexes.get(event.turnId)?.get(event.payload.toolCallId);
      const tool = index === undefined ? undefined : turn.tools[index];
      if (tool !== undefined) {
        tool.status = "failed";
        tool.text = event.payload.message;
        const permission = processPermissionView(event.payload.details);
        if (permission !== undefined) tool.permission = permission;
      }
    } else if (event.type === "turn.completed") {
      turn.status = "completed";
    } else if (event.type === "turn.failed") {
      turn.status = "failed";
    } else if (event.type === "turn.cancelled") {
      turn.status = "cancelled";
    }
  }
  return [...turns.values()];
}

export function App(): React.JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [sessions, setSessions] = useState<LocalSessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [prompt, setPrompt] = useState("");
  const [notice, setNotice] = useState("");
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [planningEnabled, setPlanningEnabled] = useState(false);
  const [sending, setSending] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [files, setFiles] = useState<string[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [permissionBusy, setPermissionBusy] = useState<string | null>(null);
  const [permissionOverrides, setPermissionOverrides] = useState<Record<string, ProcessPermissionView["status"]>>({});
  const lastEventSeq = useRef(0);
  const transcriptEnd = useRef<HTMLDivElement | null>(null);

  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? null;
  const turns = useMemo(() => buildTurns(events), [events]);
  const connected = state.kind === "ready";
  const workspace = state.kind === "ready" ? state.bootstrap.workspace : null;
  const sandbox = state.kind === "ready" ? state.bootstrap.sandbox : null;
  const sandboxLabel = sandbox === null
    ? "沙箱未探测"
    : sandbox.available
      ? `沙箱 ${sandbox.provider}`
      : sandbox.mode === "off" ? "沙箱已关闭" : "权限模式 · 无 OS 沙箱";
  const modelReady = state.kind === "ready" && state.bootstrap.health.capabilities.modelGateway === "ready";
  const capabilityCategories = state.kind === "ready"
    ? [...new Set(state.bootstrap.tools.map((tool) => tool.category))]
    : [];

  const loadSession = useCallback(async (sessionId: string, signal?: AbortSignal): Promise<void> => {
    const [payload, permissions] = await Promise.all([
      getSessionEvents(sessionId, 0, signal),
      getProcessPermissions(sessionId, signal),
    ]);
    lastEventSeq.current = payload.lastEventSeq;
    setEvents(payload.events);
    setSessions((current) => upsertSession(current, payload.session));
    setPermissionOverrides(Object.fromEntries(permissions.map((permission) => [permission.id, permission.status])));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void bootstrapRuntime(controller.signal)
      .then((bootstrap) => {
        setState({ kind: "ready", bootstrap });
        setSessions(bootstrap.sessions);
        const first = bootstrap.sessions[0];
        if (first !== undefined) {
          setSelectedSessionId(first.id);
          return loadSession(first.id, controller.signal);
        }
        return undefined;
      })
      .catch((error: unknown) => {
        const message = publicError(error);
        if (message.length > 0) setState({ kind: "error", message });
      });
    return () => controller.abort();
  }, [loadSession]);

  useEffect(() => {
    if (selectedSessionId === null) return undefined;
    let disposed = false;
    const poll = async (): Promise<void> => {
      try {
        const payload = await getSessionEvents(selectedSessionId, lastEventSeq.current);
        if (disposed) return;
        if (payload.events.length > 0) {
          lastEventSeq.current = payload.lastEventSeq;
          setEvents((current) => {
            const seen = new Set(current.map((event) => event.id));
            return [...current, ...payload.events.filter((event) => !seen.has(event.id))];
          });
          if (payload.events.some((event) => (event.type === "tool.failed" || event.type === "tool.completed") && event.payload.toolName === "run_package_script")) {
            const permissions = await getProcessPermissions(selectedSessionId);
            if (!disposed) setPermissionOverrides(Object.fromEntries(permissions.map((permission) => [permission.id, permission.status])));
          }
        }
        setSessions((current) => upsertSession(current, payload.session));
      } catch (error) {
        if (!disposed) setNotice(publicError(error));
      }
    };
    const timer = window.setInterval(() => void poll(), 800);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [selectedSessionId]);

  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [events.length]);

  async function selectSession(sessionId: string): Promise<void> {
    if (sessionId === selectedSessionId) return;
    setSelectedSessionId(sessionId);
    setEvents([]);
    setNotice("");
    setPermissionOverrides({});
    lastEventSeq.current = 0;
    setMobileNavigationOpen(false);
    try {
      await loadSession(sessionId);
    } catch (error) {
      setNotice(publicError(error));
    }
  }

  function startFreshConversation(): void {
    setSelectedSessionId(null);
    setEvents([]);
    setPrompt("");
    setNotice("");
    setPermissionOverrides({});
    lastEventSeq.current = 0;
    setMobileNavigationOpen(false);
  }

  async function submitPrompt(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const message = prompt.trim();
    if (message.length === 0 || sending) return;
    setSending(true);
    setNotice("");
    try {
      let sessionId = selectedSessionId;
      if (sessionId === null) {
        const created = await createSession(message.slice(0, 40));
        sessionId = created.session.id;
        setSessions((current) => upsertSession(current, created.session));
        setSelectedSessionId(sessionId);
        setEvents([]);
        setPermissionOverrides({});
        lastEventSeq.current = 0;
      }
      await startTurn(sessionId, message, planningEnabled);
      setPrompt("");
      const payload = await getSessionEvents(sessionId, lastEventSeq.current);
      lastEventSeq.current = payload.lastEventSeq;
      setEvents((current) => [...current, ...payload.events]);
      setSessions((current) => upsertSession(current, payload.session));
    } catch (error) {
      setNotice(publicError(error));
    } finally {
      setSending(false);
    }
  }

  async function stopCurrentTurn(): Promise<void> {
    if (selectedSession?.activeTurnId === null || selectedSession?.activeTurnId === undefined) return;
    try {
      await cancelTurn(selectedSession.id, selectedSession.activeTurnId);
      setNotice("正在停止当前任务……");
    } catch (error) {
      setNotice(publicError(error));
    }
  }

  async function openFiles(): Promise<void> {
    setFilesOpen(true);
    if (files.length > 0 || filesLoading) return;
    setFilesLoading(true);
    try {
      const payload = await getWorkspaceFiles();
      setFiles(payload.files);
    } catch (error) {
      setNotice(publicError(error));
    } finally {
      setFilesLoading(false);
    }
  }

  async function decidePermission(permission: ProcessPermissionView, approve: boolean): Promise<void> {
    if (permissionBusy !== null) return;
    setPermissionBusy(permission.requestId);
    setNotice("");
    try {
      const decision = await decideProcessPermission(permission.requestId, approve);
      setPermissionOverrides((current) => ({ ...current, [permission.requestId]: decision.status }));
      setNotice(approve ? `已允许一次：${permission.displayCommand}。发送“继续”后 Agent 才会实际执行。` : `已拒绝：${permission.displayCommand}。`);
    } catch (error) {
      setNotice(publicError(error));
    } finally {
      setPermissionBusy(null);
    }
  }

  return (
    <div className="studio-shell">
      <header className="top-bar">
        <div className="top-bar-left">
          <button className="mobile-menu" type="button" aria-label="打开会话导航" onClick={() => setMobileNavigationOpen(true)}>
            <Icon name="menu" />
          </button>
          <button className="app-logo" type="button" aria-label="新建对话" onClick={startFreshConversation}><span>道</span></button>
          <button className="top-icon" type="button" aria-label="查看工作区文件" onClick={() => void openFiles()}><Icon name="file" /></button>
        </div>
        <div className="top-bar-title">
          <img src="/assistant-daoyin.png" alt="" />
          <div><strong>{selectedSession?.title ?? "DaoyinHarness"}</strong><small>{workspace?.name ?? "本地工作台"}</small></div>
        </div>
        <div className="top-bar-right">
          <span className={`connection-pill ${connected ? "online" : ""}`}><i />{connected ? "本地已连接" : "未连接"}</span>
        </div>
      </header>

      <div className="main-layout">
        {mobileNavigationOpen ? <button className="nav-backdrop" type="button" aria-label="关闭会话导航" onClick={() => setMobileNavigationOpen(false)} /> : null}
        <aside className={`studio-sidebar ${mobileNavigationOpen ? "mobile-open" : ""}`} aria-label="会话导航">
          <div className="mobile-sidebar-heading">
            <strong>工作台</strong>
            <button type="button" aria-label="关闭会话导航" onClick={() => setMobileNavigationOpen(false)}><Icon name="close" /></button>
          </div>
          <nav className="sidebar-primary" aria-label="工作台功能">
            <button className={`sidebar-nav-item ${selectedSessionId === null ? "active" : ""}`} type="button" onClick={startFreshConversation}>
              <Icon name="plus" /><span>新对话</span>
            </button>
            <button className="sidebar-nav-item" type="button" onClick={() => void openFiles()}>
              <Icon name="folder" /><span>工作区</span><small>{workspace?.fileCount ?? 0}</small>
            </button>
          </nav>
          <div className="sidebar-divider" />
          <section className="sidebar-section sessions" aria-labelledby="sessions-heading">
            <div className="sidebar-section-heading">
              <h2 id="sessions-heading">最近对话</h2>
              <button type="button" aria-label="新建对话" onClick={startFreshConversation}><Icon name="plus" /></button>
            </div>
            {sessions.length === 0 ? (
              <div className="empty-sessions"><Icon name="chat" /><span>还没有本地对话</span></div>
            ) : (
              <div className="session-list">
                {sessions.map((session) => (
                  <button
                    className={`session-row ${session.id === selectedSessionId ? "active" : ""}`}
                    key={session.id}
                    type="button"
                    onClick={() => void selectSession(session.id)}
                  >
                    <span><b>{session.title}</b><small>{timeLabel(session.updatedAt)}</small></span>
                    {session.activeTurnId !== null ? <i className="busy-dot" aria-label="执行中" /> : null}
                  </button>
                ))}
              </div>
            )}
          </section>
          <footer className="sidebar-footer">
            <div className="sidebar-status">
              <span className="runtime-mark"><i className={connected ? "online" : ""} /></span>
              <span><b>{workspace?.name ?? "工作区未初始化"}</b><small>{workspace?.root ?? "127.0.0.1 · 仅本机"}</small></span>
            </div>
          </footer>
        </aside>

        <main className="chat-area" aria-label="Agent 对话">
          {state.kind === "loading" ? (
            <section className="welcome"><img src="/assistant-daoyin.png" alt="" /><h1>正在连接本地运行时</h1><p>读取工作区与会话记录……</p></section>
          ) : state.kind === "error" ? (
            <section className="welcome error-state"><img src="/assistant-daoyin.png" alt="" /><h1>本地运行时未连接</h1><p>{state.message}</p></section>
          ) : turns.length === 0 ? (
            <section className="welcome">
              <img src="/assistant-daoyin.png" alt="" />
              <h1>一个能持续工作的通用 Agent</h1>
              <p>{modelReady ? "聊天、研究网页、整理资料、处理本地文件或完成工程任务，都从同一段会话继续。" : "会话、工作区和工具运行时已经接通；真实模型网关登录仍在下一步接入。"}</p>
              <div className="capability-strip">
                {capabilityCategories.map((category) => <span className="capability-chip" key={category}>{capabilityCategoryLabel(category)}</span>)}
                <span className={`capability-chip sandbox-chip ${sandbox?.available ? "ready" : "fallback"}`}>{sandboxLabel}</span>
              </div>
              <div className="workspace-chip"><Icon name="folder" /><span>{workspace?.root ?? "未选择工作区"}</span></div>
            </section>
          ) : (
            <section className="transcript" aria-live="polite">
              <div className="transcript-inner">
                {turns.map((turn) => (
                  <article className="turn" key={turn.turnId}>
                    <div className="user-message"><div>{turn.userMessage}</div></div>
                    <div className="assistant-message">
                      <div className="assistant-avatar"><img src="/assistant-daoyin.png" alt="" /></div>
                      <div className="assistant-body">
                        {turn.tools.length > 0 ? (
                          <div className="tool-stack">
                            {turn.tools.map((tool) => {
                              const permission = tool.permission;
                              const permissionStatus = permission === undefined ? undefined : permissionOverrides[permission.requestId] ?? permission.status;
                              return (
                                <div className={`tool-line ${tool.status} ${permission !== undefined ? "permission-tool" : ""}`} key={tool.id}>
                                  <i />
                                  <span>
                                    <b>{toolLabel(tool.name)}</b>
                                    <small>{tool.text}</small>
                                    {permission !== undefined ? (
                                      <div className="permission-box">
                                        <code>{permission.displayCommand}</code>
                                        <p>{permission.reason}</p>
                                        {permissionStatus === "pending" ? (
                                          <div className="permission-actions">
                                            <button type="button" disabled={permissionBusy !== null} onClick={() => void decidePermission(permission, true)}>允许一次</button>
                                            <button type="button" disabled={permissionBusy !== null} onClick={() => void decidePermission(permission, false)}>拒绝</button>
                                          </div>
                                        ) : permissionStatus === "denied" ? (
                                          <div className="permission-actions">
                                            <em>已拒绝</em>
                                            <button type="button" disabled={permissionBusy !== null} onClick={() => void decidePermission(permission, true)}>改为允许一次</button>
                                          </div>
                                        ) : <em>{permissionStatus === "approved" ? "已允许一次 · 发送“继续”后执行" : "授权已消费"}</em>}
                                      </div>
                                    ) : null}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        ) : null}
                        {turn.assistantText.length > 0 ? <div className={`assistant-text ${turn.status === "failed" ? "failed" : ""}`}>{turn.assistantText}</div> : null}
                        {turn.status === "running" && turn.assistantText.length === 0 ? <div className="thinking-line"><span /><span /><span /></div> : null}
                        {turn.status === "cancelled" ? <div className="turn-state">已停止</div> : null}
                      </div>
                    </div>
                  </article>
                ))}
                <div ref={transcriptEnd} />
              </div>
            </section>
          )}

          <div className="composer-region">
            {notice ? <div className="scope-notice" role="status">{notice}</div> : null}
            <form className="composer" aria-label="发送任务" onSubmit={(event) => void submitPrompt(event)}>
              <textarea
                value={prompt}
                onChange={(event) => { setPrompt(event.target.value); setNotice(""); }}
                aria-label="任务描述"
                placeholder="告诉我你想完成什么……"
                maxLength={20_000}
                disabled={!connected}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <div className="composer-actions">
                <div>
                  <button className="icon-button" type="button" aria-label="查看工作区文件" onClick={() => void openFiles()}><Icon name="plus" /></button>
                  <span>{selectedSession?.activeTurnId !== null && selectedSession !== null ? "Agent 正在工作" : `${String(prompt.length)} / 20000`}</span>
                </div>
                <div>
                  <button className={`planning-toggle ${planningEnabled ? "active" : ""}`} type="button" aria-pressed={planningEnabled} onClick={() => setPlanningEnabled((value) => !value)}>
                    <Icon name="spark" />仔细规划
                  </button>
                  {selectedSession?.activeTurnId !== null && selectedSession !== null ? (
                    <button className="stop-button" type="button" aria-label="停止当前任务" onClick={() => void stopCurrentTurn()}><Icon name="stop" /></button>
                  ) : (
                    <button className="send-button" type="submit" disabled={prompt.trim().length === 0 || sending || !connected} aria-label="发送任务"><Icon name="send" /></button>
                  )}
                </div>
              </div>
            </form>
          </div>
        </main>

        {filesOpen ? (
          <aside className="file-panel" aria-label="工作区文件">
            <div className="file-panel-heading"><div><strong>工作区文件</strong><small>{workspace?.name ?? "工作区"}</small></div><button type="button" aria-label="关闭工作区文件" onClick={() => setFilesOpen(false)}><Icon name="close" /></button></div>
            <div className="file-panel-root">{workspace?.root}</div>
            <div className="file-list">
              {filesLoading ? <p>正在读取文件……</p> : files.map((file) => <div className="file-row" key={file}><Icon name="file" /><span>{file}</span></div>)}
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
