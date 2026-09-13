import {useCallback,useEffect,useRef,useState} from "react";
import type {WorkbenchClient} from "./client.js";
import "./projects.css";
interface Project {id:string;title:string;slug:string;revision:number;activeVersion:string|null}
interface File {path:string;content:string}
interface Operation {id:string;kind:string;status:string;error:string|null;result:{versionId?:string}|null}
interface Version {id:string;revision:number;createdAt:string;published:boolean}
const states:Record<string,string>={queued:"等待资源",running:"正在执行",completed:"已完成",failed:"未完成",cancelled:"已停止",interrupted:"执行中断"};
const kinds:Record<string,string>={check:"检查",preview:"预览",publish:"发布",rollback:"回滚"};
export function ProjectWorkspace({client,ready,onDevelop}:{client:WorkbenchClient;ready:boolean;onDevelop:(sessionId:string)=>Promise<void>}):React.JSX.Element{
 const [projects,setProjects]=useState<Project[]>([]),[selected,setSelected]=useState(""),[files,setFiles]=useState<File[]>([]),[file,setFile]=useState("");
 const [operations,setOperations]=useState<Operation[]>([]),[versions,setVersions]=useState<Version[]>([]);
 const [title,setTitle]=useState(""),[slug,setSlug]=useState(""),[preview,setPreview]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const [enabled,setEnabled]=useState(false),[sandboxReady,setSandboxReady]=useState(false);
 const selectedRef=useRef(selected);selectedRef.current=selected;
 const project=projects.find(p=>p.id===selected);
 const current=files.find(f=>f.path===file);
 const pending=operations.find(o=>o.status==="running"||o.status==="queued");
 const refresh=useCallback(async()=>{
  if(!ready)return;
  const result=await client.project<{projects:Project[]}>({action:"list"});setProjects(result.projects);
 },[client,ready]);
 useEffect(()=>{if(!ready){setEnabled(false);return;}let disposed=false;
  void client.project<{enabled:boolean;ready:boolean}>({action:"capabilities"}).then(v=>{if(!disposed){setEnabled(v.enabled);setSandboxReady(v.ready);void refresh();}}).catch(e=>{if(!disposed)setError(String(e.message??e));});
  return()=>{disposed=true};
 },[client,ready,refresh]);
 const inspect=useCallback(async(id:string)=>{
  const [f,o,v]=await Promise.all([
   client.project<{project:Project;files:File[]}>({action:"files",projectId:id}),
   client.project<{operations:Operation[]}>({action:"operations",projectId:id}),
   client.project<{versions:Version[]}>({action:"versions",projectId:id})
  ]);
  if(selectedRef.current!==id)return;
  setFiles(f.files);setFile(previous=>f.files.some(item=>item.path===previous)?previous:f.files[0]?.path??"");
  setOperations(o.operations);setVersions(v.versions);setSlug(f.project.slug);
  setProjects(previous=>previous.map(p=>p.id===id?f.project:p));
 },[client]);
 useEffect(()=>{setPreview("");if(selected)void inspect(selected).catch(e=>setError(String(e.message??e)));},[selected,inspect]);
 useEffect(()=>{
  if(!selected||!pending)return;
  const timer=window.setInterval(()=>{void inspect(selected).catch(e=>setError(String(e.message??e)));},2500);
  return()=>window.clearInterval(timer);
 },[selected,pending?.id,inspect]);
 async function perform(fn:()=>Promise<void>):Promise<void>{
  if(busy)return;setBusy(true);setError("");try{await fn();}catch(e){setError(e instanceof Error?e.message:"操作未完成");}finally{setBusy(false);}
 }
 const action=(kind:string):Promise<void>=>perform(async()=>{
  if(!project)return;
  await client.project({action:kind,projectId:project.id,requestId:crypto.randomUUID()});await inspect(project.id);
 });
 return <section className="project-workspace" aria-label="云端项目">
  <header className="project-heading"><h1>云端项目</h1><button disabled={!enabled||busy} onClick={()=>void perform(async()=>{await refresh();if(selected)await inspect(selected);})}>刷新</button></header>
  {error&&<p className="project-error" role="alert">{error}</p>}
  {!ready?<p>请先登录道引账号。</p>:!enabled?<p>云端开发正在限额试运行。</p>:<>
   {!sandboxReady&&<p role="status">隔离环境尚未就绪，项目代码仍可保存。</p>}
   <form className="project-create" onSubmit={e=>{e.preventDefault();void perform(async()=>{
    const result=await client.project<{project:Project}>({action:"create",title,requestId:crypto.randomUUID()});
    await refresh();setSelected(result.project.id);setTitle("");
   });}}><input aria-label="新项目名称" placeholder="新项目名称" value={title} maxLength={80} onChange={e=>setTitle(e.target.value)} required/><button disabled={busy||!title.trim()}>创建项目</button></form>
   <div className="project-layout"><aside className="project-list" aria-label="项目列表">
    {projects.length===0?<p>创建第一个项目，开始搭建网站。</p>:projects.map(p=><button key={p.id} className={p.id===selected?"selected":""} onClick={()=>setSelected(p.id)}><strong>{p.title}</strong><span>{p.activeVersion?"已发布":"开发中"}</span></button>)}
   </aside><div className="project-detail">
    {!project?<p>选择一个项目查看文件和预览。</p>:<>
     <header className="project-heading"><h2>{project.title}</h2><button disabled={busy||!!pending} onClick={()=>void perform(async()=>{
      const session=await client.createSession(project.title,"daoyin-workbench");
      await client.project({action:"bind",projectId:project.id,sessionId:session.id});await onDevelop(session.id);
     })}>在新对话中开发</button></header>
     <div className="project-toolbar"><button disabled={busy||!!pending||!sandboxReady} onClick={()=>void action("preview")}>更新预览</button>
      <button disabled={busy||!!pending||!sandboxReady} onClick={()=>void action("check")}>检查</button>
      <button className="primary" disabled={busy||!!pending||!sandboxReady} onClick={()=>void action("publish")}>发布网站</button>
      {pending&&<button disabled={busy} onClick={()=>void perform(async()=>{await client.project({action:"cancel",projectId:project.id,operationId:pending.id});await inspect(project.id);})}>停止</button>}
     </div>
     <form className="project-domain" onSubmit={e=>{e.preventDefault();void perform(async()=>{await client.project({action:"rename",projectId:project.id,slug});await refresh();});}}>
      <label>网站地址<input aria-label="网站子域名" value={slug} onChange={e=>setSlug(e.target.value)} disabled={!!project.activeVersion||busy||!!pending} pattern="h-[a-z0-9-]+" maxLength={42}/></label><span>.demo.daoyintech.com</span>
      {!project.activeVersion&&<button disabled={busy||!!pending}>保存地址</button>}
      {project.activeVersion&&<a href={"https://"+project.slug+".demo.daoyintech.com"} target="_blank" rel="noreferrer">打开网站 ↗</a>}
     </form>
     {operations[0]&&<div className="project-status" role="status">{kinds[operations[0].kind]}：{states[operations[0].status]}{operations[0].error&&<p>{operations[0].error}</p>}</div>}
     <div className="project-file-bar"><label>项目文件<select value={file} onChange={e=>setFile(e.target.value)}>{files.map(f=><option key={f.path}>{f.path}</option>)}</select></label><span>版本 {project.revision}</span></div>
     {current&&<pre className="project-source" tabIndex={0} aria-label={current.path+" 源代码"}><code>{current.content}</code></pre>}
     <div className="project-toolbar"><button disabled={busy||!operations.some(o=>o.kind==="preview"&&o.status==="completed")} onClick={()=>void perform(async()=>{
      const result=await client.project<{url:string}>({action:"ticket",projectId:project.id});setPreview(result.url);
     })}>打开预览</button>
      <label>回滚版本<select aria-label="回滚到已发布版本" defaultValue="" disabled={busy||!!pending} onChange={e=>{
       const versionId=e.target.value;e.currentTarget.value="";if(!versionId)return;
       void perform(async()=>{await client.project({action:"rollback",projectId:project.id,versionId,requestId:crypto.randomUUID()});await inspect(project.id);});
      }}><option value="">选择已发布版本</option>{versions.filter(v=>v.published&&v.id!==project.activeVersion).map(v=><option key={v.id} value={v.id}>版本 {v.revision} · {new Date(v.createdAt).toLocaleString()}</option>)}</select></label>
     </div>
     {preview&&<iframe title={project.title+" 开发预览"} className="project-preview" src={preview} sandbox="allow-scripts allow-forms allow-same-origin allow-downloads" referrerPolicy="no-referrer"/>}
    </>}
   </div></div>
  </>}
 </section>;
}
