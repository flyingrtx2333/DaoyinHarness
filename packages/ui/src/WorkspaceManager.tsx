import { useEffect, useRef, useState } from "react";
import type { WorkspaceHistoryResponse, WorkspaceSummary } from "@daoyin/harness-protocol";
import { getWorkspaceHistory, pickWorkspace, switchWorkspace } from "./api.js";

export function WorkspaceManager({ workspace, onClose, hasDraft }: {
  workspace: WorkspaceSummary | null;
  onClose: () => void;
  hasDraft: boolean;
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeCallback = useRef(onClose);
  closeCallback.current = onClose;
  const [history, setHistory] = useState<WorkspaceHistoryResponse | null>(null);
  const [root, setRoot] = useState("");
  const [busy, setBusy] = useState<"pick" | "switch" | null>(null);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.showModal();
    let active = true;
    void getWorkspaceHistory().then((value) => { if (active) setHistory(value); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "读取最近工作区失败。"); });
    return () => { active = false; if (previous instanceof HTMLElement) previous.focus(); };
  }, []);
  useEffect(() => {
    if (!closing) return;
    const delay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180;
    const timer = window.setTimeout(() => { dialog.current?.close(); closeCallback.current(); }, delay);
    return () => window.clearTimeout(timer);
  }, [closing]);

  function close(): void { if (busy === null) setClosing(true); }

  async function choose(): Promise<void> {
    if (busy !== null || closing) return;
    setBusy("pick"); setError("");
    try {
      const result = await pickWorkspace();
      if (result.root !== null) setRoot(result.root);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法选择文件夹，请输入路径。"); }
    finally { setBusy(null); }
  }

  async function open(rootToOpen: string): Promise<void> {
    if (busy !== null || closing || rootToOpen.trim().length === 0) return;
    setBusy("switch"); setError("");
    try {
      await switchWorkspace(rootToOpen);
      window.location.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "切换失败，请重试。");
      setBusy(null);
    }
  }

  return (
    <dialog ref={dialog} className={`workspace-dialog ${closing ? "is-closing" : ""}`} aria-labelledby="workspace-manager-title" onCancel={(event) => { event.preventDefault(); close(); }}>
      <div className="workspace-dialog-heading"><h2 id="workspace-manager-title">切换工作区</h2><button type="button" className="workspace-close" aria-label="关闭工作区管理" disabled={busy !== null || closing} onClick={close}>×</button></div>
      <div className="workspace-current"><span>当前工作区</span><strong>{workspace?.name ?? "尚未选择"}</strong><small>{workspace?.root}</small></div>
      <form onSubmit={(event) => { event.preventDefault(); void open(root.trim()); }}>
        <label htmlFor="workspace-root">文件夹路径</label>
        <div className="workspace-path-row"><input id="workspace-root" autoFocus value={root} onChange={(event) => setRoot(event.target.value)} placeholder="例如 D:\Projects\my-project" disabled={busy !== null || closing} autoComplete="off" /><button type="button" disabled={busy !== null || closing || !history?.nativePickerAvailable} onClick={() => void choose()}>{busy === "pick" ? "选择窗口已打开…" : "选择文件夹"}</button></div>
        <div className="workspace-open-row"><small>{hasDraft ? "切换后将清空当前未发送的草稿。" : "任务执行中无法切换。"}</small><button className="workspace-open" type="submit" disabled={busy !== null || closing || root.trim().length === 0}>{busy === "switch" ? "正在打开…" : "打开工作区"}</button></div>
      </form>
      {error ? <p className="workspace-error" role="alert">{error}</p> : null}
      <section className="workspace-recents" aria-label="最近工作区"><h3>最近打开</h3>
        {history === null ? <p className="workspace-help">正在读取…</p> : history.recent.length === 0 ? <p className="workspace-help">暂无记录</p> : history.recent.map((item) => (
          <button type="button" key={item.root} disabled={busy !== null || closing || item.root === workspace?.root} onClick={() => void open(item.root)}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3.5 7.5h6l1.8 2H20.5v9.5H3.5z" /></svg><span><strong>{item.name}</strong><small>{item.root}</small></span><em>{item.root === workspace?.root ? "当前" : "打开 →"}</em></button>
        ))}
      </section>
    </dialog>
  );
}
