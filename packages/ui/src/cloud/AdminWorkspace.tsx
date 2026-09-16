import {useState} from "react";
import type {EvaluationClient} from "./evaluation-client.js";
import {EvaluationWorkbench} from "./EvaluationWorkbench.js";
import {WorkbenchIcon} from "./WorkbenchIcon.js";
import type {WorkbenchClient} from "./client.js";
import {CapabilityRoutingView} from "./CapabilityRoutingView.js";
import {ObservabilityView} from "./ObservabilityView.js";
import "./evaluation.css";
import "./admin.css";
type Section="overview"|"agent"|"routing"|"observability";
export function AdminWorkspace({client,workbenchClient,onDenied}:{client:EvaluationClient;workbenchClient:WorkbenchClient;onDenied:()=>void}):React.JSX.Element{
 const [section,setSection]=useState<Section>("overview");
 return <div className="admin-workspace">
  <header className="admin-header"><div><h1>测试后台</h1></div><span>管理员已验证</span></header>
  <nav className="evaluation-tabs" aria-label="后台页面标签"><button aria-current={section==="overview"?"page":undefined} onClick={()=>setSection("overview")}>测试总览</button><button aria-current={section==="agent"?"page":undefined} onClick={()=>setSection("agent")}>Agent 评估</button><button aria-current={section==="routing"?"page":undefined} onClick={()=>setSection("routing")}>能力路由</button><button aria-current={section==="observability"?"page":undefined} onClick={()=>setSection("observability")}>运行观测</button></nav>
  {section==="overview"&&<section className="admin-test-grid" aria-label="可用测试">
   <article className="admin-test-card"><WorkbenchIcon name="chat"/><div><h2>真实 Agent 评估 <small>可运行</small></h2></div><button className="primary" onClick={()=>setSection("agent")}>进入测试</button></article>
   <article className="admin-test-card"><WorkbenchIcon name="search"/><div><h2>能力包召回 <small>影子运行</small></h2></div><button className="primary" onClick={()=>setSection("routing")}>进入测试</button></article>
   <article className="admin-test-card"><WorkbenchIcon name="connection"/><div><h2>权限与隔离 <small>待扩展</small></h2></div></article>
   <article className="admin-test-card"><WorkbenchIcon name="connection"/><div><h2>运行观测 <small>实时</small></h2></div><button className="primary" onClick={()=>setSection("observability")}>进入查看</button></article>
  </section>}
  {section==="agent"&&<EvaluationWorkbench client={client} onDenied={onDenied}/>}
  {section==="routing"&&<CapabilityRoutingView client={workbenchClient}/>}
  {section==="observability"&&<ObservabilityView client={client}/>}
 </div>;
}
