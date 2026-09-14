import {useEffect,useState} from "react";
import type {AgentEvent} from "@daoyin/harness-protocol";
import {WorkbenchClient} from "./client.js";
interface RouteRecord{sessionTitle:string;occurredAt:string;phase:string;selectedPackIds:string[];exposedToolCount:number;schemaCharacters:number;fallback:string;blockedHighRiskPackIds:string[];latencyMs:{eligibility:number;retrieval:number;rerank:number;classify:number}}
function routeRecord(event:AgentEvent,sessionTitle:string):RouteRecord|undefined{
 if(event.type!=="capability.routed")return undefined;
 const value=event.payload;
 return {sessionTitle,occurredAt:event.occurredAt,phase:value.phase,selectedPackIds:value.selectedPackIds,exposedToolCount:value.exposedToolCount,schemaCharacters:value.schemaCharacters,fallback:value.fallback,blockedHighRiskPackIds:value.blockedHighRiskPackIds,latencyMs:value.latencyMs};
}
export function CapabilityRoutingView({client}:{client:WorkbenchClient}):React.JSX.Element{
 const [records,setRecords]=useState<RouteRecord[]>([]);const [state,setState]=useState<"loading"|"ready"|"failed">("loading");const [revision,setRevision]=useState(0);
 useEffect(()=>{const controller=new AbortController();setState("loading");void client.sessions(controller.signal).then(async sessions=>{
  const pages=await Promise.all(sessions.slice(0,20).map(async session=>(await client.events(session.id,0,controller.signal)).map(event=>routeRecord(event,session.title)).filter((item):item is RouteRecord=>item!==undefined)));
  if(controller.signal.aborted)return;setRecords(pages.flat().sort((a,b)=>b.occurredAt.localeCompare(a.occurredAt)).slice(0,30));setState("ready");
 }).catch(()=>{if(!controller.signal.aborted)setState("failed")});return()=>controller.abort()},[client,revision]);
 return <section className="routing-view" aria-label="能力包召回记录">
  <header className="routing-header"><h1>能力包召回</h1><button type="button" onClick={()=>setRevision(value=>value+1)} disabled={state==="loading"}>刷新</button></header>
  {state==="loading"&&<p className="routing-state" role="status">正在读取路由记录…</p>}
  {state==="failed"&&<p className="routing-state" role="alert">路由记录读取失败，请刷新重试。</p>}
  {state==="ready"&&records.length===0&&<p className="routing-state">暂无路由记录。完成一次真实会话后即可查看。</p>}
  {state==="ready"&&records.length>0&&<div className="routing-records">{records.map((record,index)=><article className="routing-record" key={`${record.occurredAt}-${index}`}>
   <header><div><h2>{record.sessionTitle}</h2><time dateTime={record.occurredAt}>{new Date(record.occurredAt).toLocaleString("zh-CN")}</time></div><span data-fallback={record.fallback}>{record.fallback==="none"?"正常路由":record.fallback==="lexical"?"词法回退":"安全只读"}</span></header>
   <dl><div><dt>能力包</dt><dd>{record.selectedPackIds.join("、")||"无"}</dd></div><div><dt>工具</dt><dd>{record.exposedToolCount}</dd></div><div><dt>Schema</dt><dd>{record.schemaCharacters.toLocaleString()} 字符</dd></div><div><dt>耗时</dt><dd>{Math.round(record.latencyMs.retrieval+record.latencyMs.rerank)} ms</dd></div></dl>
   {record.blockedHighRiskPackIds.length>0&&<div className="routing-blocked"><strong>已拦截高风险包</strong><span>{record.blockedHighRiskPackIds.join("、")}</span></div>}
  </article>)}</div>}
 </section>;
}
