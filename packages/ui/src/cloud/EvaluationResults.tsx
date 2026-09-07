import type { EvaluationView, Trial } from "./evaluation-client.js";
import { MarkdownMessage } from "../MarkdownMessage.js";
import { WorkbenchIcon } from "./WorkbenchIcon.js";

export const evaluationStatus: Record<string, string> = {
  running: "运行中", cancelling: "停止中", completed: "已结束", cancelled: "已停止", interrupted: "已中断", failed: "执行失败",
  passed: "通过", review: "待复核", judge_error: "判分失败", not_started: "未开始", unknown: "未确认",
};
export interface TrialChoice { caseId: string; repetition: number }
const seconds = (value: number): string => `${(value / 1000).toFixed(1)} 秒`;

export function EvaluationResults({ run, trial, choice, busy, error, onChoose, onCancel, onDownload, onRetry }: {
  run: EvaluationView; trial: Trial | undefined; choice: TrialChoice | undefined; busy: boolean; error: string;
  onChoose(value: TrialChoice): void; onCancel(): void; onDownload(): void; onRetry(): void;
}): React.JSX.Element {
  const active = run.status === "running" || run.status === "cancelling";
  const completed = run.trials.filter(item => item.runStatus === "completed").length;
  const mean = run.trials.length ? run.trials.reduce((total, item) => total + item.durationMs, 0) / run.trials.length : null;
  const selectedCase = run.spec.cases.find(item => item.id === choice?.caseId);
  return <section className="evaluation-results eval-panel" aria-labelledby="evaluation-result-title">
    <header className="eval-panel-heading">
      <div className="eval-heading-copy"><h2 id="evaluation-result-title">{run.spec.title}</h2><span className="eval-caption">{run.completed}/{run.planned} 次已结束</span></div>
      <div className="eval-actions"><span className="eval-badge" data-state={run.status}>{evaluationStatus[run.status]}</span>
        {active && <button type="button" disabled={busy || run.status === "cancelling"} onClick={onCancel}><WorkbenchIcon name="stop" />停止</button>}
        <button type="button" disabled={busy} onClick={onDownload}>导出报告</button></div>
    </header>
    {active && <div className="eval-progress"><progress value={run.completed} max={run.planned} aria-label="已结束试验数" /><span role="status">{run.active ? `第 ${run.active.repetition} 次 · ${run.active.stage}` : "正在等待任务状态"}</span></div>}
    <div className="evaluation-metrics">
      <div><span>任务完成</span><strong>{completed}<small> / {run.planned}</small></strong></div>
      <div><span>待复核</span><strong>{run.metrics.review}<small> 次</small></strong></div>
      <div><span>平均耗时</span><strong>{mean === null ? "—" : seconds(mean)}</strong></div>
      <div><span>模型调用</span><strong>{run.dispatchedCalls.agent}<small> 次</small></strong>{run.trials.some(item => item.modelCallsKnown === false) && <span>部分未确认</span>}</div>
    </div>
    <div className="eval-result-layout">
      <nav className="eval-result-cases" aria-label="选择测试结果">
        {run.spec.cases.map((item, index) => <div className="eval-result-case" key={item.id}>
          <p><span className="eval-case-number">{index + 1}</span><span>{item.input}</span></p>
          <div className="eval-repetitions">{Array.from({ length: run.spec.repetitions }, (_, n) => {
            const sample = run.trials.find(value => value.caseId === item.id && value.repetition === n + 1);
            const current = choice?.caseId === item.id && choice.repetition === n + 1;
            return <button type="button" key={n} disabled={!sample} aria-pressed={current} data-state={sample?.verdict} onClick={() => onChoose({ caseId: item.id, repetition: n + 1 })}>
              {run.spec.repetitions > 1 && `${n + 1} · `}{sample ? evaluationStatus[sample.verdict] : "未结束"}
            </button>;
          })}</div>
        </div>)}
      </nav>
      <article className="evaluation-trial" aria-label="单次测试结果">
        {error ? <div className="evaluation-error" role="alert"><p>{error}</p><button type="button" onClick={onRetry}>重新读取</button></div>
          : !trial ? <div className="eval-empty" role="status"><WorkbenchIcon name="chat" /><p>{choice ? "正在读取结果…" : active ? "任务执行中，结果将在这里出现" : "暂无单题结果"}</p></div>
          : <>
            <header className="eval-trial-heading"><h3>实际回复</h3><span className="eval-badge" data-state={trial.verdict}>{evaluationStatus[trial.verdict]}</span><span className="eval-caption">{seconds(trial.durationMs)}</span></header>
            {trial.errorCode && <p className="evaluation-error" role="alert">{trial.errorCode}</p>}
            {run.spec.mode === "replay" && <p className="eval-caption">历史回放记录，非真实模型回复。</p>}
            <div className="markdown">{trial.answer ? <MarkdownMessage text={trial.answer} /> : <p className="eval-caption">任务未生成完整回复。</p>}</div>
            <details className="eval-disclosure"><summary><span>核对与执行记录</span><WorkbenchIcon name="chevron" /></summary>
              <div className="eval-evidence">
                {selectedCase?.expectedFacts.length ? <section><h4>核对条件</h4>{selectedCase.expectedFacts.map((fact, index) => <p key={index}>{fact}</p>)}</section> : null}
                <section><h4>逐项核验</h4>{trial.checks.map((check, index) => <div className="eval-check-result" key={index}><strong>{check.passed === true ? "通过" : check.passed === false ? "失败" : "待复核"} · {check.name}</strong><p>{check.detail}</p></div>)}</section>
                <section><h4>工具调用</h4>{trial.tools.length ? trial.tools.map((tool, index) => <p key={index}><code>{tool.name}</code> · {tool.status === "completed" ? "完成" : "失败"} · {tool.summary}</p>) : <p>无工具调用记录</p>}</section>
                <dl className="eval-evidence-fields"><dt>任务状态</dt><dd>{evaluationStatus[trial.runStatus] ?? trial.runStatus}</dd>
                  <dt>模型调用</dt><dd>{trial.modelCallsKnown === false ? "未确认" : `${trial.modelCalls} 次`}</dd><dt>输入 / 输出 Token</dt><dd>{trial.inputTokens ?? "未记录"} / {trial.outputTokens ?? "未记录"}</dd>
                  <dt>首段观测</dt><dd>{trial.firstTextMs === null ? "未记录" : `${trial.firstTextMs} 毫秒`}</dd><dt>记忆召回</dt><dd>{trial.recall === null ? "未测（无真值核对）" : `${(trial.recall * 100).toFixed(0)}%`}</dd>
                  {trial.retrievedMemoryIds.length > 0 && <><dt>记忆引用</dt><dd>{trial.retrievedMemoryIds.join("、")}</dd></>}
                  {trial.runId && <><dt>任务编号</dt><dd><code>{trial.runId}</code></dd></>}{trial.sessionId && <><dt>会话编号</dt><dd><code>{trial.sessionId}</code></dd></>}
                  <dt>模型</dt><dd>{trial.modelName ?? run.model ?? "未记录"}</dd><dt>运行时版本</dt><dd>{trial.runtimeRevision ?? "未记录"}</dd>
                  <dt>费用</dt><dd>未聚合结算金额</dd></dl>
              </div>
            </details>
          </>}
      </article>
    </div>
    <details className="eval-disclosure eval-report-meta"><summary><span>实验信息</span><WorkbenchIcon name="chevron" /></summary><dl className="eval-evidence-fields">
      <dt>实验编号</dt><dd><code>{run.id}</code></dd><dt>创建时间</dt><dd><time dateTime={run.createdAt}>{new Date(run.createdAt).toLocaleString("zh-CN", { hour12: false })}</time></dd><dt>评估版本</dt><dd>{run.revision ?? "未记录"}</dd>
      <dt>失败 / 未执行</dt><dd>{run.metrics.failed} / {run.metrics.notRun}</dd><dt>证据范围</dt><dd>任务完成不等于业务正确。业务条件待复核，无真值时召回率未测。</dd>
      {run.runtimeHandles?.map(handle => <div className="eval-handle" key={`${handle.caseId}:${handle.repetition}`}><dt>{handle.caseId} · {handle.repetition}</dt><dd>{handle.runId ?? "任务回执未确认"}<br />{handle.sessionId}<br />{handle.requestId}</dd></div>)}
    </dl></details>
  </section>;
}
