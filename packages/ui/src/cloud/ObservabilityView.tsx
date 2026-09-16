import {useEffect,useMemo,useState} from "react";
import type {EvaluationClient,ObservabilitySummary,TelemetrySpanView,TelemetryTraceSummary} from "./evaluation-client.js";

const labels:Record<string,string>={"agent.run":"Agent 运行","agent.capability_route":"能力路由","agent.tool":"工具调用","gen_ai.model.request":"模型请求"};
const label=(name:string):string=>labels[name]??name;
const duration=(value:number|null):string=>value===null?"—":value<1000?`${Math.round(value)} ms`:`${(value/1000).toFixed(2)} s`;
export function ObservabilityView({client}:{client:EvaluationClient}):React.JSX.Element{
 const [hours,setHours]=useState<1|6|24>(1);const [revision,setRevision]=useState(0);
 const [summary,setSummary]=useState<ObservabilitySummary>();const [traces,setTraces]=useState<TelemetryTraceSummary[]>([]);
 const [selected,setSelected]=useState<string>();const [spans,setSpans]=useState<TelemetrySpanView[]>([]);
 const [state,setState]=useState<"loading"|"ready"|"failed">("loading");
 useEffect(()=>{const controller=new AbortController();setState("loading");void Promise.all([client.observabilitySummary(hours,controller.signal),client.observabilityTraces(hours,controller.signal)]).then(([nextSummary,nextTraces])=>{
  if(controller.signal.aborted)return;setSummary(nextSummary);setTraces(nextTraces.traces);setState("ready");
  setSelected(current=>current&&nextTraces.traces.some(item=>item.traceId===current)?current:nextTraces.traces[0]?.traceId);
 }).catch(()=>{if(!controller.signal.aborted)setState("failed")});return()=>controller.abort()},[client,hours,revision]);
 useEffect(()=>{if(!selected){setSpans([]);return}const controller=new AbortController();void client.observabilityTrace(selected,controller.signal).then(value=>{if(!controller.signal.aborted)setSpans(value.spans)}).catch(()=>{if(!controller.signal.aborted)setSpans([])});return()=>controller.abort()},[client,selected,revision]);
 const root=spans.find(span=>!span.parentSpanId);const rootStart=root?new Date(root.startedAt).getTime():0;const rootDuration=Math.max(root?.durationMs??1,1);
 const ordered=useMemo(()=>[...spans].sort((a,b)=>a.startedAt.localeCompare(b.startedAt)),[spans]);
 return <section className="observability-view" aria-label="运行观测">
  <header className="observability-header"><h1>运行观测</h1><div className="observability-actions" role="group" aria-label="观测时间范围">{([1,6,24] as const).map(value=><button type="button" aria-pressed={hours===value} onClick={()=>setHours(value)} key={value}>{value} 小时</button>)}<button type="button" onClick={()=>setRevision(value=>value+1)} disabled={state==="loading"}>刷新</button></div></header>
  {state==="failed"&&<p className="observability-state" role="alert">观测数据读取失败，请刷新重试。</p>}
  {summary&&<div className="observability-metrics"><article><span>运行数</span><strong>{summary.traces}</strong></article><article><span>错误率</span><strong>{(summary.errorRate*100).toFixed(summary.errorRate?1:0)}%</strong></article><article><span>P50</span><strong>{duration(summary.p50Ms)}</strong></article><article><span>P95</span><strong>{duration(summary.p95Ms)}</strong></article></div>}
  {state==="loading"&&!summary&&<p className="observability-state" role="status">正在读取运行链路…</p>}
  {state==="ready"&&traces.length===0&&<p className="observability-state">当前时间范围内还没有运行记录。完成一次真实对话后即可查看。</p>}
  {traces.length>0&&<div className="observability-layout"><section className="observability-panel"><h2>最近运行</h2><div className="trace-list">{traces.map(trace=><button type="button" className="trace-row" aria-current={selected===trace.traceId?"true":undefined} onClick={()=>setSelected(trace.traceId)} key={trace.traceId}><span data-status={trace.status}>{trace.status==="ok"?"完成":"失败"}</span><strong>{label(trace.name)}</strong><time dateTime={trace.startedAt}>{new Date(trace.startedAt).toLocaleString("zh-CN")}</time><small>{duration(trace.durationMs)} · {trace.spanCount} 个阶段</small></button>)}</div></section>
  <section className="observability-panel trace-detail"><h2>链路详情</h2>{ordered.map(span=>{const offset=Math.max(0,new Date(span.startedAt).getTime()-rootStart);const left=Math.min(99,offset/rootDuration*100);const width=Math.max(1.5,Math.min(100-left,span.durationMs/rootDuration*100));return <article className="span-row" key={span.spanId}><div><strong>{label(span.name)}</strong><span data-status={span.status}>{span.status==="ok"?"完成":"失败"}</span><small>{duration(span.durationMs)}</small></div><div className="span-track" aria-hidden="true"><i data-status={span.status} style={{left:`${left}%`,width:`${width}%`}}/></div>{Object.keys(span.attributes).length>0&&<dl>{Object.entries(span.attributes).map(([key,value])=><div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl>}</article>})}</section></div>}
  {summary&&summary.operations.length>0&&<section className="observability-panel operation-summary"><h2>阶段统计</h2><div className="operation-table" role="table"><div role="row"><span role="columnheader">阶段</span><span role="columnheader">次数</span><span role="columnheader">失败</span><span role="columnheader">平均耗时</span></div>{summary.operations.map(item=><div role="row" key={item.name}><strong role="cell">{label(item.name)}</strong><span role="cell">{item.count}</span><span role="cell">{item.errors}</span><span role="cell">{duration(item.averageMs)}</span></div>)}</div></section>}
 </section>;
}
