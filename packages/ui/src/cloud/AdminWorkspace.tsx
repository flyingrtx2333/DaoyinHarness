import {useState} from "react";
import type {EvaluationClient} from "./evaluation-client.js";
import {EvaluationWorkbench} from "./EvaluationWorkbench.js";
import {WorkbenchIcon} from "./WorkbenchIcon.js";
import "./evaluation.css";
import "./admin.css";
type Section="overview"|"agent";
export function AdminWorkspace({client,onDenied}:{client:EvaluationClient;onDenied:()=>void}):React.JSX.Element{
 const [section,setSection]=useState<Section>("overview");
 return <div className="admin-workspace">
  <header className="admin-header"><div><h1>测试后台</h1><p>集中运行 Harness 的真实能力评估，并保留可复核的测试记录。</p></div><span>管理员已验证</span></header>
  <nav className="evaluation-tabs" aria-label="后台页面标签"><button aria-current={section==="overview"?"page":undefined} onClick={()=>setSection("overview")}>测试总览</button><button aria-current={section==="agent"?"page":undefined} onClick={()=>setSection("agent")}>Agent 评估</button></nav>
  {section==="overview"&&<section className="admin-test-grid" aria-label="可用测试">
   <article className="admin-test-card"><WorkbenchIcon name="chat"/><div><h2>真实 Agent 评估 <small>可运行</small></h2><p>使用真实账号、模型和业务工具重复执行问题，检查回答、工具调用和稳定性。</p></div><button className="primary" onClick={()=>setSection("agent")}>进入测试</button></article>
   <article className="admin-test-card"><WorkbenchIcon name="search"/><div><h2>能力包召回 <small>等待路由接入</small></h2><p>路由层接入后核对每轮候选能力包、期望能力和 Recall@K；当前不生成虚假测试结果。</p></div></article>
   <article className="admin-test-card"><WorkbenchIcon name="connection"/><div><h2>权限与隔离 <small>待扩展</small></h2><p>集中检查跨账号访问、项目归属、沙箱网络和高风险操作门禁。</p></div></article>
  </section>}
  {section==="agent"&&<EvaluationWorkbench client={client} onDenied={onDenied}/>}
 </div>;
}
