import { useEffect, useRef, useState } from "react";
import { MarkdownMessage } from "../MarkdownMessage.js";
import { EvaluationApiError, type Catalog, type EvaluationCase, type EvaluationClient, type EvaluationSpec, type EvaluationView, type HistoryItem, type Trial } from "./evaluation-client.js";

const status: Record<string, string> = { running: "执行中", cancelling: "停止中", completed: "执行结束", cancelled: "已停止", interrupted: "已中断", failed: "执行异常",
  passed: "通过", review: "待复核", judge_error: "判分失败" };
const percent = (value: number | null): string => value === null ? "未测" : `${(value * 100).toFixed(1)}%`;
const moment = (value: string): string => new Date(value).toLocaleString("zh-CN", { hour12: false });
interface Receipt { requestId: string; digest: string }
async function digest(spec: EvaluationSpec): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(spec)));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
}
export function EvaluationWorkbench({ client, onDenied }: { client: EvaluationClient; onDenied(): void }): React.JSX.Element {
  const [catalog, setCatalog] = useState<Catalog>();
  const [lines, setLines] = useState(""); const [cases, setCases] = useState<EvaluationCase[]>([]);
  const [title, setTitle] = useState("Agent 稳定性评估");
  const [mode, setMode] = useState<"replay" | "live">("replay");
  const [repetitions, setRepetitions] = useState(3); const [maxCalls, setMaxCalls] = useState(8);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [history, setHistory] = useState<HistoryItem[]>([]); const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState(""); const [run, setRun] = useState<EvaluationView>();
  const [trial, setTrial] = useState<Trial>(); const [trialChoice, setTrialChoice] = useState<{ caseId: string; repetition: number }>();
  const [receipt, setReceipt] = useState<Receipt>(); const [reload, setReload] = useState(0);
  const mounted = useRef(true); const operation = useRef(false);
  const scope = client.scope; const storageKey = `daoyin-evaluation-receipt:${scope}`;
  const selectedKey = `daoyin-evaluation-selected:${scope}`;
  const totalCalls = Math.max(1, cases.length * repetitions * (maxCalls + 1));
  const running = run?.status === "running" || run?.status === "cancelling";
  function fail(cause: unknown): void {
    if (!mounted.current) return;
    if (cause instanceof EvaluationApiError && [401, 403].includes(cause.status)) { setRun(undefined); setTrial(undefined); setCases([]); setHistory([]); onDenied(); return; }
    setError(cause instanceof Error ? cause.message : "评估请求未完成。");
  }
  function pick(id: string): void { setSelected(id); setRun(undefined); setTrial(undefined); setTrialChoice(undefined); setError(""); try { sessionStorage.setItem(selectedKey, id); } catch { /* Optional selection history. */ } }
  function clearReceipt(): void { setReceipt(undefined); try { sessionStorage.removeItem(storageKey); } catch { /* Server idempotency remains authoritative. */ } }
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void client.catalog(controller.signal).then(value => { if (!controller.signal.aborted) setCatalog(value); }).catch(cause => { if (!controller.signal.aborted) fail(cause); });
    try {
      const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey) || "null");
      if (saved && typeof saved === "object" && "requestId" in saved && "digest" in saved && typeof saved.requestId === "string" && typeof saved.digest === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(saved.requestId) && /^[a-f0-9]{64}$/u.test(saved.digest)) setReceipt({ requestId: saved.requestId, digest: saved.digest });
      const id = sessionStorage.getItem(selectedKey); if (id && /^ev_[a-f0-9]{32}$/u.test(id)) setSelected(id);
    } catch { /* Invalid receipts are never submitted. */ }
    return () => { mounted.current = false; controller.abort(); };
  }, [client, scope]);
  useEffect(() => {
    const controller = new AbortController();
    void client.history(offset, controller.signal).then(data => { if (!controller.signal.aborted) setHistory(data.runs); }).catch(error => { if (!controller.signal.aborted) fail(error); });
    return () => controller.abort();
  }, [client, offset, reload]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController(); let timer: number | undefined;
    async function refresh(): Promise<void> {
      try {
        const result = await client.detail(selected, controller.signal);
        if (controller.signal.aborted) return;
        setRun(result);
        if (result.status === "running" || result.status === "cancelling") timer = window.setTimeout(() => { void refresh(); }, 1500);
      } catch (cause) { if (!controller.signal.aborted) { fail(cause); if (!(cause instanceof EvaluationApiError && [401, 403, 404].includes(cause.status))) timer = window.setTimeout(() => { void refresh(); }, 4000); } }
    }
    void refresh();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [client, selected, reload]);
  useEffect(() => {
    if (!trialChoice && run?.trials[0]) {
      setTrialChoice({ caseId: run.trials[0].caseId, repetition: run.trials[0].repetition });
    }
  }, [run, trialChoice]);
  useEffect(() => {
    if (!selected || !trialChoice) return;
    const controller = new AbortController(); setTrial(undefined);
    void client.trial(selected, trialChoice.caseId, trialChoice.repetition, controller.signal).then(result => { if (!controller.signal.aborted) setTrial(result.trial); }).catch(error => { if (!controller.signal.aborted) fail(error); });
    return () => controller.abort();
  }, [client, selected, trialChoice]);
  async function action(fn: () => Promise<void>): Promise<void> {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError("");
    try { await fn(); } catch (cause) { fail(cause); }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  }
  async function prepare(): Promise<void> {
    await action(async () => { const values = await client.prepare(lines); if (mounted.current) { setCases(values); setConfirmed(false); } });
  }
  function updateCase(index: number, patch: Partial<EvaluationCase>): void {
    setCases(current => current.map((item, i) => i === index ? { ...item, ...patch, approved: patch.approved ?? false } : item)); setConfirmed(false);
  }
  async function recover(): Promise<void> {
    if (!receipt) return;
    await action(async () => {
      const data = await client.request<{ run: EvaluationView | null }>(`/requests/${encodeURIComponent(receipt.requestId)}`);
      if (!mounted.current) return;
      if (data.run) { clearReceipt(); pick(data.run.id); setRun(data.run); setReload(n => n + 1); }
      else setError("尚未查到原实验。请保留原配置再次提交；页面刷新后需重新导入相同问题和参数，系统将核对摘要并沿用原编号。");
    });
  }
  async function start(): Promise<void> {
    await action(async () => {
      const spec: EvaluationSpec = { requestId: receipt?.requestId ?? crypto.randomUUID(), title, mode, repetitions, maxModelCalls: maxCalls,
        maxTotalCalls: totalCalls, confirmPaid: mode === "live" && confirmed, cases };
      const hash = await digest(spec);
      if (receipt && receipt.digest !== hash) throw new Error("原提交结果尚未确认，不能用新配置重复创建。请先恢复原实验，或重新输入完全相同的配置。");
      const nextReceipt = { requestId: spec.requestId, digest: hash };
      // Only a request ID and digest are retained, never prompts, answers or credentials.
      sessionStorage.setItem(storageKey, JSON.stringify(nextReceipt)); setReceipt(nextReceipt);
      try {
        const result = await client.create(spec);
        if (!mounted.current) return;
        clearReceipt(); pick(result.run.id); setRun(result.run); setReload(n => n + 1);
      } catch (cause) {
        if (cause instanceof EvaluationApiError && [400, 413].includes(cause.status)) clearReceipt();
        throw cause;
      }
    });
  }
  async function download(): Promise<void> {
    if (!run) return;
    await action(async () => {
      const result = await client.request<unknown>(`/runs/${encodeURIComponent(run.id)}/report`);
      if (!mounted.current) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${run.id}.json`; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  return <section className="evaluation-workbench" aria-label="Agent 测试评估">
    <header className="evaluation-header"><h1>测试评估</h1><span>超级管理员</span></header>
    <p className="evaluation-scope">被测对象：共享云端接口、Agent 内核、工具与记忆。业务使用隔离测试数据，不是生产全链路验收。请仅导入已脱敏的用户输入。</p>
    {error && <p className="evaluation-error" role="alert">{error}</p>}
    {!catalog ? <p role="status">正在读取评估配置…</p> : <>
      <section className="evaluation-compose" aria-labelledby="evaluation-new">
        <div className="evaluation-section-heading"><h2 id="evaluation-new">新建实验</h2><small>{catalog.revision ? `版本 ${catalog.revision.slice(0, 8)}` : "构建版本未记录"}</small></div>
        <label className="evaluation-field">实验名称<input value={title} maxLength={100} onChange={event => { setTitle(event.target.value); setConfirmed(false); }} disabled={busy} /></label>
        <label className="evaluation-field">真实用户输入<textarea rows={5} maxLength={60_000} placeholder={"查询我的赛事素材处理状态\n我之前说的视频画幅是什么"} value={lines} onChange={event => setLines(event.target.value)} disabled={busy} /></label>
        <div className="evaluation-toolbar"><small>一行一题，最多 50 题；上下文依赖的多轮问题暂不自动拆分。</small><div className="evaluation-toolbar"><button type="button" disabled={busy} onClick={() => { setLines("查询我的赛事素材处理状态\n我之前说的视频画幅是什么"); setCases([]); setConfirmed(false); }}>填入示例</button><button type="button" disabled={busy || !lines.trim()} onClick={() => { void prepare(); }}>整理用例</button></div></div>
        {cases.length > 0 && <div className="evaluation-cases">
          <div className="evaluation-section-heading"><h2>确认场景与成功条件</h2><div className="evaluation-toolbar"><span>{cases.filter(c => c.approved).length}/{cases.length} 已确认</span><button type="button" disabled={busy || cases.every(c => c.approved)} onClick={() => { setCases(current => current.map(item => ({ ...item, approved: true }))); setConfirmed(false); }}>已核对，确认全部</button></div></div>
          {cases.map((item, index) => <details key={item.id} className="evaluation-case" open={!item.approved}>
            <summary><span>{index + 1}. {item.input}</span><small>{item.approved ? "已确认" : "待确认"}</small></summary>
            <label className="evaluation-field">问题<input value={item.input} maxLength={2000} disabled={busy} onChange={event => updateCase(index, { input: event.target.value })} /></label>
            <label className="evaluation-field">测试场景<select value={item.template} disabled={busy} onChange={event => { const template = catalog.templates.find(t => t.id === event.target.value)!; updateCase(index, { template: template.id, expectedFacts: [...template.facts] }); }}>{catalog.templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
            <p className="evaluation-fixture">{catalog.templates.find(t => t.id === item.template)?.fixture}</p>
            <label className="evaluation-field">成功条件（每行一项）<textarea rows={3} disabled={busy} value={item.expectedFacts.join("\n")} onChange={event => updateCase(index, { expectedFacts: event.target.value.split("\n").filter(line => line.trim()) })} /></label>
            <label className="evaluation-check"><input type="checkbox" checked={item.approved} disabled={busy} onChange={event => updateCase(index, { approved: event.target.checked })} />确认该场景和成功条件适用于这道题</label>
          </details>)}
        </div>}
        <div className="evaluation-options">
          <label className="evaluation-field">执行方式<select aria-label="执行方式" value={mode} disabled={busy} onChange={event => { setMode(event.target.value as "live" | "replay"); setConfirmed(false); }}><option value="replay">程序回放（非真实模型）</option><option value="live" disabled={!catalog.liveAvailable}>真实模型＋隔离数据{catalog.liveAvailable ? "" : "（未配置）"}</option></select></label>
          <label className="evaluation-field">每题重复次数<select aria-label="每题重复次数" value={repetitions} disabled={busy} onChange={event => { setRepetitions(Number(event.target.value)); setConfirmed(false); }}>{[1, 2, 3, 4, 5].map(n => <option key={n}>{n}</option>)}</select></label>
          <label className="evaluation-field">每题模型调用上限<input type="number" min={2} max={12} value={maxCalls} disabled={busy} onChange={event => { setMaxCalls(Number(event.target.value)); setConfirmed(false); }} /></label>
        </div>
        {mode === "replay" ? <p className="evaluation-fixture">回放回复来自固定脚本，只检查协议与已配置的硬性条件，不证明真实模型任务能力。</p> : <>
          <p className="evaluation-fixture">模型：{catalog.model}；判分模型：{catalog.judgeModel}。总调用上限 {totalCalls} 次，含每次试验最多一次判分。调用次数不是金额硬上限，实际费用待供应商核算。</p>
          <label className="evaluation-check"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />确认使用专用评估模型并承担本批费用</label>
        </>}
        {receipt && <div className="evaluation-receipt" role="status"><span>上次提交结果待确认，未自动重复执行。</span><button type="button" disabled={busy} onClick={() => { void recover(); }}>恢复原实验</button></div>}
        <div className="evaluation-toolbar"><span>{cases.length} 题 × {repetitions} 次，共 {cases.length * repetitions} 次试验</span><button type="button" className="primary" disabled={busy || !cases.length || cases.some(c => !c.approved) || !title.trim() || !Number.isInteger(maxCalls) || maxCalls < 2 || maxCalls > 12 || (mode === "live" && (!confirmed || !catalog.liveAvailable))} onClick={() => { void start(); }}>{busy ? "处理中…" : receipt ? "沿用原编号提交" : "开始测试"}</button></div>
      </section>
      <section className="evaluation-history" aria-labelledby="evaluation-history-title">
        <div className="evaluation-section-heading"><h2 id="evaluation-history-title">历史实验</h2><button type="button" disabled={busy} onClick={() => setReload(n => n + 1)}>刷新</button></div>
        {history.length === 0 ? <p className="muted">暂无实验</p> : <div className="evaluation-history-list">{history.map(item => <button type="button" key={item.id} className="evaluation-history-item" aria-pressed={selected === item.id} onClick={() => pick(item.id)}><span>{item.title}</span><small>{item.mode === "live" ? "真实模型" : "程序回放"} · {status[item.status]} · {item.completed}/{item.planned}</small><time>{moment(item.createdAt)}</time></button>)}</div>}
        <div className="evaluation-toolbar"><button type="button" disabled={offset === 0} onClick={() => setOffset(n => Math.max(0, n - 20))}>上一页</button><button type="button" disabled={history.length < 20} onClick={() => setOffset(n => n + 20)}>下一页</button></div>
      </section>
    </>}
    {run && <section className="evaluation-results" aria-labelledby="evaluation-result-title">
      <div className="evaluation-section-heading"><h2 id="evaluation-result-title">{run.spec.title}</h2><div className="evaluation-toolbar">{running && <button type="button" disabled={busy || run.status === "cancelling"} onClick={() => { void action(async () => { const result = await client.cancel(run.id); if (mounted.current) { setRun(result); setReload(n => n + 1); } }); }}>停止实验</button>}<button type="button" disabled={busy} onClick={() => { void download(); }}>导出报告</button></div></div>
      <p className="evaluation-fixture">{run.spec.mode === "replay" ? "程序回放（预设回复，非 AI 现场生成）" : `真实模型：${run.model}`} · {status[run.status]} · {run.completed}/{run.planned}</p>
      <progress value={run.completed} max={run.planned} aria-label="实际完成试验数" />
      {run.active && <p role="status">{run.active.caseId} · 第 {run.active.repetition} 次 · {run.active.stage}</p>}
      <div className="evaluation-metrics">
        <div><span>{run.spec.mode === "live" ? "已验证成功 / 全部计划" : "协议检查通过 / 全部计划"}</span><strong>{percent(run.spec.mode === "live" ? run.metrics.verifiedSuccessRate : run.metrics.protocolPassRate)}</strong></div>
        <div><span>同题 {run.spec.repetitions} 次全部通过</span><strong>{percent(run.metrics.repeatAllPassRate)}</strong></div>
        <div><span>记忆召回（{run.metrics.recallSamples} 次已测）</span><strong>{percent(run.metrics.meanRecall)}</strong></div>
        <div><span>模型 / 判分调用</span><strong>{run.dispatchedCalls.agent} / {run.dispatchedCalls.judge}</strong></div>
      </div>
      <p className="evaluation-fixture">失败 {run.metrics.failed} 次，待复核或判分失败 {run.metrics.review} 次，未执行 {run.metrics.notRun} 次。部分实验不会因未执行项被移除而提高通过率；当前不计算真实扣费金额。</p>
      <div className="evaluation-table-scroll"><table><thead><tr><th>问题</th><th>逐次判定</th><th>耗时</th></tr></thead><tbody>{run.spec.cases.map((item, index) => {
        const samples = run.trials.filter(t => t.caseId === item.id);
        return <tr key={item.id}><td>{index + 1}. {item.input}</td><td><div className="evaluation-repetitions">{Array.from({ length: run.spec.repetitions }, (_, n) => {
          const sample = samples.find(t => t.repetition === n + 1);
          return <button key={n} type="button" disabled={!sample} className={sample ? `verdict-${sample.verdict}` : ""} aria-label={`${item.id} 第${n + 1}次 ${sample ? status[sample.verdict] ?? sample.verdict : "未执行"}`} onClick={() => setTrialChoice({ caseId: item.id, repetition: n + 1 })}>{n + 1} · {sample ? (sample.verdict === "failed" ? "不通过" : status[sample.verdict]) : "未执行"}</button>;
        })}</div></td><td>{samples.length ? `${(samples.reduce((sum, t) => sum + t.durationMs, 0) / samples.length / 1000).toFixed(1)} 秒/次` : "—"}</td></tr>;
      })}</tbody></table></div>
      {trial && <article className="evaluation-trial" aria-label="单次测试证据">
        <h3>{trial.caseId} · 第 {trial.repetition} 次 · {trial.verdict === "failed" ? "不通过" : status[trial.verdict]}</h3>
        <p>任务状态：{status[trial.runStatus] ?? trial.runStatus}；验收判定：{trial.verdict === "failed" ? "不通过" : status[trial.verdict]}</p>
        {trial.errorCode && <p className="evaluation-error">错误代码：{trial.errorCode}</p>}
        <h3>{run.spec.mode === "replay" ? "预设回放回复（非真实模型）" : "实际模型回复"}</h3><div className="markdown">{trial.answer ? <MarkdownMessage text={trial.answer} /> : <p className="muted">没有完成的回复</p>}</div>
        <h3>逐项核验</h3><ul className="evaluation-checks">{trial.checks.map((check, index) => <li key={index}><strong>{check.passed === true ? "通过" : check.passed === false ? "不通过" : "未确认"} · {check.name}</strong><p>{check.detail}</p></li>)}</ul>
        <details><summary>工具与调用证据</summary>{trial.tools.map((tool, index) => <p key={index}>{tool.name} · {tool.status} · {tool.summary}</p>)}<p>模型 {trial.modelCalls} 次；判分 {trial.judgeCalls} 次；输入 / 输出 Token {trial.inputTokens ?? "未记录"} / {trial.outputTokens ?? "未记录"}；首段观测 {trial.firstTextMs === null ? "未记录" : `${trial.firstTextMs} 毫秒`}。</p><p>记忆引用：{trial.retrievedMemoryIds.join("、") || "无"}</p></details>
      </article>}
    </section>}
  </section>;
}
