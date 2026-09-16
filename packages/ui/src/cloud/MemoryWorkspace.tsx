import { useEffect, useRef, useState } from "react";
import type { DurableMemory, WorkbenchClient } from "./client.js";
import { WorkbenchError } from "./client.js";
import "./memory-workspace.css";

const kindLabel = { preference: "偏好", fact: "事实", goal: "目标", decision: "决定", note: "备注" };
const scopeLabel = { application: "当前工作台", personal: "个人", organization: "企业" };
const stateLabel = { pending: "待确认", active: "使用中", superseded: "已更新", forgotten: "已忘记", rejected: "已拒绝" };

function time(value: number): string {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(value);
}

export function MemoryWorkspace({ client, ready, onConnect }: {
  client: WorkbenchClient; ready: boolean; onConnect: () => void;
}): React.JSX.Element {
  const [items, setItems] = useState<DurableMemory[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<DurableMemory>();
  useEffect(() => {
    const controller = new AbortController();
    if (!ready) return () => controller.abort();
    setBusy(true); setError("");
    void client.memories(0, controller.signal).then((result) => {
      if (!controller.signal.aborted) setItems(result.items);
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "记忆加载失败，请重试。");
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [client, ready, refresh]);

  async function forget(memory: DurableMemory): Promise<void> {
    setBusy(true); setError("");
    try {
      await client.forgetMemory(memory.id, memory.revision);
      setSelected(undefined);
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof WorkbenchError ? cause.message : "没有完成忘记操作，请重试。");
    } finally { setBusy(false); }
  }

  const visible = items.filter((item) => item.state === "active" || item.state === "pending");
  return <section className="memory-workspace" aria-label="长期记忆">
    <header className="memory-toolbar">
      <h1>记忆</h1>
      <button type="button" disabled={!ready || busy} onClick={() => setRefresh((value) => value + 1)}>刷新</button>
    </header>
    {!ready ? <div role="status"><p>连接道引账号后可查看长期记忆。</p><button type="button" onClick={onConnect}>连接账号</button></div> : <>
      <p className="memory-help">这里保存的内容会在相关的新会话中自动提供给 Harness。你也可以在会话中说“记住……”或“忘记……”。</p>
      {busy && !items.length && <p role="status">正在加载记忆…</p>}
      {error && <p className="memory-error" role="alert">{error}</p>}
      {!busy && !error && visible.length === 0 && <div className="memory-empty" role="status"><strong>还没有长期记忆</strong><span>在会话中明确说“记住我的偏好……”即可创建。</span></div>}
      <div className="memory-list">{visible.map((memory) => <article className="memory-card" key={memory.id}>
        <div className="memory-card-head"><div className="memory-tags"><span>{kindLabel[memory.kind]}</span><span>{scopeLabel[memory.scope]}</span></div><span className={"memory-state is-" + memory.state}>{stateLabel[memory.state]}</span></div>
        <p>{memory.content}</p>
        <footer><time dateTime={new Date(memory.createdAt).toISOString()}>{time(memory.createdAt)}</time>
          {memory.state === "active" && <button type="button" disabled={busy} onClick={() => setSelected(memory)}>忘记</button>}</footer>
      </article>)}</div>
    </>}
    {selected && <ForgetDialog memory={selected} busy={busy} onClose={() => setSelected(undefined)} onConfirm={() => void forget(selected)} />}
  </section>;
}

function ForgetDialog({ memory, busy, onClose, onConfirm }: {
  memory: DurableMemory; busy: boolean; onClose: () => void; onConfirm: () => void;
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.showModal();
    return () => { if (previous instanceof HTMLElement) previous.focus(); };
  }, []);
  return <dialog ref={dialog} className="memory-dialog" aria-labelledby="memory-forget-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <button type="button" className="memory-dialog-close" aria-label="关闭" disabled={busy} onClick={onClose}>×</button>
    <h2 id="memory-forget-title">忘记这条内容？</h2>
    <p className="memory-dialog-content">{memory.content}</p>
    <p className="memory-dialog-note">忘记后，Harness 不会在后续会话中继续使用它。</p>
    <footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button type="button" className="danger" disabled={busy} onClick={onConfirm}>{busy ? "正在处理…" : "确认忘记"}</button></footer>
  </dialog>;
}
