import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { MarkdownMessage } from "./MarkdownMessage.js";
import { WorkspaceManager } from "./WorkspaceManager.js";
import { readSidebarPreference, useMediaQuery } from "./use-media-query.js";
import type { AgentEvent, LocalSessionSummary, OrchestrationSnapshot, RuntimeBootstrap, SessionEventStreamMessage, SessionSearchHit } from "@daoyin/harness-protocol";
import {
  bootstrapRuntime,
  invalidateRuntimeContext,
  RUNTIME_CONTEXT_CHANGED_EVENT,
  beginAuthentication,
  cancelTurn,
  createSession,
  decideProcessPermission,
  forkSession,
  getOrchestrationSnapshot,
  getProcessPermissions,
  getSessionEvents,
  getWorkspaceFiles,
  openSessionEventStream,
  logoutAuthentication,
  resumeSession,
  searchSessions,
  startTurn,
} from "./api.js";

type IconName = "chat" | "close" | "file" | "folder" | "fork" | "menu" | "plus" | "resume" | "search" | "send" | "spark" | "stop" | "collapse" | "copy" | "check";

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
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  tools: ToolView[];
}

const ORCHESTRATION_TOOL_NAMES = new Set([
  "goal_create",
  "goal_update",
  "workflow_create",
  "workflow_run",
  "delegate_agent",
]);

function Icon({ name }: { name: IconName }): React.JSX.Element {
  const paths: Record<IconName, React.JSX.Element> = {
    chat: <path d="M5 6.5h14v9H10l-5 3.5V6.5Z" />,
    collapse: <path d="m14 7-5 5 5 5m5-10-5 5 5 5" />,
    copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M15 8V3H3v13h5" /></>,
    check: <path d="m5 12 4 4 10-10" />,
    close: <path d="m7 7 10 10M17 7 7 17" />,
    file: <><path d="M7 3.5h7l4 4v13H7z" /><path d="M14 3.5v4h4" /></>,
    folder: <path d="M3.5 7.5h6l1.8 2H20.5v9.5H3.5z" />,
    fork: <><path d="M8 5v5a3 3 0 0 0 3 3h5" /><path d="M16 8v10" /><circle cx="8" cy="5" r="2" /><circle cx="16" cy="6" r="2" /><circle cx="16" cy="18" r="2" /></>,
    menu: <path d="M5 7h14M5 12h14M5 17h14" />,
    plus: <path d="M12 5v14M5 12h14" />,
    resume: <><path d="M5 12a7 7 0 1 0 2-4.9" /><path d="M5 5v5h5" /></>,
    search: <><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></>,
    send: <><path d="m21 3-7 18-4-7-7-4L21 3Z" /><path d="m10 14 6-6" /></>,
    spark: <path d="m12 3 1.4 5.6L19 10l-5.6 1.4L12 17l-1.4-5.6L5 10l5.6-1.4L12 3Z" />,
    stop: <rect x="7" y="7" width="10" height="10" rx="2" />,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24">{paths[name]}</svg>;
}

function restoreFocus(target: HTMLElement | null): void {
  window.requestAnimationFrame(() => {
    if (target !== null && target !== document.body && target.isConnected && target.closest("[inert]") === null && target.getClientRects().length > 0) target.focus();
    else {
      const navigation = [...document.querySelectorAll<HTMLElement>(".mobile-menu, .history-toggle")].find((element) => element.getClientRects().length > 0 && element.closest("[inert]") === null);
      (navigation ?? document.querySelector<HTMLElement>("#agent-main"))?.focus();
    }
  });
}

function BrandMark(): React.JSX.Element {
  return <img className="brand-mark" src="/assets/harness-logo.png" width={32} height={32} alt="" aria-hidden="true" draggable={false} />;
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
    browser_open: "打开浏览器页面",
    browser_snapshot: "查看浏览器页面",
    browser_click: "点击网页元素",
    browser_type: "填写网页内容",
    browser_back: "浏览器后退",
    browser_close: "关闭浏览器会话",
    list_skills: "查看可用技能",
    load_skill: "加载技能",
    memory_search: "检索记忆",
    memory_remember: "保存记忆",
    memory_update: "更新记忆",
    memory_forget: "忘记记忆",
    goal_create: "创建任务目标",
    goal_list: "查看任务目标",
    goal_update: "更新任务进度",
    workflow_create: "创建工作流",
    workflow_list: "查看工作流",
    workflow_run: "运行工作流",
    delegate_agent: "委派子 Agent",
  };
  if (name.startsWith("mcp_")) return "MCP 扩展工具";
  return labels[name] ?? name;
}

function orchestrationStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    active: "进行中",
    blocked: "受阻",
    completed: "已完成",
    cancelled: "已取消",
    pending: "待处理",
    in_progress: "执行中",
    running: "执行中",
    failed: "失败",
  };
  return labels[status] ?? status;
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
      if (turn.assistantText.length === 0) turn.assistantText = event.payload.outcomeSummary;
    } else if (event.type === "turn.cancelled") {
      turn.status = "cancelled";
    } else if (event.type === "turn.interrupted") {
      turn.status = "interrupted";
    }
  }
  return [...turns.values()];
}

export function App(): React.JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [sessions, setSessions] = useState<LocalSessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionQuery, setSessionQuery] = useState("");
  const [sessionSearchHits, setSessionSearchHits] = useState<SessionSearchHit[]>([]);
  const [sessionSearching, setSessionSearching] = useState(false);
  const [sessionActionBusy, setSessionActionBusy] = useState<"fork" | "resume" | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [prompt, setPrompt] = useState("");
  const [notice, setNotice] = useState("");
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [planningEnabled, setPlanningEnabled] = useState(false);
  const [sending, setSending] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [workspaceManagerOpen, setWorkspaceManagerOpen] = useState(false);
  const [files, setFiles] = useState<string[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [orchestrationOpen, setOrchestrationOpen] = useState(false);
  const [orchestration, setOrchestration] = useState<OrchestrationSnapshot | null>(null);
  const [orchestrationLoading, setOrchestrationLoading] = useState(false);
  const [permissionBusy, setPermissionBusy] = useState<string | null>(null);
  const [authenticationBusy, setAuthenticationBusy] = useState(false);
  const [historyHidden, setHistoryHidden] = useState(readSidebarPreference);
  const mobileLayout = useMediaQuery("(max-width: 800px)");
  const mobileNavVisible = mobileLayout && mobileNavigationOpen;
  const sidebarVisible = mobileLayout ? mobileNavigationOpen : !historyHidden;
  const [accountOpen, setAccountOpen] = useState(false);
  const [copiedTurnId, setCopiedTurnId] = useState<string | null>(null);
  const overlayTrigger = useRef<HTMLElement | null>(null);
  const [permissionOverrides, setPermissionOverrides] = useState<Record<string, ProcessPermissionView["status"]>>({});
  const lastEventSeq = useRef(0);
  const transcriptEnd = useRef<HTMLDivElement | null>(null);
  const followTranscript = useRef(true);
  const selectedSessionRef = useRef<string | null>(null);

  useEffect(() => {
    const invalidate = (): void => {
      selectedSessionRef.current = null;
      lastEventSeq.current = 0;
      setSelectedSessionId(null); setEvents([]); setSessions([]); setFiles([]);
      setSessionSearchHits([]); setPermissionOverrides({}); setOrchestration(null);
      setFilesOpen(false); setOrchestrationOpen(false); setAccountOpen(false);
      setMobileNavigationOpen(false); setWorkspaceManagerOpen(false);
      setState({ kind: "error", message: "账号或工作区已改变，请刷新后继续。未发送的草稿仍保留在输入框中。" });
    };
    window.addEventListener(RUNTIME_CONTEXT_CHANGED_EVENT, invalidate);
    return () => window.removeEventListener(RUNTIME_CONTEXT_CHANGED_EVENT, invalidate);
  }, []);

  useEffect(() => {
    try { window.localStorage.setItem("daoyin.ui.sidebar-collapsed", String(historyHidden)); }
    catch { /* Layout still works when browser storage is unavailable. */ }
  }, [historyHidden]);

  function setSidebarCollapsed(collapsed: boolean): void {
    setAccountOpen(false);
    setHistoryHidden(collapsed);
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(collapsed ? ".history-toggle" : ".sidebar-collapse")?.focus();
    });
  }

  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? null;
  const forkSource = selectedSession?.forkedFrom === undefined
    ? null
    : sessions.find((session) => session.id === selectedSession.forkedFrom?.sourceSessionId) ?? null;
  const searchHitBySession = useMemo(() => new Map(sessionSearchHits.map((hit) => [hit.session.id, hit])), [sessionSearchHits]);
  const visibleSessions = sessionQuery.trim().length === 0 ? sessions : sessionSearchHits.map((hit) => hit.session);
  const turns = useMemo(() => buildTurns(events), [events]);
  const connected = state.kind === "ready";
  const workspace = state.kind === "ready" ? state.bootstrap.workspace : null;
  const modelReady = state.kind === "ready" && state.bootstrap.health.capabilities.modelGateway === "ready";
  const authentication = state.kind === "ready" ? state.bootstrap.authentication : { status: "signed_out" as const, account: null };

  useEffect(() => {
    if (copiedTurnId === null) return;
    const timer = window.setTimeout(() => setCopiedTurnId(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copiedTurnId]);

  async function copyAnswer(turn: TurnView): Promise<void> {
    try {
      await navigator.clipboard.writeText(turn.assistantText);
      setCopiedTurnId(turn.turnId);
    } catch {
      setNotice("未能复制，请选中回答后手动复制。");
    }
  }

  useEffect(() => {
    if (!filesOpen && !orchestrationOpen && !mobileNavVisible && !accountOpen) return;
    overlayTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = document.querySelector<HTMLElement>(accountOpen ? ".account-popover.is-open" : mobileNavVisible ? ".studio-sidebar.mobile-open" : ".file-panel.is-open");
    overlay?.querySelector<HTMLElement>("button, input")?.focus();
    const onEscape = (event: KeyboardEvent): void => {
      if (document.querySelector("dialog[open]") !== null) return;
      if (event.key === "Tab" && (mobileNavVisible || accountOpen) && overlay !== null) {
        const controls = [...overlay.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), a[href]")].filter((element) => element.getClientRects().length > 0);
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
      if (event.key !== "Escape") return;
      setFilesOpen(false);
      setOrchestrationOpen(false);
      setMobileNavigationOpen(false);
      setAccountOpen(false);
      restoreFocus(overlayTrigger.current);
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [filesOpen, orchestrationOpen, mobileNavVisible, accountOpen]);

  const loadSession = useCallback(async (sessionId: string, signal?: AbortSignal): Promise<void> => {
    const [payload, permissions] = await Promise.all([
      getSessionEvents(sessionId, 0, signal),
      getProcessPermissions(sessionId, signal),
    ]);
    if (signal?.aborted || selectedSessionRef.current !== sessionId) return;
    lastEventSeq.current = Math.max(lastEventSeq.current, payload.lastEventSeq);
    setEvents((current) => {
      const merged = new Map(payload.events.map((event) => [event.id, event]));
      for (const event of current) { if (event.sessionId === sessionId) merged.set(event.id, event); }
      return [...merged.values()].sort((left, right) => left.eventSeq - right.eventSeq);
    });
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
          selectedSessionRef.current = first.id;
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
    const query = sessionQuery.trim();
    if (query.length === 0) {
      setSessionSearchHits([]);
      setSessionSearching(false);
      return undefined;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSessionSearching(true);
      void searchSessions(query, 20, controller.signal)
        .then((payload) => setSessionSearchHits(payload.hits))
        .catch((error: unknown) => {
          const message = publicError(error);
          if (message.length > 0) setNotice(message);
        })
        .finally(() => setSessionSearching(false));
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [sessionQuery]);

  useEffect(() => {
    if (selectedSessionId === null) return undefined;
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let reconnectAttempt = 0;

    const refreshPermissions = (): void => {
      void getProcessPermissions(selectedSessionId)
        .then((permissions) => {
          if (!disposed) setPermissionOverrides(Object.fromEntries(permissions.map((permission) => [permission.id, permission.status])));
        })
        .catch((error: unknown) => {
          if (!disposed) setNotice(publicError(error));
        });
    };

    const handleMessage = (message: MessageEvent<unknown>): void => {
      if (disposed || selectedSessionRef.current !== selectedSessionId || typeof message.data !== "string") return;
      let payload: SessionEventStreamMessage;
      try {
        payload = JSON.parse(message.data) as SessionEventStreamMessage;
      } catch {
        return;
      }
      if (payload.type === "error") {
        setNotice(payload.message);
        return;
      }
      lastEventSeq.current = Math.max(lastEventSeq.current, payload.type === "event" ? payload.event.eventSeq : payload.lastEventSeq);
      setSessions((current) => upsertSession(current, payload.session));
      if (payload.type !== "event") return;
      setEvents((current) => {
        if (current.some((event) => event.id === payload.event.id)) return current;
        return [...current, payload.event].sort((left, right) => left.eventSeq - right.eventSeq);
      });
      if ((payload.event.type === "tool.failed" || payload.event.type === "tool.completed") && payload.event.payload.toolName === "run_package_script") {
        refreshPermissions();
      }
    };

    const connect = (): void => {
      if (disposed) return;
      socket = openSessionEventStream(selectedSessionId, lastEventSeq.current);
      socket.addEventListener("open", () => {
        reconnectAttempt = 0;
      });
      socket.addEventListener("message", handleMessage);
      socket.addEventListener("error", () => {
        socket?.close();
      });
      socket.addEventListener("close", (event) => {
        if (disposed) return;
        if (event.code === 1008) {
          disposed = true;
          invalidateRuntimeContext();
          return;
        }
        const delay = Math.min(5_000, 400 * 2 ** Math.min(reconnectAttempt, 4));
        reconnectAttempt += 1;
        reconnectTimer = window.setTimeout(connect, delay);
      });
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [selectedSessionId]);

  useEffect(() => { followTranscript.current = true; }, [selectedSessionId]);

  useEffect(() => {
    if (!followTranscript.current) return;
    const transcript = transcriptEnd.current?.closest<HTMLElement>(".transcript");
    // Do not launch overlapping smooth scrolls on every streamed event, or pull
    // the reader back down after they deliberately scroll up to earlier messages.
    transcript?.scrollTo({ top: transcript.scrollHeight, behavior: "instant" });
  }, [events.length]);

  useEffect(() => {
    if (!orchestrationOpen) return;
    const event = events.at(-1);
    if (event === undefined || (event.type !== "tool.completed" && event.type !== "tool.failed") || !ORCHESTRATION_TOOL_NAMES.has(event.payload.toolName)) return;
    void getOrchestrationSnapshot(selectedSessionId ?? undefined)
      .then(setOrchestration)
      .catch((error: unknown) => setNotice(publicError(error)));
  }, [events, orchestrationOpen, selectedSessionId]);

  async function selectSession(sessionId: string): Promise<void> {
    if (sessionId === selectedSessionId) return;
    selectedSessionRef.current = sessionId; setSelectedSessionId(sessionId);
    setEvents([]);
    setNotice("");
    setPermissionOverrides({});
    setOrchestrationOpen(false);
    setOrchestration(null);
    lastEventSeq.current = 0;
    setMobileNavigationOpen(false);
    try {
      await loadSession(sessionId);
    } catch (error) {
      setNotice(publicError(error));
    }
  }

  function startFreshConversation(): void {
    selectedSessionRef.current = null;
    setSelectedSessionId(null);
    setEvents([]);
    setPrompt("");
    setNotice("");
    setPermissionOverrides({});
    setOrchestrationOpen(false);
    setOrchestration(null);
    lastEventSeq.current = 0;
    setMobileNavigationOpen(false);
  }

  async function loginDaoyin(): Promise<void> {
    setAuthenticationBusy(true);
    setNotice("");
    try {
      const response = await beginAuthentication();
      window.location.assign(response.authorizationUrl);
    } catch (error) {
      setNotice(publicError(error));
      setAuthenticationBusy(false);
    }
  }

  async function logoutDaoyin(): Promise<void> {
    setAuthenticationBusy(true);
    setNotice("");
    try {
      await logoutAuthentication();
      window.location.reload();
    } catch (error) {
      setNotice(publicError(error));
      setAuthenticationBusy(false);
    }
  }

  async function submitPrompt(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const message = prompt.trim();
    if (message.length === 0 || sending || !modelReady || selectedSession?.activeTurnId) return;
    setSending(true);
    setNotice("");
    try {
      let sessionId = selectedSessionId;
      if (sessionId === null) {
        const created = await createSession(message.slice(0, 40));
        sessionId = created.session.id;
        setSessions((current) => upsertSession(current, created.session));
        selectedSessionRef.current = sessionId; setSelectedSessionId(sessionId);
        setEvents([]);
        setPermissionOverrides({});
        lastEventSeq.current = 0;
      }
      await startTurn(sessionId, message, planningEnabled);
      if (selectedSessionRef.current !== sessionId) return;
      setPrompt((current) => current.trim() === message ? "" : current);
      followTranscript.current = true;
      const payload = await getSessionEvents(sessionId, lastEventSeq.current);
      if (selectedSessionRef.current !== sessionId) return;
      lastEventSeq.current = Math.max(lastEventSeq.current, payload.lastEventSeq);
      setEvents((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...payload.events.filter((item) => !seen.has(item.id))]
          .sort((left, right) => left.eventSeq - right.eventSeq);
      });
      setSessions((current) => upsertSession(current, payload.session));
    } catch (error) {
      setNotice(publicError(error));
    } finally {
      setSending(false);
    }
  }

  async function forkCurrentSession(): Promise<void> {
    if (selectedSession === null || selectedSession.activeTurnId !== null || sessionActionBusy !== null) return;
    setSessionActionBusy("fork");
    setNotice("");
    try {
      const result = await forkSession(selectedSession.id);
      setSessions((current) => upsertSession(current, result.session));
      setSessionQuery("");
      setSessionSearchHits([]);
      await selectSession(result.session.id);
      setNotice(`已从“${result.sourceSession.title}”创建分支。`);
    } catch (error) {
      setNotice(publicError(error));
    } finally {
      setSessionActionBusy(null);
    }
  }

  async function resumeSelectedSession(): Promise<void> {
    if (selectedSession === null || selectedSession.activeTurnId === null || sessionActionBusy !== null) return;
    setSessionActionBusy("resume");
    setNotice("");
    try {
      const result = await resumeSession(selectedSession.id);
      setSessions((current) => upsertSession(current, result.session));
      await loadSession(result.session.id);
      setNotice(result.interruptedTurnId === null
        ? "会话已就绪。"
        : "会话已恢复，可以继续。");
    } catch (error) {
      setNotice(publicError(error));
    } finally {
      setSessionActionBusy(null);
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
    setMobileNavigationOpen(false);
    setOrchestrationOpen(false);
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

  async function refreshOrchestration(): Promise<void> {
    if (orchestrationLoading) return;
    setOrchestrationLoading(true);
    try {
      const payload = await getOrchestrationSnapshot(selectedSessionId ?? undefined);
      setOrchestration(payload);
    } catch (error) {
      setNotice(publicError(error));
    } finally {
      setOrchestrationLoading(false);
    }
  }

  async function openOrchestration(): Promise<void> {
    setFilesOpen(false);
    setOrchestrationOpen(true);
    setMobileNavigationOpen(false);
    await refreshOrchestration();
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
    <div className={`studio-shell ${historyHidden ? "history-hidden" : ""} ${turns.length > 0 ? "has-transcript" : ""}`}>
      <a className="skip-link" href="#agent-main">跳到对话</a>
      <section className={`account-popover ${accountOpen ? "is-open" : ""}`} aria-label="道引科技账号" aria-hidden={!accountOpen} inert={!accountOpen}>
        <strong>{authentication.account?.userName ?? "道引科技账号"}</strong>
        <button type="button" disabled={authenticationBusy || !connected} onClick={() => void (authentication.status === "signed_in" ? logoutDaoyin() : loginDaoyin())}>{authentication.status === "signed_in" ? "退出登录" : "登录账号"}</button>
        <button type="button" onClick={() => { setAccountOpen(false); restoreFocus(overlayTrigger.current); }}>关闭</button>
      </section>
      <header className="top-bar" inert={mobileNavVisible}>
        <div className="top-bar-left">
          <button className="mobile-menu" type="button" aria-label="打开会话导航" aria-controls="session-sidebar" aria-expanded={mobileNavVisible} onClick={() => setMobileNavigationOpen(true)}>
            <Icon name="menu" />
          </button>
          <button className="history-toggle" type="button" aria-label="展开对话列表" aria-controls="session-sidebar" aria-expanded={!historyHidden} aria-hidden={!historyHidden || mobileLayout} tabIndex={historyHidden && !mobileLayout ? 0 : -1} onClick={() => setSidebarCollapsed(false)}><Icon name="menu" /></button>
        </div>
        <div className="top-bar-title">
          <button className="workspace-crumb" type="button" title={workspace?.root} onClick={() => void openFiles()}><Icon name="folder" /><span>{workspace?.name ?? "工作区"}</span></button>
          <span className="crumb-divider">/</span>
          <strong>{selectedSession?.title ?? "新对话"}</strong>
        </div>
        <div className="top-bar-right">
          {selectedSession !== null ? (
            selectedSession.activeTurnId === null ? (
              <button className="session-action" type="button" disabled={sessionActionBusy !== null} onClick={() => void forkCurrentSession()} title="从最近安全终止边界创建不可变分支">
                <Icon name="fork" /><span>{sessionActionBusy === "fork" ? "分叉中" : "分叉"}</span>
              </button>
            ) : (
              <button className="session-action recovery" type="button" disabled={sessionActionBusy !== null} onClick={() => void resumeSelectedSession()} title="仅用于进程重启后遗留的运行中会话；仍在执行时会被拒绝">
                <Icon name="resume" /><span>{sessionActionBusy === "resume" ? "恢复中" : "恢复"}</span>
              </button>
            )
          ) : null}
        </div>
      </header>

      <div className={`main-layout ${filesOpen || orchestrationOpen ? "panel-open" : ""}`}>
        <button className={`nav-backdrop ${mobileNavVisible ? "is-open" : ""}`} type="button" aria-label="关闭会话导航" aria-hidden={!mobileNavVisible} tabIndex={-1} inert={!mobileNavVisible} onClick={() => { setMobileNavigationOpen(false); setAccountOpen(false); restoreFocus(document.querySelector<HTMLButtonElement>(".mobile-menu")); }} />
        <aside id="session-sidebar" className={`studio-sidebar ${mobileNavVisible ? "mobile-open" : ""}`} aria-label="会话导航" aria-hidden={!sidebarVisible} inert={!sidebarVisible}>
          <div className="sidebar-brand-row">
            <button className="sidebar-brand" type="button" aria-label="DaoyinHarness 首页" onClick={startFreshConversation}><BrandMark /><span><strong>Daoyin</strong><span className="brand-product">Harness</span></span></button>
            <button className="sidebar-collapse" type="button" aria-label="收起对话列表" aria-controls="session-sidebar" aria-expanded={!historyHidden} onClick={() => setSidebarCollapsed(true)}><Icon name="collapse" /></button>
            <button className="sidebar-mobile-close" type="button" aria-label="关闭会话导航" onClick={() => { setMobileNavigationOpen(false); restoreFocus(document.querySelector<HTMLButtonElement>(".mobile-menu")); }}><Icon name="close" /></button>
          </div>
          <button className="new-conversation" type="button" onClick={startFreshConversation}><Icon name="plus" /><span>新对话</span></button>
          <label className="session-search">
            <Icon name="search" />
            <input value={sessionQuery} onChange={(event) => setSessionQuery(event.target.value)} placeholder="搜索对话" aria-label="搜索会话" />
            {sessionSearching ? <i className="search-busy" aria-label="搜索中" /> : null}
          </label>
          <nav className="sidebar-primary" aria-label="工作台功能">
            <button className={`sidebar-nav-item ${filesOpen ? "active" : ""}`} type="button" aria-label="工作区" onClick={() => void openFiles()}>
              <Icon name="folder" /><span>工作区</span>
            </button>
            <div className="sidebar-workspace" title={workspace?.root}><span aria-hidden="true">└</span><span>{workspace?.name ?? "工作区未初始化"}</span><button className="workspace-switch-link" type="button" aria-label="切换工作区" disabled={!connected} onClick={() => { setMobileNavigationOpen(false); setWorkspaceManagerOpen(true); }}>切换</button></div>
            <button className={`sidebar-nav-item ${orchestrationOpen ? "active" : ""}`} type="button" aria-label="任务状态" onClick={() => void openOrchestration()}>
              <Icon name="spark" /><span>任务状态</span><small>{orchestration?.goals.filter((goal) => goal.status === "active" || goal.status === "blocked").length ?? 0}</small>
            </button>
          </nav>
          <section className="sidebar-section sessions" aria-labelledby="sessions-heading">
            <div className="sidebar-section-heading">
              <h2 id="sessions-heading">最近对话</h2>
              <button type="button" aria-label="新建对话" onClick={startFreshConversation}><Icon name="plus" /></button>
            </div>
            {sessions.length === 0 ? (
              <div className="empty-sessions"><Icon name="chat" /><span>还没有本地对话</span></div>
            ) : visibleSessions.length === 0 ? (
              <div className="empty-sessions search-empty"><Icon name="search" /><span>没有匹配的会话</span></div>
            ) : (
              <div className="session-list">
                {visibleSessions.map((session) => {
                  const hit = searchHitBySession.get(session.id);
                  return (
                    <button
                      className={`session-row ${session.id === selectedSessionId ? "active" : ""}`}
                      aria-current={session.id === selectedSessionId ? "page" : undefined}
                      key={session.id}
                      type="button"
                      onClick={() => void selectSession(session.id)}
                    >
                      <span>
                        <b>{session.title}{session.forkedFrom !== undefined ? <em className="fork-badge">分支</em> : null}</b>
                        <small>{hit === undefined ? timeLabel(session.updatedAt) : hit.matchedText}</small>
                      </span>
                      {session.activeTurnId !== null ? <i className="busy-dot" aria-label="执行中" /> : null}
                    </button>
                  );
                })}
              </div>
            )}
          </section>
          <footer className="sidebar-footer">
            <div className="sidebar-status"><i className={connected ? "online" : ""} /><span>{connected ? "本地已连接" : "本地未连接"}</span></div>
            <button className="sidebar-account" type="button" aria-label={authentication.status === "signed_in" ? "道引科技账号" : "登录道引账号"} aria-expanded={accountOpen} disabled={authenticationBusy || !connected} onClick={() => void (authentication.status === "signed_in" ? setAccountOpen((value) => !value) : loginDaoyin())}>
              <span className="account-avatar">{authentication.account?.userName.slice(0, 1).toUpperCase() ?? "D"}</span>
              <span><strong>{authenticationBusy ? "正在跳转…" : authentication.account?.userName ?? "登录道引账号"}</strong></span><span className="account-chevron" aria-hidden="true">›</span>
            </button>
          </footer>
        </aside>

        <main className="chat-area" id="agent-main" tabIndex={-1} aria-label="Agent 对话" inert={mobileNavVisible}>
          {state.kind === "loading" ? (
            <section className="welcome"><h1>正在准备工作台</h1><span className="loading-spinner" role="status" aria-label="加载中" /></section>
          ) : state.kind === "error" ? (
            <section className="welcome error-state"><h1>连接暂时中断</h1><p>{state.message}</p><button className="welcome-login" type="button" onClick={() => window.location.reload()}>重新连接</button></section>
          ) : turns.length === 0 ? (
            <section className="welcome">
              <BrandMark />
              <h1>今天，想完成什么？</h1>
              {!modelReady ? <button className="welcome-login" type="button" disabled={authenticationBusy || !connected} onClick={() => void loginDaoyin()}>{authenticationBusy ? "正在跳转" : "连接道引账号"}</button> : null}
              <div className="welcome-suggestions" aria-label="任务灵感">
                {([
                  { label: "整理文件", prompt: "帮我梳理工作区资料", icon: "folder" },
                  { label: "研究问题", prompt: "研究一个我感兴趣的问题", icon: "search" },
                  { label: "制定计划", prompt: "把我的想法整理成计划", icon: "spark" },
                ] as const).map((suggestion) => <button key={suggestion.label} type="button" onClick={() => { setPrompt(suggestion.prompt); document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus(); }}><Icon name={suggestion.icon} /><span>{suggestion.label}</span></button>)}
              </div>
              {selectedSession?.forkedFrom !== undefined ? (
                <div className="fork-context"><Icon name="fork" /><span>接着“{forkSource?.title ?? "原对话"}”继续</span></div>
              ) : null}
            </section>
          ) : (
            <section className="transcript" aria-live="polite" onScroll={(event) => { const element = event.currentTarget; followTranscript.current = element.scrollHeight - element.scrollTop - element.clientHeight < 72; }}>
              <div className="transcript-inner">
                {turns.map((turn) => (
                  <article className="turn" key={turn.turnId}>
                    <div className="user-message"><span className="user-avatar" aria-hidden="true">你</span><div><strong className="message-author">你</strong><div className="user-bubble">{turn.userMessage}</div></div></div>
                    <div className="assistant-message">
                      <div className="assistant-avatar"><BrandMark /></div>
                      <div className="assistant-body">
                        <strong className="message-author">道引助手</strong>
                        {turn.tools.length > 0 ? (
                          <div className="tool-stack">
                            {turn.tools.map((tool) => {
                              const permission = tool.permission;
                              const permissionStatus = permission === undefined ? undefined : permissionOverrides[permission.requestId] ?? permission.status;
                              return (
                                <div className={`tool-line ${tool.status} ${permission !== undefined ? "permission-tool" : ""}`} key={tool.id}>
                                  <i />
                                  <div>
                                    <b>{toolLabel(tool.name)}<span className="tool-state-label">{tool.status === "running" ? "进行中" : tool.status === "completed" ? "完成" : "未完成"}</span></b>
                                    {tool.text ? <details className="tool-details"><summary>查看详情</summary><p>{tool.text}</p></details> : null}
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
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : null}
                        {turn.assistantText.length > 0 ? <div className={`assistant-text ${turn.status === "failed" ? "failed" : ""}`}><MarkdownMessage text={turn.assistantText} /></div> : null}
                        {turn.assistantText.length > 0 && turn.status !== "running" ? <div className="message-actions"><button type="button" aria-label="复制回答" onClick={() => void copyAnswer(turn)}><Icon name={copiedTurnId === turn.turnId ? "check" : "copy"} /><span>{copiedTurnId === turn.turnId ? "已复制" : "复制"}</span></button></div> : null}
                        {turn.status === "running" && turn.assistantText.length === 0 ? <div className="thinking-line"><span /><span /><span /></div> : null}
                        {turn.status === "cancelled" ? <div className="turn-state">已停止</div> : null}
                        {turn.status === "interrupted" ? <div className="turn-state interrupted">任务已中断，可以继续</div> : null}
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
                  <button className="file-access" type="button" aria-label="查看工作区文件" onClick={() => void openFiles()}><Icon name="folder" /><span>访问文件</span></button>
                  <span>{selectedSession?.activeTurnId !== null && selectedSession !== null ? "正在工作" : prompt.length > 18000 ? `${String(prompt.length)} / 20000` : ""}</span>
                </div>
                <div>
                  <button className={`planning-toggle ${planningEnabled ? "active" : ""}`} type="button" aria-pressed={planningEnabled} onClick={() => setPlanningEnabled((value) => !value)}>
                    <span>仔细规划</span><i className="planning-switch" aria-hidden="true" />
                  </button>
                  {selectedSession?.activeTurnId !== null && selectedSession !== null ? (
                    <button className="stop-button" type="button" aria-label="停止当前任务" onClick={() => void stopCurrentTurn()}><Icon name="stop" /></button>
                  ) : (
                    <button className="send-button" type="submit" disabled={prompt.trim().length === 0 || sending || !connected || !modelReady} aria-label="发送任务"><Icon name="send" /></button>
                  )}
                </div>
              </div>
            </form>
          </div>
        </main>

        {workspaceManagerOpen ? <WorkspaceManager workspace={workspace} hasDraft={prompt.trim().length > 0} onClose={() => setWorkspaceManagerOpen(false)} /> : null}

          <aside className={`file-panel ${filesOpen ? "is-open" : ""}`} aria-label="工作区文件" aria-hidden={!filesOpen || mobileNavVisible} inert={!filesOpen || mobileNavVisible}>
            <div className="file-panel-heading"><strong>工作区文件</strong><button type="button" aria-label="关闭工作区文件" onClick={() => { setFilesOpen(false); restoreFocus(overlayTrigger.current); }}><Icon name="close" /></button></div>
            <div className="file-panel-root">{workspace?.root}</div>
            <button className="file-panel-switch" type="button" onClick={() => setWorkspaceManagerOpen(true)}>选择或切换工作区 <span>↗</span></button>
            <div className="file-list">
              {filesLoading ? <p>正在读取文件……</p> : files.length === 0 ? <p>工作区暂无文件</p> : files.map((file) => <div className="file-row" key={file}><Icon name="file" /><span title={file}>{file}</span></div>)}
            </div>
          </aside>

          <aside className={`file-panel orchestration-panel ${orchestrationOpen ? "is-open" : ""}`} aria-label="任务与工作流状态" aria-hidden={!orchestrationOpen || mobileNavVisible} inert={!orchestrationOpen || mobileNavVisible}>
            <div className="file-panel-heading">
              <strong>任务状态</strong>
              <div className="panel-heading-actions">
                <button type="button" aria-label="刷新任务状态" onClick={() => void refreshOrchestration()}><Icon name="spark" /></button>
                <button type="button" aria-label="关闭任务状态" onClick={() => { setOrchestrationOpen(false); restoreFocus(overlayTrigger.current); }}><Icon name="close" /></button>
              </div>
            </div>
            <div className="orchestration-list">
              {orchestrationLoading && orchestration === null ? <p>正在读取任务状态……</p> : null}
              {orchestration !== null ? (
                <>
                  <section className="orchestration-section">
                    <h3>目标 <span>{orchestration.goals.length}</span></h3>
                    {orchestration.goals.length === 0 ? <p className="orchestration-empty">当前没有持久目标</p> : orchestration.goals.map((goal) => (
                      <div className="goal-row" key={goal.id}>
                        <div className="orchestration-row-title"><strong>{goal.title}</strong><em className={`task-status ${goal.status}`}>{orchestrationStatusLabel(goal.status)}</em></div>
                        {goal.description ? <p>{goal.description}</p> : null}
                        {goal.steps.length > 0 ? <div className="goal-steps">{goal.steps.map((step) => <span className={step.status} key={step.id}><i />{step.text}</span>)}</div> : null}
                        {goal.note ? <small>{goal.note}</small> : null}
                      </div>
                    ))}
                  </section>
                  <section className="orchestration-section">
                    <h3>工作流 <span>{orchestration.workflows.length}</span></h3>
                    {orchestration.workflows.length === 0 ? <p className="orchestration-empty">还没有可复用工作流</p> : orchestration.workflows.map((workflow) => (
                      <div className="workflow-row" key={workflow.id}>
                        <div className="orchestration-row-title"><strong>{workflow.name}</strong><em>{workflow.steps.length} 步</em></div>
                        {workflow.description ? <p>{workflow.description}</p> : null}
                        <small>{workflow.steps.map((step) => step.instruction).join(" → ")}</small>
                      </div>
                    ))}
                  </section>
                  <section className="orchestration-section">
                    <h3>最近执行 <span>{orchestration.workflowRuns.length + orchestration.childRuns.length}</span></h3>
                    {orchestration.workflowRuns.slice(-8).reverse().map((run) => (
                      <div className="run-row" key={run.id}>
                        <div className="orchestration-row-title"><strong>Workflow</strong><em className={`task-status ${run.status}`}>{orchestrationStatusLabel(run.status)}</em></div>
                        <small>{run.steps.map((step) => `${step.stepId}:${orchestrationStatusLabel(step.status)}`).join(" · ")}</small>
                      </div>
                    ))}
                    {orchestration.childRuns.slice(-8).reverse().map((run) => (
                      <div className="run-row" key={run.id}>
                        <div className="orchestration-row-title"><strong>Child Agent</strong><em className={`task-status ${run.status}`}>{orchestrationStatusLabel(run.status)}</em></div>
                        <p>{run.instruction}</p>
                        {run.finalText ? <small>{run.finalText}</small> : null}
                      </div>
                    ))}
                  </section>
                </>
              ) : null}
            </div>
          </aside>
      </div>
    </div>
  );
}
