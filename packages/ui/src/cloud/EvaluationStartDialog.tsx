import { useEffect, useRef, useState } from "react";
import type { EvaluationSpec } from "./evaluation-client.js";
import { WorkbenchIcon } from "./WorkbenchIcon.js";

export function EvaluationStartDialog({ spec, model, onClose, onConfirm }: {
  spec: EvaluationSpec; model: string | null; onClose(): void; onConfirm(): Promise<void>;
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const inflight = useRef(false);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current;
    mounted.current = true; element?.showModal(); cancel.current?.focus();
    return () => { mounted.current = false; element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  async function confirm(): Promise<void> {
    if (inflight.current) return;
    inflight.current = true; setBusy(true); setError("");
    try { await onConfirm(); if (mounted.current) onClose(); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "提交未完成，请恢复原实验。"); }
    finally { inflight.current = false; if (mounted.current) setBusy(false); }
  }
  return <dialog ref={dialog} className="eval-confirm-dialog" aria-labelledby="eval-confirm-title" aria-describedby="eval-confirm-risk" onCancel={event => { event.preventDefault(); if (!inflight.current) onClose(); }}>
    <header className="eval-panel-heading"><h2 id="eval-confirm-title">开始这批测试？</h2><span className="eval-badge">{spec.cases.length * spec.repetitions} 次执行</span></header>
    <ol className="eval-confirm-cases">{spec.cases.map(item => <li key={item.id}>{item.input}</li>)}</ol>
    <dl className="eval-evidence-fields"><dt>模型</dt><dd>{model ?? "平台配置模型"}</dd><dt>调用上限</dt><dd>每题 {spec.maxModelCalls} 次，共 {spec.maxTotalCalls} 次</dd></dl>
    <p id="eval-confirm-risk" className="eval-caption">将在当前账号创建真实会话并产生模型费用。业务结果需人工复核。</p>
    {error && <p className="evaluation-error" role="alert">{error}</p>}
    <footer className="eval-confirm-actions"><button type="button" ref={cancel} disabled={busy} onClick={onClose}>取消</button><button type="button" className="primary" disabled={busy} onClick={() => { void confirm(); }}>{busy ? <span className="spinner" /> : <WorkbenchIcon name="arrow" />}{busy ? "正在提交…" : "确认并开始"}</button></footer>
  </dialog>;
}
