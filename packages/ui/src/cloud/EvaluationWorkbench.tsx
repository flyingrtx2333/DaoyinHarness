import { useEffect, useMemo, useRef, useState } from "react";
import { EvaluationApiError, type Catalog, type EvaluationClient, type EvaluationSpec, type EvaluationView, type HistoryItem, type Trial } from "./evaluation-client.js";
import { approvedEvaluationCases, evaluationDraft, evaluationDraftError, type CaseOptions } from "./evaluation-draft.js";
import { EvaluationResults, evaluationStatus, type TrialChoice } from "./EvaluationResults.js";
import { EvaluationStartDialog } from "./EvaluationStartDialog.js";
import { WorkbenchIcon } from "./WorkbenchIcon.js";

interface Receipt { requestId: string; digest: string }
const shortDate = (value: string): string => new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
function catalogFailure(cause: unknown): string {
  if (cause instanceof EvaluationApiError) {
    if (cause.status === 404 || cause.code === "EVAL_UPSTREAM_ROUTE_MISSING") return "评估服务入口未接通，请检查部署。";
    if (cause.code === "EVALUATION_NOT_CONFIGURED") return "主平台尚未配置评估服务。";
    return `评估服务暂不可用（HTTP ${cause.status}）。`;
  }
  return "读取配置超时或连接中断，请重试。";
}
async function digest(spec: EvaluationSpec): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(spec)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function EvaluationWorkbench({ client, onDenied }: { client: EvaluationClient; onDenied(): void }): React.JSX.Element {
  const [catalog, setCatalog] = useState<Catalog>();
  const [catalogState, setCatalogState] = useState<"loading" | "ready" | "failed">("loading");
  const [catalogError, setCatalogError] = useState(""); const [catalogReload, setCatalogReload] = useState(0);
  const [lines, setLines] = useState(""); const [options, setOptions] = useState<Record<string, CaseOptions>>({});
  const cases = useMemo(() => evaluationDraft(lines, options), [lines, options]);
  const [title, setTitle] = useState(""); const [repetitions, setRepetitions] = useState(1); const [maxCallsText, setMaxCallsText] = useState("4");
  const maxCalls = Number(maxCallsText);
  const draftError = evaluationDraftError(cases, repetitions, maxCalls);
  const totalTrials = cases.length * repetitions;
  const totalCalls = Number.isInteger(maxCalls) && maxCalls >= 2 && maxCalls <= 12 ? totalTrials * maxCalls : 0;
  const [confirmation, setConfirmation] = useState<EvaluationSpec>();
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [history, setHistory] = useState<HistoryItem[]>([]); const [offset, setOffset] = useState(0);
  const [historyState, setHistoryState] = useState<"loading" | "ready" | "failed">("loading"); const [historyError, setHistoryError] = useState("");
  const [historyReload, setHistoryReload] = useState(0);
  const [selected, setSelected] = useState(""); const [run, setRun] = useState<EvaluationView>(); const [detailReload, setDetailReload] = useState(0);
  const [detailError, setDetailError] = useState("");
  const [trial, setTrial] = useState<Trial>(); const [trialChoice, setTrialChoice] = useState<TrialChoice>();
  const [trialError, setTrialError] = useState(""); const [trialReload, setTrialReload] = useState(0);
  const [receipt, setReceipt] = useState<Receipt>();
  const mounted = useRef(true); const operation = useRef(false); const input = useRef<HTMLTextAreaElement>(null);
  const results = useRef<HTMLDivElement>(null); const shouldScroll = useRef(false);
  const scope = client.scope; const storageKey = `daoyin-evaluation-receipt:${scope}`; const selectedKey = `daoyin-evaluation-selected:${scope}`;
  const current = (): boolean => mounted.current && client.scope === scope;
  const running = run?.status === "running" || run?.status === "cancelling" || history.some(item => ["running", "cancelling"].includes(item.status));
  function denied(cause: unknown): boolean {
    if (cause instanceof EvaluationApiError && [401, 403].includes(cause.status)) {
      setConfirmation(undefined); setLines(""); setOptions({}); setRun(undefined); setTrial(undefined); setHistory([]); onDenied(); return true;
    }
    return false;
  }
  function fail(cause: unknown): void { if (current() && !denied(cause)) setError(cause instanceof Error ? cause.message : "请求未完成，请重试。"); }
  function updateLines(value: string): void {
    setLines(value); setError("");
    // Metadata follows an unchanged input, not its old line number. Never submit stale cases.
    const keys = new Set(evaluationDraft(value, {}).map(item => item.key));
    setOptions(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => keys.has(key))));
  }
  function pick(id: string, scroll = true): void {
    setSelected(id); setRun(undefined); setTrial(undefined); setTrialChoice(undefined); setDetailError(""); setTrialError(""); setDetailReload(value => value + 1);
    shouldScroll.current = scroll;
    try { sessionStorage.setItem(selectedKey, id); } catch { /* Optional selection only. */ }
  }
  function clearReceipt(): void { setReceipt(undefined); try { sessionStorage.removeItem(storageKey); } catch { /* Server idempotency remains authoritative. */ } }
  useEffect(() => {
    mounted.current = true;
    try {
      const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey) || "null");
      if (saved && typeof saved === "object" && "requestId" in saved && "digest" in saved && typeof saved.requestId === "string" && typeof saved.digest === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(saved.requestId) && /^[a-f0-9]{64}$/u.test(saved.digest)) setReceipt({ requestId: saved.requestId, digest: saved.digest });
      const id = sessionStorage.getItem(selectedKey); if (id && /^ev_[a-f0-9]{32}$/u.test(id)) setSelected(id);
    } catch { /* Never submit an invalid receipt. */ }
    return () => { mounted.current = false; };
  }, [client, scope]);
  useEffect(() => {
    const controller = new AbortController(); setCatalogState("loading"); setCatalogError("");
    void client.catalog(controller.signal).then(value => {
      if (controller.signal.aborted || !current()) return; setCatalog(value); setCatalogState("ready");
    }).catch(cause => { if (controller.signal.aborted || !current()) return; setCatalogState("failed"); if (!denied(cause)) setCatalogError(catalogFailure(cause)); });
    return () => controller.abort();
  }, [client, scope, catalogReload]);
  useEffect(() => {
    if (catalogState !== "ready") return;
    const controller = new AbortController(); setHistoryState("loading"); setHistoryError("");
    void client.history(offset, controller.signal).then(data => {
      if (controller.signal.aborted || !current()) return; setHistory(data.runs); setHistoryState("ready");
    }).catch(cause => {
      if (controller.signal.aborted || !current()) return; setHistoryState("failed"); if (!denied(cause)) setHistoryError("历史实验读取失败");
    });
    return () => controller.abort();
  }, [client, scope, catalogState, offset, historyReload]);
  useEffect(() => {
    if (!selected || catalogState !== "ready") return;
    const controller = new AbortController(); let timer: number | undefined; let observedActive = false;
    async function refresh(): Promise<void> {
      try {
        const value = await client.detail(selected, controller.signal);
        if (controller.signal.aborted || !current()) return;
        setRun(value); setDetailError("");
        setHistory(items => items.map(item => item.id === value.id ? { ...item, status: value.status, completed: value.completed, planned: value.planned } : item));
        if (["running", "cancelling"].includes(value.status)) { observedActive = true; timer = window.setTimeout(() => { void refresh(); }, 1500); }
        else if (observedActive) { observedActive = false; setHistoryReload(value => value + 1); }
      } catch (cause) {
        if (controller.signal.aborted || !current()) return;
        if (!denied(cause)) setDetailError(cause instanceof Error ? cause.message : "实验读取失败。");
        if (!(cause instanceof EvaluationApiError && [401, 403, 404].includes(cause.status))) timer = window.setTimeout(() => { void refresh(); }, 4000);
      }
    }
    void refresh(); return () => { controller.abort(); window.clearTimeout(timer); };
  }, [client, scope, catalogState, selected, detailReload]);
  useEffect(() => {
    if (run && shouldScroll.current) { shouldScroll.current = false; results.current?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" }); }
    if (!trialChoice && run?.trials[0]) setTrialChoice({ caseId: run.trials[0].caseId, repetition: run.trials[0].repetition });
  }, [run, trialChoice]);
  useEffect(() => {
    if (!selected || !trialChoice || catalogState !== "ready") return;
    const controller = new AbortController(); setTrial(undefined); setTrialError("");
    void client.trial(selected, trialChoice.caseId, trialChoice.repetition, controller.signal).then(value => {
      if (!controller.signal.aborted && current()) setTrial(value.trial);
    }).catch(cause => { if (!controller.signal.aborted && current() && !denied(cause)) setTrialError("单题结果读取失败。"); });
    return () => controller.abort();
  }, [client, scope, catalogState, selected, trialChoice, trialReload]);
  async function action(fn: () => Promise<void>): Promise<void> {
    if (operation.current) return; operation.current = true; setBusy(true); setError("");
    try { await fn(); } catch (cause) { fail(cause); } finally { operation.current = false; if (current()) setBusy(false); }
  }
  async function recover(): Promise<void> {
    if (!receipt) return;
    await action(async () => {
      const data = await client.request<{ run: EvaluationView | null }>(`/requests/${encodeURIComponent(receipt.requestId)}`);
      if (!current()) return;
      if (data.run) { clearReceipt(); pick(data.run.id); setRun(data.run); setHistoryReload(value => value + 1); }
      else setError("未找到原实验。请保持原问题与设置，使用原编号重试。");
    });
  }
  function askStart(): void {
    if (busy || running || catalogState !== "ready" || !catalog?.liveAvailable) return;
    if (!cases.length) { input.current?.focus(); return; }
    if (draftError) { setError(draftError); return; }
    setError("");
    setConfirmation({ requestId: receipt?.requestId ?? crypto.randomUUID(), title: title.trim() || "Agent 稳定性评估", mode: "live", repetitions,
      maxModelCalls: maxCalls, maxTotalCalls: totalCalls, confirmPaid: true, cases: approvedEvaluationCases(cases) });
  }
  async function start(spec: EvaluationSpec): Promise<void> {
    if (operation.current) throw new Error("正在提交，请稍候。");
    operation.current = true; setBusy(true);
    try {
      const hash = await digest(spec);
      if (!current()) throw new Error("账号已变化，请重新进入评估。");
      if (receipt && receipt.digest !== hash) throw new Error("配置与原提交不同，请先查询原实验，勿重复创建。");
      const saved = { requestId: spec.requestId, digest: hash };
      sessionStorage.setItem(storageKey, JSON.stringify(saved)); setReceipt(saved);
      try {
        const value = await client.create(spec);
        if (!current()) return;
        clearReceipt(); pick(value.run.id); setRun(value.run); setOffset(0); setHistoryReload(value => value + 1);
      } catch (cause) {
        if (current()) { if (cause instanceof EvaluationApiError && [400, 413].includes(cause.status)) clearReceipt(); denied(cause); }
        throw cause;
      }
    } finally { operation.current = false; if (current()) setBusy(false); }
  }
  async function download(): Promise<void> {
    if (!run) return;
    await action(async () => {
      const report = await client.request<unknown>(`/runs/${encodeURIComponent(run.id)}/report`);
      if (!current()) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${run.id}.json`; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }

  return <section className="evaluation-workbench" aria-label="Agent 测试评估">
    <header className="evaluation-header"><h1>测试评估</h1><span className="eval-connection" data-ready={catalogState === "ready" && catalog?.liveAvailable || undefined}><WorkbenchIcon name="connection" />{catalogState === "loading" ? "连接中" : catalogState === "failed" || !catalog?.liveAvailable ? "服务未就绪" : "真实模型"}</span></header>
    {catalogState === "failed" && <div className="evaluation-error" role="alert"><p>{catalogError}</p><button type="button" onClick={() => setCatalogReload(value => value + 1)}>重新连接</button></div>}
    {error && <p className="evaluation-error" role="alert">{error}</p>}
    <div className="eval-workspace-grid">
      <form className="evaluation-compose eval-panel" onSubmit={event => { event.preventDefault(); askStart(); }}>
        <div className="eval-panel-heading"><h2><label htmlFor="evaluation-input">测试输入</label></h2><div className="eval-actions"><button type="button" className="eval-text-button" disabled={busy} onClick={() => { updateLines("列出我当前账号的赛事\n我有多少赛事素材"); input.current?.focus(); }}>填入示例</button>{!!lines && <button type="button" className="eval-text-button" disabled={busy} onClick={() => { updateLines(""); input.current?.focus(); }}>清空</button>}</div></div>
        <div className="eval-input-shell" data-invalid={!!draftError || undefined}>
          <textarea ref={input} id="evaluation-input" value={lines} onChange={event => updateLines(event.target.value)} rows={6} maxLength={60_000} disabled={busy} aria-describedby={`evaluation-input-hint${draftError ? " evaluation-input-error" : ""}`} aria-invalid={!!draftError} placeholder={"输入要测试的问题，一行一题\n例如：我有多少赛事素材"} />
          <div className="eval-input-meta"><span id="evaluation-input-hint">一行一题 · 最多 5 次执行</span><span id="evaluation-draft-count" role="status" aria-live="polite" aria-atomic="true">{cases.length} 题{cases.length > 0 && ` · ${totalTrials} 次执行`}</span></div>
        </div>
        {draftError && <p id="evaluation-input-error" className="eval-validation" role="alert">{draftError}</p>}
        <details className="eval-disclosure eval-settings"><summary><WorkbenchIcon name="settings" /><span>运行设置</span><small>{repetitions} 次/题 · 调用上限 {maxCallsText || "—"}</small><WorkbenchIcon name="chevron" /></summary>
          <div className="eval-settings-body">
            <label className="evaluation-field">实验名称<input value={title} maxLength={100} placeholder="Agent 稳定性评估" disabled={busy} onChange={event => setTitle(event.target.value)} /></label>
            <div className="evaluation-options"><label className="evaluation-field">每题重复次数<select aria-label="每题重复次数" value={repetitions} disabled={busy} onChange={event => setRepetitions(Number(event.target.value))}>{[1, 2, 3, 4, 5].map(number => <option key={number} value={number}>{number} 次</option>)}</select></label>
              <label className="evaluation-field">单题模型调用上限<input type="number" min={2} max={12} value={maxCallsText} disabled={busy} onChange={event => setMaxCallsText(event.target.value)} /></label></div>
            <p className="eval-caption">本批最多 {totalCalls} 次模型调用</p>
            {cases.length > 0 && <details className="eval-disclosure"><summary><span>核对条件（可选）</span><WorkbenchIcon name="chevron" /></summary><div className="eval-case-options">{cases.map((item, index) => <div className="eval-case-option" key={item.key}>
              <p className="eval-case-heading"><span className="eval-case-number">{index + 1}</span>{item.input}</p>
              <label className="evaluation-field">场景<select value={item.options.template} disabled={busy || !catalog} onChange={event => setOptions(previous => ({ ...previous, [item.key]: { ...item.options, template: event.target.value as CaseOptions["template"] } }))}>{(catalog?.templates ?? [{ id: "explore", name: "真实账号任务" }, { id: "saishi-materials", name: "真实赛事查询" }, { id: "memory-current", name: "真实记忆观察" }]).map(template => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>
              <label className="evaluation-field">预期结果<textarea rows={2} value={item.options.facts} disabled={busy} placeholder="选填，用于人工核对；一行一条" onChange={event => setOptions(previous => ({ ...previous, [item.key]: { ...item.options, facts: event.target.value } }))} /></label>
            </div>)}</div></details>}
          </div>
        </details>
        {receipt && <div className="evaluation-receipt" role="status"><span>上次提交结果待确认</span><button type="button" disabled={busy} onClick={() => { void recover(); }}>查询原实验</button></div>}
        <footer className="eval-submit-bar"><span className="eval-model" title={catalog?.model ?? "读取模型配置中"}><WorkbenchIcon name="connection" /><span>{catalog?.model ?? "连接模型中…"}</span></span><button type="submit" className="primary eval-start-button" disabled={busy || running || !cases.length || !!draftError || catalogState !== "ready" || !catalog?.liveAvailable}><WorkbenchIcon name="arrow" />{busy ? "提交中…" : running ? "实验运行中" : receipt ? "原编号重试" : "开始测试"}</button></footer>
      </form>
      <aside className="evaluation-history eval-panel" aria-labelledby="evaluation-history-title">
        <header className="eval-panel-heading"><h2 id="evaluation-history-title">历史实验</h2><button type="button" className="eval-icon-button" aria-label="刷新历史实验" title="刷新" disabled={busy || historyState === "loading" || catalogState !== "ready"} onClick={() => setHistoryReload(value => value + 1)}><WorkbenchIcon name="restore" /></button></header>
        {historyState === "failed" ? <div className="eval-empty" role="alert"><p>{historyError}</p><button type="button" onClick={() => setHistoryReload(value => value + 1)}>重试</button></div>
          : history.length === 0 ? <div className="eval-empty" role="status"><WorkbenchIcon name="book" /><p>{catalogState === "failed" ? "服务未连接" : historyState === "loading" ? "正在读取…" : "还没有实验"}</p></div>
            : <div className="evaluation-history-list" aria-busy={historyState === "loading"}>{history.map(item => <button type="button" key={item.id} className="evaluation-history-item" disabled={busy} aria-pressed={selected === item.id} onClick={() => pick(item.id)}><span className="eval-history-title">{item.title}</span><span className="eval-history-meta"><span data-state={item.status}>{evaluationStatus[item.status]} · {item.completed}/{item.planned}</span><time dateTime={item.createdAt}>{shortDate(item.createdAt)}</time></span></button>)}</div>}
        {(offset > 0 || history.length === 20) && <nav className="eval-pagination" aria-label="实验历史分页"><button type="button" disabled={offset === 0 || historyState === "loading"} onClick={() => setOffset(value => Math.max(0, value - 20))}>上一页</button><span>{Math.floor(offset / 20) + 1}</span><button type="button" disabled={history.length < 20 || historyState === "loading"} onClick={() => setOffset(value => value + 20)}>下一页</button></nav>}
      </aside>
    </div>
    <div ref={results} className="eval-results-anchor">
      {detailError && <div className="evaluation-error" role="alert"><p>{detailError}</p><button type="button" onClick={() => setDetailReload(value => value + 1)}>重新读取</button></div>}
      {selected && !run && !detailError && <div className="eval-panel eval-empty" role="status">正在读取实验…</div>}
      {run && <EvaluationResults run={run} trial={trial} choice={trialChoice} busy={busy} error={trialError} onChoose={setTrialChoice} onRetry={() => setTrialReload(value => value + 1)} onDownload={() => { void download(); }} onCancel={() => { void action(async () => { const value = await client.cancel(run.id); if (current()) { setRun(value); setDetailReload(n => n + 1); setHistoryReload(n => n + 1); } }); }} />}
    </div>
    {confirmation && <EvaluationStartDialog spec={confirmation} model={catalog?.model ?? null} onClose={() => setConfirmation(undefined)} onConfirm={() => start(confirmation)} />}
  </section>;
}
