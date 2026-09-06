import { useEffect, useRef, useState } from "react";
import type { AccountProfile } from "./client.js";
import { WorkbenchIcon } from "./WorkbenchIcon.js";

export function AccountIdentity({ account, onSettings, onLogout }: { account: AccountProfile; onSettings: () => void; onLogout: () => Promise<void> }): React.JSX.Element {
  const [failedUrl, setFailedUrl] = useState<string>();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  function close(restore = false): void { setOpen(false); if (restore) trigger.current?.focus(); }
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const outside = (event: PointerEvent): void => { if (event.target instanceof Node && !container.current?.contains(event.target)) close(); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  async function logout(): Promise<void> {
    if (busy) return;
    setBusy(true); setError("");
    try { await onLogout(); } catch { setError("退出登录未完成，请重试。"); } finally { setBusy(false); }
  }
  return <div className="account-control" ref={container} onBlur={(event) => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) close(); }} onKeyDown={(event) => {
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(true); }
  }}>
    <button type="button" className="account-identity" ref={trigger} aria-label={`当前账号：${account.username}`} aria-haspopup="menu" aria-expanded={open} aria-controls="account-menu" onClick={() => setOpen(!open)} onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); } }}>
    <span className="account-avatar" aria-hidden="true">
      {account.avatarUrl && account.avatarUrl !== failedUrl
        ? <img src={account.avatarUrl} alt="" referrerPolicy="no-referrer" onError={() => setFailedUrl(account.avatarUrl ?? undefined)} />
        : Array.from(account.username)[0]?.toUpperCase()}
    </span>
    <span className="account-username" title={account.username}>{account.username}</span>
    <span className="account-menu-indicator" aria-hidden="true">···</span>
    </button>
    {open && <div className="account-menu" id="account-menu" role="menu" aria-label="账号菜单" ref={menu} onKeyDown={(event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const items = Array.from(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not(:disabled)") ?? []);
      const current = items.indexOf(document.activeElement as HTMLElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }}>
      <a href="/my/profile" target="_blank" rel="noopener noreferrer" role="menuitem" onClick={() => close(true)}><WorkbenchIcon name="user" /><span>个人中心</span><span className="account-external" aria-hidden="true">↗</span></a>
      <button type="button" role="menuitem" disabled={busy} onClick={() => { close(true); onSettings(); }}><WorkbenchIcon name="settings" /><span>设置</span></button>
      <div role="separator" />
      <button type="button" role="menuitem" className="account-logout" disabled={busy} onClick={() => { void logout(); }}><WorkbenchIcon name="logout" /><span>{busy ? "正在退出…" : "退出登录"}</span></button>
      {error && <p role="alert" className="settings-error">{error}</p>}
    </div>}
  </div>;
}
