import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CloudSession, SessionAction } from "./client.js";
import { WorkbenchIcon } from "./WorkbenchIcon.js";

interface HistoryProps {
  sessions: readonly CloudSession[];
  selected: string;
  chatActive: boolean;
  disabled: boolean;
  isProtected: (sessionId: string) => boolean;
  onChoose: (sessionId: string) => void;
  onManage: (sessionId: string, action: SessionAction, confirm?: boolean) => Promise<void>;
}

function SessionMenu({ session, anchor, protectedSession, onClose, onAction }: {
  session: CloudSession; anchor: HTMLButtonElement; protectedSession: boolean;
  onClose: (restoreFocus: boolean) => void; onAction: (action: SessionAction) => void;
}): React.JSX.Element {
  const menu = useRef<HTMLDivElement>(null);
  const menuId = `session-menu-${session.id}`;
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const rect = anchor.getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    const gap = 8;
    element.style.left = `${Math.max(gap, Math.min(rect.right - bounds.width, window.innerWidth - bounds.width - gap))}px`;
    const below = rect.bottom + gap;
    element.style.top = `${Math.max(gap, Math.min(below + bounds.height <= window.innerHeight - gap ? below : rect.top - bounds.height - gap, window.innerHeight - bounds.height - gap))}px`;
    element.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !element.contains(event.target) && !anchor.contains(event.target)) onClose(false);
    };
    const scroll = (event: Event): void => {
      if (!(event.target instanceof Node) || !element.contains(event.target)) onClose(true);
    };
    const resize = (): void => onClose(true);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", resize);
    };
  }, [anchor, onClose]);
  return createPortal(<div ref={menu} id={menuId} className="session-context-menu" role="menu" aria-label={`${session.title || "未命名会话"}的操作`} onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(true); return; }
    if (event.key === "Tab") {
      event.preventDefault(); event.stopPropagation(); onClose(true); return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const controls = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    const current = controls.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? controls.length - 1
      : (current + (event.key === "ArrowDown" ? 1 : -1) + controls.length) % controls.length;
    controls[next]?.focus();
  }}>
    <button type="button" role="menuitem" disabled={!!session.archivedAt} onClick={() => onAction(session.pinnedAt ? "unpin" : "pin")}><WorkbenchIcon name="pushpin" />{session.pinnedAt ? "取消置顶" : "置顶"}</button>
    <button type="button" role="menuitem" disabled={protectedSession} title={protectedSession ? "请先停止生成或确认原提交结果" : undefined} onClick={() => onAction(session.archivedAt ? "restore" : "archive")}><WorkbenchIcon name={session.archivedAt ? "restore" : "archive"} />{session.archivedAt ? "取消归档" : "归档"}</button>
    <div role="separator" />
    <button type="button" role="menuitem" className="session-delete-action" disabled={protectedSession} title={protectedSession ? "请先停止生成或确认原提交结果" : undefined} onClick={() => onAction("delete")}><WorkbenchIcon name="trash" />删除</button>
  </div>, document.body);
}

function DeleteSessionDialog({ session, onClose, onConfirm }: {
  session: CloudSession; onClose: () => void; onConfirm: () => Promise<void>;
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const inflight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const element = dialog.current;
    element?.showModal(); cancel.current?.focus();
    return () => element?.close();
  }, []);
  async function confirm(): Promise<void> {
    if (inflight.current) return;
    inflight.current = true; setBusy(true); setError("");
    try { await onConfirm(); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "删除未完成，请重试。"); }
    finally { inflight.current = false; setBusy(false); }
  }
  return createPortal(<dialog ref={dialog} className="workbench-settings session-delete-dialog" aria-labelledby="delete-session-title" aria-describedby="delete-session-description" onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }} onCancel={(event) => { event.preventDefault(); if (!inflight.current) onClose(); }}>
    <header><h2 id="delete-session-title">删除会话？</h2></header>
    <p className="session-delete-title">{session.title || "未命名会话"}</p>
    <p id="delete-session-description" className="muted">会话将从列表移除，界面中无法恢复。服务器保留原始记录用于审计，不是彻底清除数据。</p>
    {error && <p className="settings-error" role="alert">{error}</p>}
    <footer><button ref={cancel} type="button" disabled={busy} onClick={onClose}>取消</button><button type="button" className="session-delete-confirm" disabled={busy} onClick={() => { void confirm(); }}>{busy ? "正在删除…" : "确认删除"}</button></footer>
  </dialog>, document.body);
}

export function SessionHistory({ sessions, selected, chatActive, disabled, isProtected, onChoose, onManage }: HistoryProps): React.JSX.Element {
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLButtonElement } | null>(null);
  const [deleting, setDeleting] = useState<CloudSession | null>(null);
  const [error, setError] = useState("");
  const create = useRef<HTMLButtonElement>(null);
  const lastTrigger = useRef<HTMLButtonElement | null>(null);
  const menuSession = menu ? sessions.find((item) => item.id === menu.id) : undefined;
  const closeMenu = useCallback((restoreFocus: boolean): void => {
    setMenu(null);
    if (restoreFocus && menu?.anchor.isConnected) menu.anchor.focus({ preventScroll: true });
  }, [menu?.anchor]);
  const closeDelete = (): void => {
    setDeleting(null);
    window.requestAnimationFrame(() => {
      (lastTrigger.current?.isConnected ? lastTrigger.current : create.current)?.focus({ preventScroll: true });
    });
  };
  const inView = sessions.filter((item) => !!item.archivedAt === archived);
  const visible = inView.filter((item) => item.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).sort((a, b) =>
    Number(!!b.pinnedAt) - Number(!!a.pinnedAt) || (b.pinnedAt ?? "").localeCompare(a.pinnedAt ?? "") || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  async function perform(item: CloudSession, action: SessionAction): Promise<void> {
    closeMenu(true); setError("");
    if (action === "delete") { setDeleting(item); return; }
    try {
      await onManage(item.id, action);
      window.requestAnimationFrame(() => {
        if (!lastTrigger.current?.isConnected) create.current?.focus({ preventScroll: true });
      });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "会话操作未完成，请重试。"); }
  }
  return <section className="sidebar-history" aria-labelledby="history-heading">
    <div className="sidebar-label"><h2 id="history-heading">会话记录</h2><button ref={create} type="button" className="new-session" disabled={disabled} onClick={() => { setArchived(false); onChoose(""); }}><WorkbenchIcon name="plus" />新建会话</button></div>
    <label className="search"><span>搜索会话</span><WorkbenchIcon name="search" /><input type="search" value={search} onChange={(event) => { setMenu(null); setSearch(event.target.value); }} placeholder={archived ? "搜索已归档会话" : "搜索会话"} /></label>
    <div className="history-filters" role="group" aria-label="会话范围">
      <button type="button" aria-pressed={!archived} onClick={() => { setMenu(null); setArchived(false); setError(""); }}>最近会话</button>
      <button type="button" aria-pressed={archived} onClick={() => { setMenu(null); setArchived(true); setError(""); }}>已归档{sessions.some((item) => item.archivedAt) ? ` (${sessions.filter((item) => item.archivedAt).length})` : ""}</button>
    </div>
    {error && <p className="history-error" role="alert">{error}</p>}
    <nav aria-label={archived ? "已归档会话" : "最近会话"} className="session-list">
      {visible.map((item) => <div key={item.id} className="session-row" data-active={chatActive && selected === item.id || undefined}>
        <button type="button" className="session-open" aria-current={chatActive && selected === item.id ? "page" : undefined} disabled={disabled} onClick={() => { setMenu(null); onChoose(item.id); }} title={item.title}><WorkbenchIcon name="chat" /><span>{item.title || "未命名会话"}</span>{item.pinnedAt && <span className="session-pin" aria-label="已置顶"><WorkbenchIcon name="pushpin" /></span>}</button>
        <button type="button" className="session-more" disabled={disabled} aria-label={`${item.title || "未命名会话"}的更多操作`} aria-haspopup="menu" aria-expanded={menu?.id === item.id} aria-controls={menu?.id === item.id ? `session-menu-${item.id}` : undefined} title="更多操作" onClick={(event) => {
          lastTrigger.current = event.currentTarget;
          setMenu(menu?.id === item.id ? null : { id: item.id, anchor: event.currentTarget });
        }} onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); lastTrigger.current = event.currentTarget; setMenu({ id: item.id, anchor: event.currentTarget }); }
        }}><WorkbenchIcon name="more" /></button>
      </div>)}
      {visible.length === 0 && <p className="muted" role="status">{inView.length ? "没有匹配的会话" : archived ? "暂无已归档会话" : "暂无会话"}</p>}
    </nav>
    {menu && menuSession && !disabled && <SessionMenu session={menuSession} anchor={menu.anchor} protectedSession={isProtected(menu.id)} onClose={closeMenu} onAction={(action) => { void perform(menuSession, action); }} />}
    {deleting && <DeleteSessionDialog session={deleting} onClose={closeDelete} onConfirm={() => onManage(deleting.id, "delete", true)} />}
  </section>;
}
