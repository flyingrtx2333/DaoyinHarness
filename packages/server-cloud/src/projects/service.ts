import http from "node:http";
import { providerSafeConceptText } from "./concept-prompt.js";
import { projectSiteContentSecurityPolicy } from "./site-policy.js";
import { mkdir, chmod, chown, unlink } from "node:fs/promises";
import { Pool, type PoolConfig } from "pg";
import { randomBytes } from "node:crypto";
import { ProjectRepository, digest, newId } from "./repository.js";
import { ProjectBrokers } from "./broker.js";
import { ProjectError, identifier, type ProjectOwner, type ExecutorRequest } from "./contracts.js";
import { unixJson, pinAppSocket } from "./wire.js";
const socket="/run/daoyin-projects/control.sock";
const executor="/run/daoyin-project-executor/control.sock";
const database=process.env.HARNESS_PROJECTS_DATABASE_URL;
const brokerKey=process.env.HARNESS_PROJECTS_BROKER_KEY;
const aiToken=process.env.HARNESS_PROJECTS_AI_TOKEN;
const aiOrigin=process.env.HARNESS_PROJECTS_AI_ORIGIN??"http://127.0.0.1:6087";
const aiBase=new URL(aiOrigin);
if(!database||!brokerKey||brokerKey.length<32||!aiToken||aiToken.length<32||
  aiBase.protocol!=="http:"||aiBase.hostname!=="127.0.0.1"||aiBase.port!=="6087"||aiBase.pathname!=="/")
  throw new Error("Project service database, broker and isolated image gateway configuration required.");
const dbUrl=new URL(database);
const dbConfig:PoolConfig={host:dbUrl.searchParams.get("host")??dbUrl.hostname,port:Number(dbUrl.port||5432),user:decodeURIComponent(dbUrl.username),password:decodeURIComponent(dbUrl.password),database:decodeURIComponent(dbUrl.pathname.slice(1)),max:5};
const pool=new Pool(dbConfig),repository=new ProjectRepository(pool),brokers=new ProjectBrokers(pool,dbConfig,brokerKey);
const allowed=new Set((process.env.HARNESS_PROJECTS_ALLOWED_USERS??"").split(",").filter(Boolean));
const allEnabled=process.env.HARNESS_PROJECTS_ENABLED==="1";
const brokerOnly=process.env.HARNESS_PROJECTS_BROKER_ONLY==="1";
let workerBusy=false;
const touches=new Map<string,number>();
const exec=(body:ExecutorRequest):Promise<Record<string,unknown>>=>unixJson(executor,"/execute",body,undefined,650000);
const permit=(value:unknown):ProjectOwner=>{
  if(!value||typeof value!=="object"||!("actor" in value)||!("space" in value)||typeof value.actor!=="string"||typeof value.space!=="string"||value.actor.length>160||value.space.length>1000)
    throw new ProjectError("PROJECT_IDENTITY_REQUIRED","项目执行身份无效。",403);
  if(!allEnabled&&!allowed.has(value.actor))throw new ProjectError("PROJECT_NOT_ENABLED","云端开发正在限额试运行，当前账号尚未开放。",403);
  return{actor:value.actor,space:value.space};
};
interface RequestBody { authorization?:unknown; sourceRun?:string; owner?:unknown; action?:string; projectId?:string; title?:string; requestId?:string; sessionId?:string; revision?:number; files?:unknown; slug?:unknown; versionId?:string; operationId?:string; conceptId?:string; direction?:unknown; screen?:string; width?:number; height?:number; prompt?:string; strength?:string; tradeoff?:string }
function projectIdentity(owner:ProjectOwner):{tenantId:number;userId:number}{
  let space:unknown;try{space=JSON.parse(owner.space);}catch{throw new ProjectError("PROJECT_IDENTITY_INVALID","项目身份无效。",403);}
  if(!space||typeof space!=="object"||!("kind" in space)||space.kind!=="organization"||!("tenantId" in space)||
    typeof space.tenantId!=="string"||!/^[1-9][0-9]{0,15}$/u.test(space.tenantId)||!/^[1-9][0-9]{0,15}$/u.test(owner.actor))
    throw new ProjectError("PROJECT_IDENTITY_INVALID","项目身份无效。",403);
  return{tenantId:Number(space.tenantId),userId:Number(owner.actor)};
}
async function boundedImage(url:string,signal?:AbortSignal):Promise<{mimeType:string;content:Buffer}>{
  const target=new URL(url);
  if(target.protocol!=="https:"||target.username||target.password||target.port||target.search||target.hash||
    !/^[a-z0-9-]+\.cos\.[a-z0-9-]+\.myqcloud\.com$/u.test(target.hostname))
    throw new ProjectError("PROJECT_CONCEPT_SOURCE_DENIED","图片存储来源无效。",502);
  const response=await fetch(target,{redirect:"error",signal:signal?AbortSignal.any([signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000)});
  const mimeType=(response.headers.get("content-type")??"").split(";",1)[0]!;
  if(!response.ok||!["image/png","image/jpeg","image/webp"].includes(mimeType))throw new ProjectError("PROJECT_CONCEPT_DOWNLOAD_FAILED","生成图片未能安全保存。",502);
  const reader=response.body?.getReader();if(!reader)throw new ProjectError("PROJECT_CONCEPT_DOWNLOAD_FAILED","生成图片内容为空。",502);
  const chunks:Uint8Array[]=[];let bytes=0;
  try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>5242880)throw new ProjectError("PROJECT_CONCEPT_IMAGE_TOO_LARGE","生成图片超过 5 MB。",413);chunks.push(part.value);}}
  finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
  const content=Buffer.concat(chunks);if(content.length<1024)throw new ProjectError("PROJECT_CONCEPT_DOWNLOAD_FAILED","生成图片内容为空。",502);
  return{mimeType,content};
}
async function generateConcept(owner:ProjectOwner,requestId:string,prompt:string,signal?:AbortSignal):Promise<{mimeType:string;content:Buffer}>{
  const identity=projectIdentity(owner);
  const response=await fetch(new URL("/api/internal/ai/image-generations",aiBase),{method:"POST",redirect:"error",signal:signal?AbortSignal.any([signal,AbortSignal.timeout(390000)]):AbortSignal.timeout(390000),
    headers:{"Content-Type":"application/json","x-ai-service-token":aiToken!},body:JSON.stringify({
      tenant_id:identity.tenantId,user_id:identity.userId,credential_mode:"PLATFORM",app_key:"harness-projects",scene_key:"ui_concept",
      request_id:"harness_ui_"+digest(requestId).slice(0,40),prompt,negative_prompt:"水印、浏览器外框、设备模型、乱码、密集小字、外部品牌标志、整页装饰遮挡控件",
      reference_urls:[],aspect_ratio:"16:9",seed:null
    })});
  const bytes=await response.arrayBuffer();
  if(bytes.byteLength>131072)throw new ProjectError("PROJECT_CONCEPT_GATEWAY_INVALID","图片生成服务返回异常。",502);
  let value:unknown;try{value=JSON.parse(Buffer.from(bytes).toString());}catch{throw new ProjectError("PROJECT_CONCEPT_GATEWAY_INVALID","图片生成服务返回异常。",502);}
  if(!response.ok)throw new ProjectError(response.status===429?"PROJECT_CONCEPT_QUOTA":"PROJECT_CONCEPT_GENERATION_FAILED",response.status===429?"图片生成额度暂不可用。":"界面方案生成失败，请稍后重试。",response.status===429?429:502);
  const data=value&&typeof value==="object"&&"data" in value&&value.data&&typeof value.data==="object"?value.data:null;
  const output=data&&"output_url" in data&&typeof data.output_url==="string"?data.output_url:null;
  if(!output)throw new ProjectError("PROJECT_CONCEPT_GATEWAY_INVALID","图片生成服务没有返回图片。",502);
  return boundedImage(output,signal);
}
async function control(input:RequestBody,signal?:AbortSignal):Promise<unknown>{
  const owner=permit(input.owner);
  if(input.action==="cancel_run"){
    const rows=(await pool.query<{id:string;project_id:string}>("UPDATE harness_project_operations o SET status='cancelled',error='对话已停止；源码与原网站保留。' FROM harness_projects p WHERE p.id=o.project_id AND p.owner_key=$1 AND o.source_run=$2 AND o.status IN ('queued','running') RETURNING o.id,o.project_id",[digest([owner.actor,owner.space]),input.sourceRun])).rows;
    for(const row of rows)await exec({action:"stop",projectId:row.project_id,mode:"development"});
    return{cancelled:rows.length};
  }
  if(input.action==="capabilities"){
    const state=await exec({action:"readiness",projectId:""});
    return{enabled:true,ready:state.ready===true,maxProjects:5,maxOnlineApps:2};
  }
  if(input.action==="list")return{projects:await repository.list(owner)};
  if(input.action==="create"){
    const project=await repository.create(owner,String(input.title??""),String(input.requestId??""));
    if(input.sessionId)await repository.bind(owner,project.id,input.sessionId);
    return{project};
  }
  if(input.action==="bound")return{project:await repository.bound(owner,String(input.sessionId??""))};
  const id=identifier(input.projectId,"prj");
  await repository.get(owner,id);
  touches.set(id,Date.now());
  if(input.action==="get")return{project:await repository.get(owner,id)};
  if(input.action==="bind"){await repository.bind(owner,id,String(input.sessionId??""));return{project:await repository.get(owner,id)};}
  if(input.action==="files")return{project:await repository.get(owner,id),files:await repository.files(owner,id)};
  if(input.action==="write")return{project:await repository.write(owner,id,Number(input.revision),input.files)};
  if(input.action==="rename")return{project:await repository.rename(owner,id,input.slug)};
  if(input.action==="versions")return{versions:await repository.versions(owner,id)};
  if(input.action==="operations")return{operations:await repository.operations(owner,id)};
  if(input.action==="concepts")return{conceptSet:await repository.concepts(owner,id)};
  if(input.action==="concept_image"){
    const image=await repository.conceptImage(owner,id,identifier(input.conceptId,"uic"));
    return{mimeType:image.mimeType,content:image.content.toString("base64")};
  }
  if(input.action==="concept_select")return await repository.selectConcept(owner,id,input.direction);
  if(input.action==="concept_discard"){await repository.discardConcepts(owner,id);return{discarded:true};}
  if(input.action==="concept_generate"){
    await authorize(input.authorization,input.sourceRun);
    const project=await repository.get(owner,id);
    const requestId=String(input.requestId??"");
    const prompt=String(input.prompt??"");
    const safeProjectTitle=providerSafeConceptText(project.title),safePrompt=providerSafeConceptText(prompt);
    const fullPrompt=["Use case: ui-mockup","Asset type: complete desktop web application screen concept",
      "Viewport: 1536x864 landscape, full screen visible, no browser chrome","Product: "+safeProjectTitle,
      "Required functions and information architecture: "+safePrompt,"Direction "+String(input.direction??"")+": "+safePrompt,
      "Style: polished production Chinese UI concept with reconstructable hierarchy and project-appropriate imagery",
      "Constraints: all edges visible; real controls can be rebuilt as DOM; no watermark; no lorem ipsum; no external brand logos; avoid emoji as primary icons"].join("\n");
    const begun=await repository.beginConcept(owner,id,{requestId,direction:input.direction,screen:String(input.screen??""),width:Number(input.width),height:Number(input.height),
      prompt,title:String(input.title??""),strength:String(input.strength??""),tradeoff:String(input.tradeoff??"")});
    if(begun.cached)return{conceptSet:await repository.concepts(owner,id)};
    try{
      const generated=await generateConcept(owner,requestId,fullPrompt,signal);
      await authorize(input.authorization,input.sourceRun);
      return{conceptSet:await repository.completeConcept(owner,id,begun.conceptId,generated.mimeType,generated.content)};
    }catch(error){
      const message=error instanceof ProjectError?error.message:"界面方案生成失败。";
      await repository.failConcept(owner,id,begun.conceptId,message).catch(()=>undefined);
      throw error;
    }
  }
  if(input.action==="cancel"){
    await repository.cancel(owner,id,String(input.operationId));
    await exec({action:"stop",projectId:id,mode:"development"});return{cancelled:true};
  }
  if(input.action==="ticket"){
    const op=(await repository.operations(owner,id)).find(o=>o.kind==="preview"&&o.status==="completed");
    if(!op)throw new ProjectError("PROJECT_PREVIEW_NOT_READY","请先生成预览。",409);
    const versionId=identifier(op.result?.versionId,"ver");
    const state=await exec({action:"status",projectId:id,versionId,mode:"development"});
    if(state.running!==true)throw new ProjectError("PROJECT_PREVIEW_SLEEPING","预览已休眠，请重新启动。",409);
    const ticket=await repository.ticket(owner,id);
    return{url:"https://p-"+id.slice(4)+".demo.daoyintech.com/__preview?ticket="+encodeURIComponent(ticket)};
  }
  if(["check","preview","publish","rollback"].includes(String(input.action))){
    await authorize(input.authorization);
    return{operation:await repository.enqueue(owner,id,input.action!,String(input.requestId??""),input.versionId,input.authorization,input.sourceRun)};
  }
  throw new ProjectError("PROJECT_ACTION_INVALID","项目操作无效。",400);
}
async function authorize(value:unknown,sourceRun?:string):Promise<void>{
 const result=await unixJson<{active:boolean}>("/run/daoyin-project-authorization/auth.sock","/authorize",{identity:value,sourceRun},undefined,7000);
 if(result.active!==true)throw new ProjectError("PROJECT_AUTHORIZATION_REVOKED","账号权限或对话状态已变化，操作停止；原网站保留。",403);
}
async function stopCandidate(projectId:string,versionId:string,mode:"development"|"production"):Promise<void>{
 if(mode==="production"){
  const current=(await pool.query<{active_version:string|null}>("SELECT active_version FROM harness_projects WHERE id=$1",[projectId])).rows[0];
  if(current?.active_version===versionId)return;
 }
 await exec({action:"stop",projectId,versionId,mode});
}
async function worker():Promise<void>{
  if(workerBusy)return;workerBusy=true;
  let selected:{id:string;project_id:string;kind:string;execution_identity:unknown;source_run?:string;result:{versionId:string}}|undefined;
  try{
    selected=await repository.locked("project-worker",async db=>{
      const row=(await db.query<{id:string;project_id:string;kind:string;execution_identity:unknown;source_run?:string;result:{versionId:string}}>("SELECT id,project_id,kind,result,execution_identity,source_run FROM harness_project_operations WHERE status='queued' ORDER BY updated_at,created_at LIMIT 1 FOR UPDATE SKIP LOCKED")).rows[0];
      if(row)await db.query("UPDATE harness_project_operations SET status='running',updated_at=now() WHERE id=$1",[row.id]);return row;
    });
    if(!selected)return;
    await authorize(selected.execution_identity,selected.source_run);
    const op=selected,versionId=identifier(op.result.versionId,"ver");
    const version=(await pool.query<{files:{path:string;content:string}[]}>("SELECT files FROM harness_project_versions WHERE id=$1 AND project_id=$2",[versionId,op.project_id])).rows[0];
    if(!version)throw new ProjectError("PROJECT_VERSION_MISSING","代码快照不存在。",404);
    const mode=op.kind==="publish"||op.kind==="rollback"?"production":"development";
    if(op.kind!=="check"){
      const project=(await pool.query<{slug:string}>("SELECT slug FROM harness_projects WHERE id=$1",[op.project_id])).rows[0]!;
      await exec({action:"domains",projectId:op.project_id,slug:project.slug});
      await brokers.ensure(op.project_id,mode);
    }
    const action=op.kind as ExecutorRequest["action"];
    let checking=false;
    const watchdog=setInterval(()=>{if(checking)return;checking=true;void(async()=>{
      try{
        await authorize(op.execution_identity,op.source_run);
        const current=(await pool.query<{status:string}>("SELECT status FROM harness_project_operations WHERE id=$1",[op.id])).rows[0];
        if(current?.status==="cancelled")throw new Error("Operation cancelled");
      }catch{
        await pool.query("UPDATE harness_project_operations SET status='cancelled',error='权限或对话状态已变化；原网站保留。' WHERE id=$1 AND status='running'",[op.id]);
        const active=(await pool.query<{active_version:string|null}>("SELECT active_version FROM harness_projects WHERE id=$1",[op.project_id])).rows[0];
        if(mode!=="production"||active?.active_version!==versionId)await exec({action:"stop",projectId:op.project_id,versionId,mode});
      }finally{checking=false;}
    })().catch(()=>{checking=false;});},2000);
    let result:Record<string,unknown>;
    try{result=await exec({action,projectId:op.project_id,versionId,files:version.files,mode});}
    finally{clearInterval(watchdog);}

    try{await authorize(op.execution_identity,op.source_run);}catch(e){if(op.kind!=="check")await stopCandidate(op.project_id,versionId,mode);throw e;}
    let cancelled=false,previous:string|null=null;
    await repository.locked(op.project_id,async db=>{
      const current=(await db.query<{status:string}>("SELECT status FROM harness_project_operations WHERE id=$1 FOR UPDATE",[op.id])).rows[0];
      if(current?.status!=="running"){cancelled=true;return;}
      if(mode==="production"){
        previous=(await db.query<{active_version:string|null}>("SELECT active_version FROM harness_projects WHERE id=$1",[op.project_id])).rows[0]?.active_version??null;
        await db.query("UPDATE harness_projects SET active_version=$1,updated_at=now() WHERE id=$2",[versionId,op.project_id]);
        await db.query("INSERT INTO harness_project_deployments VALUES($1,$2,$3,$4,now())",[newId("dep"),op.project_id,versionId,op.id]);
      }
      await db.query("UPDATE harness_project_operations SET status='completed',result=$1,error=NULL,updated_at=now() WHERE id=$2",
        [JSON.stringify({versionId,checked:true,running:op.kind!=="check",...(typeof result.name==="string"?{instance:result.name}:{})}),op.id]);
    });
    if(cancelled&&op.kind!=="check")await stopCandidate(op.project_id,versionId,mode);
    if(previous&&previous!==versionId)await exec({action:"stop",projectId:op.project_id,versionId:previous,mode:"production"});
    touches.set(op.project_id,Date.now());
  }catch(e){
    if(selected){
      const err=e instanceof ProjectError?e:new ProjectError("PROJECT_OPERATION_FAILED","项目执行服务未完成操作；源码和原网站保留。",503);
      const queued=err.code==="PROJECT_CAPACITY_WAIT";
      await pool.query("UPDATE harness_project_operations SET status=$1,error=$2,updated_at=now() WHERE id=$3 AND status='running'",
        [queued?"queued":"failed",err.message,selected.id]).catch(()=>undefined);
    }
  }finally{workerBusy=false;}
}
function cookie(header:string|undefined,key:string):string{
  return(header??"").split(";").map(v=>v.trim()).find(v=>v.startsWith(key+"="))?.slice(key.length+1)??"";
}
function gatewayError(res:http.ServerResponse,error:unknown):void{
  const e=error instanceof ProjectError?error:new ProjectError("PROJECT_SITE_UNAVAILABLE","网站暂不可用，请稍后重试。",503);
  if(!res.headersSent)res.writeHead(e.status,{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-store"}).end(e.message);else res.destroy();
}
const gateway=http.createServer((req,res)=>{void(async()=>{
  try{
    const host=String(req.headers.host??"").toLowerCase();
    const preview=/^p-([a-f0-9]{24})\.demo\.daoyintech\.com$/u.exec(host);
    const published=/^(h-[a-z0-9-]{1,40})\.demo\.daoyintech\.com$/u.exec(host);
    if(!preview&&!published)throw new ProjectError("PROJECT_DOMAIN_UNKNOWN","网站不存在。",404);
    const row=(await pool.query<{id:string;active_version:string|null;owner_key:string}>("SELECT id,active_version,owner_key FROM harness_projects WHERE "+(preview?"id=$1":"slug=$1"),[preview?"prj_"+preview[1]:published![1]])).rows[0];
    if(!row)throw new ProjectError("PROJECT_DOMAIN_UNKNOWN","网站不存在。",404);
    res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("Referrer-Policy","no-referrer");
    res.setHeader("Content-Security-Policy",projectSiteContentSecurityPolicy(Boolean(preview)));
    let version=row.active_version;
    if(preview){
      const url=new URL(req.url??"/","https://"+host);
      if(url.pathname==="/__preview"&&req.method==="GET"){
        const ticket=url.searchParams.get("ticket")??"";
        const exchange=await pool.query("UPDATE harness_project_preview_tickets SET used_at=now() WHERE token_hash=$1 AND project_id=$2 AND expires_at>now() AND used_at IS NULL RETURNING owner_key",[digest(ticket),row.id]);
        if(!exchange.rowCount)throw new ProjectError("PROJECT_PREVIEW_LOGIN","预览链接已过期，请从工作台重新打开。",401);
        const token=randomBytes(32).toString("base64url");
        await pool.query("INSERT INTO harness_project_preview_sessions VALUES($1,$2,$3,now()+interval '15 minutes')",[digest(token),row.id,row.owner_key]);
        res.writeHead(303,{"Location":"/","Set-Cookie":"__Host-hp-preview="+token+"; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=900","Cache-Control":"no-store"}).end();return;
      }
      const valid=await pool.query("SELECT token_hash FROM harness_project_preview_sessions WHERE token_hash=$1 AND project_id=$2 AND expires_at>now()",[digest(cookie(req.headers.cookie,"__Host-hp-preview")),row.id]);
      if(!valid.rowCount)throw new ProjectError("PROJECT_PREVIEW_LOGIN","请从已登录的工作台打开预览。",401);
      version=(await pool.query<{result:{versionId:string}}>("SELECT result FROM harness_project_operations WHERE project_id=$1 AND kind='preview' AND status='completed' ORDER BY updated_at DESC LIMIT 1",[row.id])).rows[0]?.result.versionId??null;
      touches.set(row.id,Date.now());
    }
    if(!version)throw new ProjectError("PROJECT_NOT_PUBLISHED",preview?"预览尚未生成。":"网站尚未发布。",404);
    const mode=preview?"development":"production";
    const name="hp-"+row.id.slice(4)+"-"+mode+"-"+version.slice(4,12);
    const socketPath="/var/lib/daoyin-projects/instances/"+name+"/app.sock";
    const headers:http.OutgoingHttpHeaders={host,"x-forwarded-proto":"https"};
    // No parent-domain/platform cookies, authorization, forwarding headers or preview credentials enter user code.
    const userCookie=cookie(req.headers.cookie,"__Host-hp-user");if(userCookie)headers.cookie="__Host-hp-user="+userCookie;
    for(const h of ["content-type","content-length","accept","origin","if-none-match"])if(req.headers[h]!==undefined)headers[h]=req.headers[h];
    // File descriptor numbers can be reused; never pool HTTP connections by /proc/self/fd/N.
    const pinned=await pinAppSocket(socketPath);
    const upstream=http.request({agent:false,socketPath:pinned.path,path:req.url,method:req.method,headers},remote=>{
      const safe:http.OutgoingHttpHeaders={};
      for(const h of ["content-type","content-length","cache-control","etag","content-disposition","location"])if(remote.headers[h]!==undefined)safe[h]=remote.headers[h];
      const cookies=remote.headers["set-cookie"]?.filter(v=>v.startsWith("__Host-hp-user=")&&!/;\s*domain=/iu.test(v)&&/;\s*secure(?:;|$)/iu.test(v)&&/;\s*path=\/(?:;|$)/iu.test(v));
      if(cookies?.length)safe["set-cookie"]=cookies;
      if(preview)safe["cache-control"]="no-store";
      res.writeHead(remote.statusCode??502,safe);remote.pipe(res);remote.on("error",()=>res.destroy());
    });
    upstream.once("close",()=>{void pinned.close();});
    upstream.setTimeout(30000,()=>upstream.destroy());upstream.on("error",()=>gatewayError(res,new ProjectError("PROJECT_SITE_SLEEPING",preview?"预览已休眠，请从工作台重新启动。":"网站正在恢复，请稍后重试。",503)));
    req.on("aborted",()=>upstream.destroy());req.pipe(upstream);
  }catch(e){gatewayError(res,e);}
})();});
await pool.query("SELECT id FROM harness_projects LIMIT 0");
const lease=await pool.connect();
const acquired=await lease.query<{locked:boolean}>("SELECT pg_try_advisory_lock(726910231) AS locked");
if(!acquired.rows[0]?.locked)throw new Error("Another project service owns execution.");
lease.on("error",()=>process.exit(1));
const interrupted=(await pool.query<{project_id:string;kind:string;result:{versionId?:string}}>("UPDATE harness_project_operations SET status='interrupted',error='服务重启中断了操作；请检查状态后重新执行，原网站保留。',updated_at=now() WHERE status='running' RETURNING project_id,kind,result")).rows;
for(const op of interrupted){
 const versionId=op.result?.versionId;if(!brokerOnly&&versionId)await stopCandidate(op.project_id,versionId,op.kind==="publish"||op.kind==="rollback"?"production":"development").catch(()=>undefined);
}
const existingProjects=(await pool.query<{id:string;active_version:string|null}>("SELECT id,active_version FROM harness_projects")).rows;
for(const project of existingProjects){
  if(project.active_version){await brokers.ensure(project.id,"production");if(!brokerOnly)await exec({action:"reconcile",projectId:project.id,versionId:project.active_version,mode:"production"}).catch(()=>undefined);}
 const preview=(await pool.query("SELECT id FROM harness_project_operations WHERE project_id=$1 AND kind='preview' AND status='completed' LIMIT 1",[project.id])).rowCount;
 if(!brokerOnly&&preview){await brokers.ensure(project.id,"development");touches.set(project.id,Date.now());}
}
await mkdir("/run/daoyin-projects",{recursive:true,mode:0o750});await unlink(socket).catch(()=>undefined);
http.createServer((req,res)=>{
  if(brokerOnly){res.writeHead(410,{"Content-Type":"application/json"}).end(JSON.stringify({error:{code:"PROJECT_RUNTIME_RETIRED",message:"Legacy project execution has moved to generic resources."}}));return;}
  if(req.method!=="POST"||req.url!=="/control"){res.writeHead(404).end();return;}
  let body="";req.on("data",(b:Buffer)=>{body+=b.toString();if(Buffer.byteLength(body)>1048576)req.destroy();});
  const controller=new AbortController();
  req.on("aborted",()=>controller.abort());
  res.on("close",()=>{if(!res.writableEnded)controller.abort();});
  req.on("end",()=>{void Promise.resolve().then(()=>control(JSON.parse(body) as RequestBody,controller.signal)).then(v=>res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify(v))).catch(e=>{
    const err=e instanceof ProjectError?e:new ProjectError("PROJECT_SERVICE_FAILED","项目操作未完成；已保存的代码保持不变。",503);
    res.writeHead(err.status,{"Content-Type":"application/json"}).end(JSON.stringify({error:{code:err.code,message:err.message}}));
  });});
}).listen(socket,()=>{void chown(socket,process.getuid!(),Number(process.env.HARNESS_PROJECT_CONTROL_GID)).then(()=>chmod(socket,0o660));});
gateway.listen(4715,"127.0.0.1");
if(!brokerOnly)setInterval(()=>{void worker();},2000).unref();
setInterval(()=>{void(async()=>{
  for(const[id,at]of touches)if(Date.now()-at>900000){await exec({action:"stop",projectId:id,mode:"development"}).catch(()=>undefined);touches.delete(id);}
  await pool.query("DELETE FROM harness_project_preview_tickets WHERE expires_at<now()");
  await pool.query("DELETE FROM harness_project_preview_sessions WHERE expires_at<now()");
})().catch(()=>undefined);},30000).unref();
process.stdout.write("Cloud project service listening; account admission is explicitly configured.\n");
