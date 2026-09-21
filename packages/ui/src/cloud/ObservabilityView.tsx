import { useEffect, useMemo, useState } from "react";
import type { AgentEvent } from "@daoyin/harness-protocol";
import type { AuditRunSummary, EvaluationClient, ObservabilitySummary } from "./evaluation-client.js";
import "./audit.css";

const statusLabel: Record<AuditRunSummary["status"], string> = { running: "执行中", completed: "完成", failed: "失败", cancelled: "已取消", interrupted: "已中断" };
const eventLabel: Partial<Record<AgentEvent["type"], string>> = {
  "turn.started": "用户提问", "capability.routed": "能力路由", "model.requested": "模型请求", "model.responded": "模型响应",
  "assistant.delta": "回复正文", "assistant.commentary": "执行说明", "phase.updated": "阶段变化", "tool.started": "工具调用",
  "tool.progress": "工具进度", "tool.completed": "工具结果", "tool.failed": "工具失败", "interaction.requested": "等待确认",
  "interaction.resolved": "确认结果", "turn.completed": "任务完成", "turn.failed": "任务失败", "turn.cancelled": "任务取消", "turn.interrupted": "任务中断",
};
const duration = (value: number | null): string => value === null ? "—" : value < 1000 ? `${Math.round(value)} 毫秒` : `${(value / 1000).toFixed(2)} 秒`;
const clip = (value: string, limit = 120): string => value.length <= limit ? value : `${value.slice(0, limit)}…`;

function eventSummary(event: AgentEvent): string {
  switch (event.type) {
    case "turn.started": return clip(event.payload.userMessage);
    case "model.requested": return `第 ${event.payload.callIndex} 次 · ${event.payload.messages.length} 条消息 · ${event.payload.tools.length} 个工具${event.payload.truncated ? " · 内容已截断" : ""}`;
    case "model.responded": {
      const reply = event.payload.reply as { kind?: unknown; content?: unknown; calls?: unknown[] } | undefined;
      if (event.payload.status !== "completed") return `${event.payload.failureCode ?? "失败"} · ${event.payload.failureMessage ?? "模型请求未完成"}`;
      if (reply?.kind === "tool_calls") return `第 ${event.payload.callIndex} 次 · 发起 ${reply.calls?.length ?? 0} 个工具调用 · ${duration(event.payload.latencyMs)}`;
      return `第 ${event.payload.callIndex} 次 · ${clip(typeof reply?.content === "string" ? reply.content : "返回公开正文")} · ${duration(event.payload.latencyMs)}`;
    }
    case "assistant.delta": return clip(event.payload.delta);
    case "assistant.commentary": return clip(event.payload.text);
    case "phase.updated": return event.payload.displayText;
    case "tool.started": return `${event.payload.displayName ?? event.payload.toolName} · ${clip(JSON.stringify(event.payload.input ?? {}))}`;
    case "tool.progress": return `${event.payload.displayName ?? event.payload.toolName} · ${event.payload.displayText}`;
    case "tool.completed": return `${event.payload.displayName ?? event.payload.toolName} · ${event.payload.summary}`;
    case "tool.failed": return `${event.payload.displayName ?? event.payload.toolName} · ${event.payload.code} · ${event.payload.message}`;
    case "capability.routed": return `${event.payload.selectedPackIds.join("、") || "未选择能力包"} · 暴露 ${event.payload.exposedToolCount} 个工具`;
    case "turn.completed": case "turn.failed": return clip(event.payload.outcomeSummary);
    case "turn.cancelled": return `最后完成事件 #${event.payload.lastCompletedEventSeq}`;
    case "turn.interrupted": return event.payload.reason;
    case "interaction.requested": return `${event.payload.kind} · ${event.payload.operation}`;
    case "interaction.resolved": return event.payload.resolution;
  }
}

export function ObservabilityView({ client }: { client: EvaluationClient }): React.JSX.Element {
  const [hours, setHours] = useState<1 | 6 | 24>(1);
  const [revision, setRevision] = useState(0);
  const [metrics, setMetrics] = useState<ObservabilitySummary>();
  const [runs, setRuns] = useState<AuditRunSummary[]>([]);
  const [selected, setSelected] = useState<string>();
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    const controller = new AbortController(); setState("loading");
    void Promise.all([client.observabilitySummary(hours, controller.signal), client.auditRuns(hours, controller.signal)])
      .then(([nextMetrics, audit]) => { if (controller.signal.aborted) return; setMetrics(nextMetrics); setRuns(audit.runs); setState("ready");
        setSelected(current => current && audit.runs.some(item => item.traceId === current) ? current : audit.runs[0]?.traceId); })
      .catch(() => { if (!controller.signal.aborted) setState("failed"); });
    return () => controller.abort();
  }, [client, hours, revision]);

  useEffect(() => {
    if (!selected) { setEvents([]); return; }
    const controller = new AbortController();
    void client.auditRun(selected, controller.signal).then(value => { if (!controller.signal.aborted) setEvents(value.events); })
      .catch(() => { if (!controller.signal.aborted) setEvents([]); });
    return () => controller.abort();
  }, [client, selected, revision]);

  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") setRevision(value => value + 1); }, 5_000);
    return () => window.clearInterval(timer);
  }, []);

  const selectedRun = runs.find(run => run.traceId === selected);
  const ordered = useMemo(() => [...events].sort((left, right) => left.eventSeq - right.eventSeq), [events]);
  return <section className="observability-view" aria-label="任务审计记录">
    <header className="observability-header"><div className="observability-actions" role="group" aria-label="查看时间范围">
      {([1, 6, 24] as const).map(value => <button type="button" aria-pressed={hours === value} onClick={() => setHours(value)} key={value}>近 {value} 小时</button>)}
      <button type="button" onClick={() => setRevision(value => value + 1)} disabled={state === "loading"}>刷新</button>
    </div></header>
    {state === "failed" && <p className="observability-state" role="alert">审计记录读取失败，请刷新重试。</p>}
    {metrics && <div className="observability-metrics"><article><span>任务次数</span><strong>{metrics.traces}</strong></article><article><span>失败率</span><strong>{(metrics.errorRate * 100).toFixed(metrics.errorRate ? 1 : 0)}%</strong></article><article><span>通常完成时间</span><strong>{duration(metrics.p50Ms)}</strong></article><article><span>95% 完成时间</span><strong>{duration(metrics.p95Ms)}</strong></article></div>}
    {state === "loading" && runs.length === 0 && <p className="observability-state" role="status">正在读取审计记录…</p>}
    {state === "ready" && runs.length === 0 && <p className="observability-state">当前时间范围内还没有新的完整审计记录。</p>}
    {runs.length > 0 && <div className="observability-layout audit-layout">
      <section className="observability-panel"><h2>最近任务</h2><div className="trace-list">{runs.map(run => <button type="button" className="trace-row audit-run-row" aria-current={selected === run.traceId ? "true" : undefined} onClick={() => setSelected(run.traceId)} key={run.traceId}>
        <span data-status={run.status === "completed" ? "ok" : run.status === "running" ? "running" : "error"}>{statusLabel[run.status]}</span><strong>{clip(run.userMessage, 56)}</strong><time dateTime={run.startedAt}>{new Date(run.startedAt).toLocaleString("zh-CN")}</time><small>{run.modelCalls} 次模型 · {run.toolCalls} 次工具 · {run.eventCount} 条事件</small>
      </button>)}</div></section>
      <section className="observability-panel audit-detail"><header><h2>逐轮审计</h2>{selectedRun && <small>Run {selectedRun.runId} · 用户 {selectedRun.accountId}</small>}</header>
        {ordered.map(event => <details className="audit-event" key={event.id} open={event.type === "turn.started" || event.type === "model.responded" || event.type === "tool.completed" || event.type === "tool.failed"}>
          <summary><span className="audit-seq">#{event.eventSeq}</span><strong>{eventLabel[event.type] ?? event.type}</strong><span>{eventSummary(event)}</span><time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleTimeString("zh-CN")}</time></summary>
          <div className="audit-event-body"><div><code>{event.type}</code><code>{event.id}</code></div><pre>{JSON.stringify(event.payload, null, 2)}</pre><button type="button" onClick={() => void navigator.clipboard.writeText(JSON.stringify(event, null, 2))}>复制完整记录</button></div>
        </details>)}
      </section>
    </div>}
  </section>;
}
