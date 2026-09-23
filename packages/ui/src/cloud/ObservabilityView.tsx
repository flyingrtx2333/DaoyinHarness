import { useEffect, useMemo, useState } from "react";
import type { AgentEvent } from "@daoyin/harness-protocol";
import type { AuditRunSummary, EvaluationClient, ObservabilitySummary } from "./evaluation-client.js";
import "./audit.css";

const statusLabel: Record<AuditRunSummary["status"], string> = { running: "执行中", completed: "完成", failed: "失败", cancelled: "已取消", interrupted: "已中断" };
const eventLabel: Partial<Record<AgentEvent["type"], string>> = {
  "turn.started": "用户提问", "capability.routed": "能力路由", "model.requested": "模型请求", "model.responded": "模型响应",
  "assistant.delta": "AI 正文", "assistant.commentary": "AI 中途说明", "phase.updated": "执行阶段", "tool.started": "工具开始执行",
  "tool.progress": "工具执行进度", "tool.completed": "工具执行完成", "tool.failed": "工具执行失败", "interaction.requested": "等待确认",
  "interaction.resolved": "确认结果", "turn.completed": "任务完成", "turn.failed": "任务失败", "turn.cancelled": "任务取消", "turn.interrupted": "任务中断",
};

const duration = (value: number | null): string => value === null || !Number.isFinite(value) ? "—" : value < 1000 ? `${Math.max(0, Math.round(value))} 毫秒` : `${(value / 1000).toFixed(2)} 秒`;
const clip = (value: string, limit = 160): string => value.length <= limit ? value : `${value.slice(0, limit)}…`;
const asRecord = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const pretty = (value: unknown): string => JSON.stringify(value, null, 2) ?? "无记录";

interface AuditRow { key: string; event: AgentEvent; sourceEvents: AgentEvent[] }
interface ToolTiming { startedAt: string; endedAt?: string; outcome?: "completed" | "failed" }
interface PlannedAction { order: number; toolName: string; displayName: string; description: string; mutating: boolean; input: unknown }

function auditRows(events: readonly AgentEvent[]): AuditRow[] {
  const rows: AuditRow[] = [];
  for (const event of events) {
    const previous = rows.at(-1);
    if (event.type === "assistant.delta" && previous?.event.type === "assistant.delta" &&
        previous.event.payload.contentBlockId === event.payload.contentBlockId) {
      previous.sourceEvents.push(event);
    } else rows.push({ key: event.id, event, sourceEvents: [event] });
  }
  return rows;
}

function toolTimings(events: readonly AgentEvent[]): Map<string, ToolTiming> {
  const timings = new Map<string, ToolTiming>();
  for (const event of events) {
    if (event.type === "tool.started") timings.set(event.payload.toolCallId, { startedAt: event.occurredAt });
    else if (event.type === "tool.completed" || event.type === "tool.failed") {
      const timing = timings.get(event.payload.toolCallId);
      if (timing) {
        timing.endedAt = event.occurredAt;
        timing.outcome = event.type === "tool.completed" ? "completed" : "failed";
      }
    }
  }
  return timings;
}

function elapsed(startedAt: string, endedAt?: string): number | null {
  const start = Date.parse(startedAt);
  const end = endedAt === undefined ? Date.now() : Date.parse(endedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

function planActions(event: Extract<AgentEvent, { type: "phase.updated" }>): PlannedAction[] {
  const actions = asRecord(event.payload.detail)?.actions;
  if (!Array.isArray(actions)) return [];
  return actions.flatMap((value, index) => {
    const action = asRecord(value);
    if (!action || typeof action.toolName !== "string") return [];
    return [{ order: typeof action.order === "number" ? action.order : index + 1,
      toolName: action.toolName, displayName: typeof action.displayName === "string" ? action.displayName : action.toolName,
      description: typeof action.description === "string" ? action.description : "",
      mutating: action.mutating === true, input: action.input }];
  });
}

function replyKind(event: Extract<AgentEvent, { type: "model.responded" }>): "assistant" | "tool_calls" | "unknown" {
  const reply = asRecord(event.payload.reply);
  return reply?.kind === "assistant" || reply?.kind === "tool_calls" ? reply.kind : "unknown";
}

function eventTitle(event: AgentEvent): string {
  if (event.type === "phase.updated" && event.payload.phase === "tool") return "模型计划（不是工具调用）";
  if (event.type === "model.responded") return replyKind(event) === "tool_calls" ? "模型决策：请求调用工具" : "模型决策";
  return eventLabel[event.type] ?? event.type;
}

function rowSummary(row: AuditRow, timings: ReadonlyMap<string, ToolTiming>): string {
  const event = row.event;
  switch (event.type) {
    case "turn.started": return `用户提交的问题（${event.payload.userMessage.length} 字）`;
    case "model.requested": return `第 ${event.payload.callIndex} 轮 · 上下文 ${event.payload.messages.length} 条 · 可用工具 ${event.payload.tools.length} 个${event.payload.truncated ? " · 请求内容已截断" : ""}`;
    case "model.responded": {
      if (event.payload.status !== "completed") return `${event.payload.failureCode ?? event.payload.status}${event.payload.failureMessage ? ` · ${event.payload.failureMessage}` : ""} · ${duration(event.payload.latencyMs)}`;
      const kind = replyKind(event);
      return `${kind === "tool_calls" ? "模型提出工具调用计划" : kind === "assistant" ? "模型返回正文" : "模型响应完成"} · ${duration(event.payload.latencyMs)}`;
    }
    case "assistant.delta": {
      const text = row.sourceEvents.map(item => item.type === "assistant.delta" ? item.payload.delta : "").join("");
      return `AI 正文 · ${text.length} 字 · ${row.sourceEvents.length} 个流式片段`;
    }
    case "assistant.commentary": return "模型在调用工具前输出的中间说明";
    case "phase.updated": return `${event.payload.phase} 阶段 · 第 ${event.payload.step} 步${event.payload.phase === "tool" ? ` · 计划 ${planActions(event).length} 项操作` : ""}`;
    case "tool.started": {
      const timing = timings.get(event.payload.toolCallId);
      return `${event.payload.displayName ?? event.payload.toolName} · ${timing ? timing.outcome ? `运行 ${duration(elapsed(timing.startedAt, timing.endedAt))}` : `运行中 ${duration(elapsed(timing.startedAt))}` : "等待实际执行"}`;
    }
    case "tool.progress": return `${event.payload.displayName ?? event.payload.toolName} · ${event.payload.completed !== undefined && event.payload.total !== undefined ? `${event.payload.completed}/${event.payload.total}` : "正在执行"}`;
    case "tool.completed": {
      const timing = timings.get(event.payload.toolCallId);
      return `${event.payload.displayName ?? event.payload.toolName} · 执行成功${timing ? ` · 运行 ${duration(elapsed(timing.startedAt, timing.endedAt))}` : ""}`;
    }
    case "tool.failed": {
      const timing = timings.get(event.payload.toolCallId);
      return `${event.payload.displayName ?? event.payload.toolName} · ${event.payload.code}${timing ? ` · 已运行 ${duration(elapsed(timing.startedAt, timing.endedAt))}` : " · 未启动"}`;
    }
    case "capability.routed": return `${event.payload.algorithmVersion} · ${event.payload.fallback === "none" ? "正常路由" : `回退：${event.payload.fallback}`}`;
    case "turn.completed": return "任务正常结束";
    case "turn.failed": return `${event.payload.code} · 任务失败`;
    case "turn.cancelled": return `最后完成事件 #${event.payload.lastCompletedEventSeq}`;
    case "turn.interrupted": return event.payload.reason;
    case "interaction.requested": return "等待用户确认";
    case "interaction.resolved": return event.payload.resolution;
  }
}

function eventDuration(row: AuditRow, timings: ReadonlyMap<string, ToolTiming>, events: readonly AgentEvent[]): string | null {
  const event = row.event;
  if (event.type === "model.responded") return duration(event.payload.latencyMs);
  if (event.type === "assistant.delta") {
    const firstSeq = row.sourceEvents[0]?.eventSeq ?? event.eventSeq;
    const lastSeq = row.sourceEvents.at(-1)?.eventSeq ?? event.eventSeq;
    const request = [...events].reverse().find((item): item is Extract<AgentEvent, { type: "model.requested" }> => item.type === "model.requested" && item.eventSeq < firstSeq);
    const response = request && events.find((item): item is Extract<AgentEvent, { type: "model.responded" }> =>
      item.type === "model.responded" && item.eventSeq > lastSeq && item.payload.modelCallId === request.payload.modelCallId);
    if (response) return `模型耗时 ${duration(response.payload.latencyMs)}`;
  }
  if (event.type === "tool.started" || event.type === "tool.progress" || event.type === "tool.completed" || event.type === "tool.failed") {
    const timing = timings.get(event.payload.toolCallId);
    if (timing) return timing.endedAt === undefined ? `运行中 ${duration(elapsed(timing.startedAt))}` : duration(elapsed(timing.startedAt, timing.endedAt));
    if (event.type === "tool.failed") return "未启动";
  }
  return null;
}

function messageText(value: unknown): string {
  const message = asRecord(value);
  if (!message) return pretty(value);
  const role = typeof message.role === "string" ? message.role : "消息";
  if (typeof message.content === "string") return `${role}\n${message.content}`;
  return `${role}\n${pretty(message)}`;
}

function readableEvent(row: AuditRow, timings: ReadonlyMap<string, ToolTiming>): React.JSX.Element {
  const event = row.event;
  switch (event.type) {
    case "turn.started": return <p className="audit-readable-text">{event.payload.userMessage}</p>;
    case "assistant.delta": return <p className="audit-readable-text audit-assistant-text">{rowSummary(row, timings)}</p>;
    case "assistant.commentary": return <p className="audit-readable-text audit-assistant-text">{event.payload.text}</p>;
    case "phase.updated": {
      const actions = planActions(event);
      return <div className="audit-readable-stack"><p className="audit-readable-text">{event.payload.displayText}</p>{actions.length > 0 && <>
        <p className="audit-plan-note">以下是模型提出的计划，只有后续出现“工具开始执行”才表示真正调用。</p>
        <ol className="audit-plan-list">{actions.map(action => <li key={`${action.order}-${action.toolName}`}><div><strong>{action.order}. {action.displayName}</strong><span data-risk={action.mutating ? "write" : "read"}>{action.mutating ? "写入操作" : "读取操作"}</span></div>
          {action.description && <p>{action.description}</p>}{action.input !== undefined && <details><summary>查看计划参数</summary><pre>{pretty(action.input)}</pre></details>}</li>)}</ol>
      </>}</div>;
    }
    case "model.requested": return <div className="audit-readable-stack"><p>模型第 {event.payload.callIndex} 轮请求了 {event.payload.tools.length} 个可用工具，输入包含 {event.payload.messages.length} 条上下文消息。</p>
      <details><summary>查看本轮模型输入和候选工具</summary><div className="audit-model-request"><h4>上下文消息</h4>{event.payload.messages.map((message, index) => <pre key={index}>{messageText(message)}</pre>)}<h4>候选工具</h4><pre>{pretty(event.payload.tools)}</pre><h4>系统提示</h4><pre>{pretty(event.payload.systemPrompt)}</pre></div></details></div>;
    case "model.responded": return <div className="audit-readable-stack"><p>{event.payload.status === "completed" && replyKind(event) === "tool_calls"
      ? "模型输出了工具调用请求；这只是计划，工具是否实际运行请查看后续工具事件。"
      : event.payload.status === "completed" && replyKind(event) === "assistant"
        ? "模型本轮直接生成了回答正文；正文内容显示在相邻的 AI 正文记录中。"
        : `模型本轮未正常完成：${event.payload.failureMessage ?? event.payload.status}`}</p>
      {event.payload.truncated && <p className="audit-warning">该模型响应记录已截断。</p>}</div>;
    case "tool.started": return <div className="audit-readable-stack"><p>{event.payload.displayText}</p>{event.payload.input !== undefined && <details><summary>查看脱敏后的工具参数</summary><pre>{pretty(event.payload.input)}</pre></details>}</div>;
    case "tool.progress": return <div className="audit-readable-stack"><p>{event.payload.displayText}</p>{event.payload.detail !== undefined && <details><summary>查看进度数据</summary><pre>{pretty(event.payload.detail)}</pre></details>}</div>;
    case "tool.completed": return <div className="audit-readable-stack"><p className="audit-readable-text">{event.payload.summary}</p><details><summary>查看工具返回数据</summary><pre>{pretty(event.payload.evidence)}</pre></details></div>;
    case "tool.failed": return <div className="audit-readable-stack"><p className="audit-readable-text">{event.payload.message}</p>{event.payload.details !== undefined && <details><summary>查看错误详情</summary><pre>{pretty(event.payload.details)}</pre></details>}</div>;
    case "capability.routed": return <div className="audit-readable-stack"><p>本轮选择：{event.payload.selectedPackIds.join("、") || "无"}；模型可见 {event.payload.exposedToolCount} 个工具。</p><details><summary>查看路由依据和耗时</summary><pre>{pretty(event.payload)}</pre></details></div>;
    case "turn.completed": return <p className="audit-readable-text">{event.payload.outcomeSummary}</p>;
    case "turn.failed": return <div className="audit-readable-stack"><p className="audit-readable-text">{event.payload.outcomeSummary}</p><p>错误代码：{event.payload.code}</p></div>;
    case "turn.cancelled": return <p>已取消，最后完成事件为 #{event.payload.lastCompletedEventSeq}。</p>;
    case "turn.interrupted": return <p>任务中断：{event.payload.reason}</p>;
    case "interaction.requested": return <div className="audit-readable-stack"><p>等待确认：{event.payload.operation}</p><details><summary>查看确认请求</summary><pre>{pretty(event.payload)}</pre></details></div>;
    case "interaction.resolved": return <p>确认结果：{event.payload.resolution}</p>;
  }
}

function rawEvent(row: AuditRow): React.JSX.Element {
  const events = row.sourceEvents;
  return <details className="audit-raw-event"><summary>{events.length > 1 ? `查看 ${events.length} 条原始正文分片` : "查看完整事件 JSON"}</summary>
    {events.map(event => <pre key={event.id}>{pretty(event)}</pre>)}
    <button type="button" onClick={() => void navigator.clipboard.writeText(pretty(events.length > 1 ? events : events[0]))}>复制完整记录</button>
  </details>;
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
  const rows = useMemo(() => auditRows(ordered), [ordered]);
  const timings = useMemo(() => toolTimings(ordered), [ordered]);
  const started = ordered.find((event): event is Extract<AgentEvent, { type: "turn.started" }> => event.type === "turn.started");
  const terminal = [...ordered].reverse().find(event => event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled" || event.type === "turn.interrupted");
  const elapsedMs = started ? elapsed(started.occurredAt, terminal?.occurredAt) : null;
  const modelEvents = ordered.filter((event): event is Extract<AgentEvent, { type: "model.responded" }> => event.type === "model.responded");
  const modelDurationMs = modelEvents.reduce((total, event) => total + (Number.isFinite(event.payload.latencyMs) ? event.payload.latencyMs : 0), 0);
  const startedTools = ordered.filter(event => event.type === "tool.started").length;
  const finishedToolDurations = [...timings.values()].flatMap(timing => timing.endedAt === undefined ? [] : [elapsed(timing.startedAt, timing.endedAt) ?? 0]);
  const toolDurationMs = finishedToolDurations.reduce((total, value) => total + value, 0);

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
      <section className="observability-panel audit-detail"><header><h2>全流程记录</h2>{selectedRun && <small>Run {selectedRun.runId} · 用户 {selectedRun.accountId} · {statusLabel[selectedRun.status]}</small>}</header>
        {selectedRun && <div className="audit-run-metrics" aria-label="本轮耗时统计"><article><span>整轮耗时</span><strong>{duration(elapsedMs)}</strong></article><article><span>模型耗时</span><strong>{modelEvents.length} 轮 · {duration(modelDurationMs)}</strong></article><article><span>工具执行耗时</span><strong>{startedTools} 次 · {duration(toolDurationMs)}</strong></article><article><span>事件记录</span><strong>{ordered.length} 条</strong></article></div>}
        {rows.length === 0 && <p className="observability-state">尚无该任务的事件记录。</p>}
        <div className="audit-timeline">{rows.map(row => {
          const event = row.event;
          const took = eventDuration(row, timings, ordered);
          return <article className={`audit-event audit-event-${event.type.replaceAll(".", "-")}`} key={row.key}>
            <header><span className="audit-seq">#{event.eventSeq}</span><strong>{eventTitle(event)}</strong>{took && <span className="audit-duration">{took}</span>}<time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleTimeString("zh-CN")}</time></header>
            <div className="audit-event-summary">{rowSummary(row, timings)}</div>
            <div className="audit-event-body">{readableEvent(row, timings)}{rawEvent(row)}</div>
          </article>;
        })}</div>
      </section>
    </div>}
  </section>;
}
