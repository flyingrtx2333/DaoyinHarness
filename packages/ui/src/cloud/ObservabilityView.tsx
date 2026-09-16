import { useEffect, useMemo, useState } from "react";
import type { EvaluationClient, ObservabilitySummary, TelemetrySpanView, TelemetryTraceSummary } from "./evaluation-client.js";

const operationLabels: Record<string, string> = {
  "agent.run": "完整任务",
  "agent.capability_route": "选择所需能力",
  "agent.tool": "调用业务工具",
  "gen_ai.model.request": "请求模型",
};
const attributeLabels: Record<string, string> = {
  "daoyin.space.kind": "账号空间",
  "daoyin.router.mode": "能力筛选状态",
  "daoyin.model.calls": "模型请求次数",
  "daoyin.tool.calls": "工具调用次数",
  "daoyin.router.eligible_tools": "账号可用工具",
  "daoyin.router.selected_packs": "选中的能力包",
  "daoyin.router.exposed_tools": "本轮提供给模型的工具",
  "daoyin.router.fallback": "降级方式",
  "gen_ai.operation.name": "请求类型",
  "daoyin.child_run": "是否为子任务",
  "gen_ai.request.index": "本轮第几次请求",
  "daoyin.tool.name": "业务操作",
  "tool.name": "具体操作",
};
const technicalAttributes = new Set(["daoyin.run.id", "daoyin.session.id", "daoyin.profile.id"]);
const toolLabels: Record<string, string> = {
  project_list: "查看云端项目", project_create: "创建云端项目", project_files: "读取网站代码",
  project_write: "更新网站代码", project_concepts: "查看界面方案", project_concept_generate: "生成界面方案",
  project_concept_select: "选择界面方案", project_check: "检查网站", project_preview: "生成网站预览",
  project_publish: "发布网站", project_rollback: "回滚网站版本", search_company_knowledge: "查询企业资料",
  saishi_list_events: "查询赛事列表", saishi_get_event: "查询赛事详情", saishi_list_cameras: "查询赛事摄像机",
  saishi_list_materials: "查询赛事素材", saishi_get_map: "查询赛事地图", saishi_find_participants: "查询参赛者",
  saishi_get_timeline: "查询赛事时间线", saishi_get_job: "查询赛事任务", saishi_list_images: "查询赛事图片",
  story_video_options: "查询视频模型", story_recent_videos: "查询历史视频", story_get_video: "查询视频状态",
  story_estimate_video: "估算视频费用", story_create_video: "生成视频", request_video_confirmation: "等待视频确认",
  memory_search: "查询长期记忆", memory_remember: "保存长期记忆", memory_update: "更新长期记忆",
  memory_forget: "删除长期记忆", capability_search: "补充查找能力",
};
const toolLabel = (name: string): string => toolLabels[name] ?? "执行业务操作";
function traceTitle(trace: TelemetryTraceSummary): string {
  if (trace.toolNames.length === 0) return "生成文字回答";
  const names = [...new Set(trace.toolNames.map(toolLabel))];
  return names.slice(0, 2).join("、") + (names.length > 2 ? `等 ${names.length} 项操作` : "");
}
const operationLabel = (name: string, attributes?: Record<string, string | number | boolean>): string => {
  if (name === "agent.tool" && typeof attributes?.["tool.name"] === "string") return toolLabel(attributes["tool.name"]);
  return operationLabels[name] ?? "执行步骤";
};
const duration = (value: number | null): string => value === null ? "—" : value < 1000 ? `${Math.round(value)} 毫秒` : `${(value / 1000).toFixed(2)} 秒`;
function attributeValue(key: string, value: string | number | boolean): string {
  const text = String(value);
  if (key === "daoyin.space.kind") return ({ organization: "组织账号", personal: "个人账号", public: "公开访客" } as Record<string, string>)[text] ?? text;
  if (key === "daoyin.router.mode") return ({ shadow: "仅观察，暂未限制工具", enforce: "已启用能力筛选", off: "未启用" } as Record<string, string>)[text] ?? text;
  if (key === "daoyin.router.fallback") return ({ none: "未降级", lexical: "改用关键词匹配", "safe-readonly": "改用只读安全能力" } as Record<string, string>)[text] ?? text;
  if (key === "gen_ai.operation.name" && text === "chat") return "对话";
  if (key === "daoyin.child_run") return text === "true" ? "是" : "否";
  if (key === "tool.name") return toolLabel(text);
  return text;
}

export function ObservabilityView({ client }: { client: EvaluationClient }): React.JSX.Element {
  const [hours, setHours] = useState<1 | 6 | 24>(1);
  const [revision, setRevision] = useState(0);
  const [summary, setSummary] = useState<ObservabilitySummary>();
  const [traces, setTraces] = useState<TelemetryTraceSummary[]>([]);
  const [selected, setSelected] = useState<string>();
  const [spans, setSpans] = useState<TelemetrySpanView[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    const controller = new AbortController();
    setState("loading");
    void Promise.all([
      client.observabilitySummary(hours, controller.signal),
      client.observabilityTraces(hours, controller.signal),
    ]).then(([nextSummary, nextTraces]) => {
      if (controller.signal.aborted) return;
      setSummary(nextSummary);
      setTraces(nextTraces.traces);
      setState("ready");
      setSelected(current => current && nextTraces.traces.some(item => item.traceId === current) ? current : nextTraces.traces[0]?.traceId);
    }).catch(() => { if (!controller.signal.aborted) setState("failed"); });
    return () => controller.abort();
  }, [client, hours, revision]);

  useEffect(() => {
    if (!selected) { setSpans([]); return; }
    const controller = new AbortController();
    void client.observabilityTrace(selected, controller.signal)
      .then(value => { if (!controller.signal.aborted) setSpans(value.spans); })
      .catch(() => { if (!controller.signal.aborted) setSpans([]); });
    return () => controller.abort();
  }, [client, selected, revision]);

  const root = spans.find(span => !span.parentSpanId);
  const rootStart = root ? new Date(root.startedAt).getTime() : 0;
  const rootDuration = Math.max(root?.durationMs ?? 1, 1);
  const ordered = useMemo(() => [...spans].sort((left, right) => left.startedAt.localeCompare(right.startedAt)), [spans]);

  return <section className="observability-view" aria-label="任务运行记录">
    <header className="observability-header">
      <h1 className="sr-only">任务运行记录</h1>
      <div className="observability-actions" role="group" aria-label="查看时间范围">
        {([1, 6, 24] as const).map(value => <button type="button" aria-pressed={hours === value} onClick={() => setHours(value)} key={value}>近 {value} 小时</button>)}
        <button type="button" onClick={() => setRevision(value => value + 1)} disabled={state === "loading"}>刷新</button>
      </div>
    </header>
    {state === "failed" && <p className="observability-state" role="alert">运行记录读取失败，请刷新重试。</p>}
    {summary && <div className="observability-metrics">
      <article><span>任务次数</span><strong>{summary.traces}</strong></article>
      <article><span>失败率</span><strong>{(summary.errorRate * 100).toFixed(summary.errorRate ? 1 : 0)}%</strong></article>
      <article title="一半任务会在此时间内完成"><span>通常完成时间</span><strong>{duration(summary.p50Ms)}</strong></article>
      <article title="95% 的任务会在此时间内完成"><span>95% 任务完成时间</span><strong>{duration(summary.p95Ms)}</strong></article>
    </div>}
    {state === "loading" && !summary && <p className="observability-state" role="status">正在读取任务记录…</p>}
    {state === "ready" && traces.length === 0 && <p className="observability-state">当前时间范围内还没有任务记录。完成一次真实对话后即可查看。</p>}
    {traces.length > 0 && <div className="observability-layout">
      <section className="observability-panel"><h2>最近任务</h2><div className="trace-list">
        {traces.map(trace => <button type="button" className="trace-row" aria-current={selected === trace.traceId ? "true" : undefined} onClick={() => setSelected(trace.traceId)} key={trace.traceId}>
          <span data-status={trace.status}>{trace.status === "ok" ? "完成" : "失败"}</span>
          <strong>{traceTitle(trace)}</strong>
          <time dateTime={trace.startedAt}>{new Date(trace.startedAt).toLocaleString("zh-CN")}</time>
          <small>{duration(trace.durationMs)} · {trace.spanCount} 个步骤</small>
        </button>)}
      </div></section>
      <section className="observability-panel trace-detail"><h2>执行步骤</h2>{ordered.map(span => {
        const offset = Math.max(0, new Date(span.startedAt).getTime() - rootStart);
        const left = Math.min(99, offset / rootDuration * 100);
        const width = Math.max(1.5, Math.min(100 - left, span.durationMs / rootDuration * 100));
        const entries = Object.entries(span.attributes);
        const readable = entries.filter(([key]) => attributeLabels[key] !== undefined && !technicalAttributes.has(key));
        const technical = entries.filter(([key]) => attributeLabels[key] === undefined || technicalAttributes.has(key));
        return <article className="span-row" key={span.spanId}>
          <div><strong>{operationLabel(span.name, span.attributes)}</strong><span data-status={span.status}>{span.status === "ok" ? "完成" : "失败"}</span><small>{duration(span.durationMs)}</small></div>
          <div className="span-track" aria-hidden="true"><i data-status={span.status} style={{ left: `${left}%`, width: `${width}%` }} /></div>
          {readable.length > 0 && <dl>{readable.map(([key, value]) => <div key={key}><dt>{attributeLabels[key]}</dt><dd>{attributeValue(key, value)}</dd></div>)}</dl>}
          {technical.length > 0 && <details className="span-technical"><summary>技术信息</summary><dl>{technical.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl></details>}
        </article>;
      })}</section>
    </div>}
    {summary && summary.operations.length > 0 && <section className="observability-panel operation-summary"><h2>步骤汇总</h2><div className="operation-table" role="table">
      <div role="row"><span role="columnheader">步骤</span><span role="columnheader">次数</span><span role="columnheader">失败</span><span role="columnheader">平均耗时</span></div>
      {summary.operations.map(item => <div role="row" key={item.name}><strong role="cell">{operationLabel(item.name)}</strong><span role="cell">{item.count}</span><span role="cell">{item.errors}</span><span role="cell">{duration(item.averageMs)}</span></div>)}
    </div></section>}
  </section>;
}
