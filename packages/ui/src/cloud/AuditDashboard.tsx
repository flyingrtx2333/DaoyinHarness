import type { AuditRunSummary } from "./evaluation-client.js";

const statuses = ["completed", "failed", "cancelled", "interrupted", "running"] as const;
const labels: Record<AuditRunSummary["status"], string> = { completed: "完成", failed: "失败", cancelled: "取消", interrupted: "中断", running: "执行中" };
const colors: Record<AuditRunSummary["status"], string> = { completed: "#177a4c", failed: "#b42318", cancelled: "#8893a5", interrupted: "#b54708", running: "#3864e8" };
const title = (run: AuditRunSummary): string => run.userMessage.replace(/^\[营火内置剪辑[^\]]*\]\s*/u, "") || "未命名任务";

export function AuditDashboard({ runs, hours, selected, onSelect }: {
  runs: readonly AuditRunSummary[]; hours: number; selected?: string; onSelect: (traceId: string) => void;
}): React.JSX.Element {
  // The existing endpoint returns at most 30 traces. Never label this sample as all tasks.
  const end = Date.now();
  const start = end - hours * 3_600_000;
  const buckets = Array.from({ length: 12 }, (_, index) => ({ start: start + index * (end - start) / 12, count: 0 }));
  for (const run of runs) {
    const index = Math.floor((Date.parse(run.startedAt) - start) / (end - start) * buckets.length);
    if (index >= 0 && index < buckets.length) buckets[index]!.count++;
  }
  const peak = Math.max(1, ...buckets.map(bucket => bucket.count));
  const counts = statuses.map(status => ({ status, count: runs.filter(run => run.status === status).length }));
  const total = runs.length;
  let offset = 0;
  const ranked = [...runs].sort((a, b) => (b.modelCalls + b.toolCalls) - (a.modelCalls + a.toolCalls)).slice(0, 5);
  const callPeak = Math.max(1, ...ranked.map(run => run.modelCalls + run.toolCalls));
  const time = (timestamp: number): string => new Date(timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  return <section className="audit-dashboard" aria-label="任务统计看板">
    <header><h2>运行总览</h2><span>近 {hours} 小时 · 已加载 {total} 条任务 · 最多最近 30 条追踪</span></header>
    <div className="audit-charts">
      <article className="audit-chart"><header><h3>任务趋势</h3><span>每 {hours * 5} 分钟</span></header>
        <div className="audit-trend" aria-label={`任务数量趋势，最高每时段 ${peak} 条`}>
          <span className="audit-axis-top">{peak}</span>
          <div className="audit-trend-bars">{buckets.map((bucket, index) => <div className="audit-trend-column" key={index}>
            <span className="audit-trend-count">{bucket.count || ""}</span>
            <div className="audit-trend-bar" style={{ height: `${bucket.count / peak * 100}%` }} title={`${time(bucket.start)}–${time(bucket.start + (end - start) / 12)}：${bucket.count} 条任务`} />
          </div>)}</div>
          <div className="audit-axis-labels"><span>{time(start)}</span><span>{time(start + (end - start) / 2)}</span><span>{time(end)}</span></div>
        </div>
        <details className="audit-chart-data"><summary>查看各时段数据</summary>{buckets.map((bucket, index) => <div key={index}><span>{time(bucket.start)}–{time(bucket.start + (end - start) / 12)}</span><strong>{bucket.count} 条</strong></div>)}</details>
      </article>
      <article className="audit-chart"><header><h3>任务状态</h3><span>按任务最终状态</span></header>
        <div className="audit-status-chart"><svg viewBox="0 0 120 120" role="img" aria-label={counts.map(item => `${labels[item.status]} ${item.count} 条`).join("，")}>
          <circle cx="60" cy="60" r="44" fill="none" stroke="var(--ui-line)" strokeWidth="12" />
          {counts.filter(item => item.count > 0).map(item => {
            const percent = item.count / total * 100;
            const current = offset; offset += percent;
            return <circle key={item.status} cx="60" cy="60" r="44" fill="none" stroke={colors[item.status]} strokeWidth="12" pathLength="100" strokeDasharray={`${percent} ${100 - percent}`} strokeDashoffset={-current} transform="rotate(-90 60 60)"><title>{labels[item.status]}：{item.count} 条</title></circle>;
          })}
          <text x="60" y="58" textAnchor="middle" className="audit-donut-total">{total}</text><text x="60" y="77" textAnchor="middle" className="audit-donut-label">条任务</text>
        </svg><div className="audit-status-legend">{counts.map(item => <div key={item.status}><span><i style={{ background: colors[item.status] }} />{labels[item.status]}</span><strong>{item.count}</strong><small>{total ? `${Math.round(item.count / total * 100)}%` : "—"}</small></div>)}</div></div>
      </article>
      <article className="audit-chart"><header><h3>调用量 TOP 5</h3><span>点击查看任务</span></header>
        <div className="audit-calls-legend"><span><i />模型调用</span><span><i />工具调用</span></div>
        <div className="audit-call-ranking">{ranked.map(run => <button type="button" aria-pressed={run.traceId === selected} key={run.traceId} onClick={() => onSelect(run.traceId)} title={`${title(run)} · ${run.modelCalls} 次模型 / ${run.toolCalls} 次工具`}>
          <span className="audit-rank-label">{title(run)}</span><span className="audit-rank-track"><i style={{ width: `${run.modelCalls / callPeak * 100}%` }} /><i style={{ width: `${run.toolCalls / callPeak * 100}%` }} /></span><span className="audit-rank-value">{run.modelCalls} / {run.toolCalls}</span>
        </button>)}</div>
      </article>
    </div>
  </section>;
}
