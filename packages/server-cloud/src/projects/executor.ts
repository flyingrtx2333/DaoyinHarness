import { registerDomain } from "./domains.js";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, lstat, readdir, chmod, chown, unlink, symlink, rename, rm } from "node:fs/promises";
import path from "node:path";
import { ProjectError, identifier, checkedFiles, type ExecutorRequest } from "./contracts.js";
import { unixJson } from "./wire.js";
const ROOT="/var/lib/daoyin-projects";
const IMAGE=process.env.HARNESS_PROJECT_IMAGE??"daoyin-harness-app:20260913";
const RUNTIME="harness-runsc";
const SOCKET="/run/daoyin-project-executor/control.sock";
const gid=Number(process.env.HARNESS_PROJECT_GID);
if(!Number.isSafeInteger(gid)||gid<1||process.getuid?.()!==0)throw new Error("Executor requires root and a dedicated project service group.");
let ready=false;
let buildBusy=false;
async function command(args:string[],timeout=600000):Promise<string>{
  return new Promise((resolve,reject)=>{
    const proc=spawn("/usr/bin/docker",args,{cwd:ROOT,env:{PATH:"/usr/bin:/bin",HOME:"/nonexistent"},stdio:["ignore","pipe","pipe"]});
    let output="";let exceeded=false;
    const timer=setTimeout(()=>{proc.kill("SIGKILL");reject(new ProjectError("PROJECT_COMMAND_TIMEOUT","运行检查超时；源码和原发布版本已保留。",504));},timeout);
    const data=(b:Buffer):void=>{if(Buffer.byteLength(output)+b.length>131072){exceeded=true;proc.kill("SIGKILL");}else output+=b.toString();};
    proc.stdout.on("data",data);proc.stderr.on("data",data);
    proc.on("error",e=>{clearTimeout(timer);reject(e);});
    proc.on("close",code=>{clearTimeout(timer);if(code===0&&!exceeded)resolve(output);else reject(new ProjectError("PROJECT_COMMAND_FAILED",exceeded?"运行输出超过限制；源码已保留。":"构建或启动检查未通过："+output.split("\n").filter(line=>/error|failed|Error/iu.test(line)).slice(0,5).join("\n").replaceAll(ROOT,"项目目录").slice(0,1800),422));});
  });
}
async function headroom(mib:number):Promise<void>{
  const mem=await readFile("/proc/meminfo","utf8");
  const available=Number(/MemAvailable:\s+(\d+)/u.exec(mem)?.[1]??0)/1024;
  if(available<mib+1024)throw new ProjectError("PROJECT_CAPACITY_WAIT","服务器资源暂不足，操作正在等待；当前网站保持运行。",429);
}
const baseArgs=(name:string,memory:string,cpu:string):string[]=>[
  "run","--runtime",RUNTIME,"--name",name,"--label","daoyin.harness.project=1","--network","none",
  "--user","1000:1000","--cap-drop","ALL","--security-opt","no-new-privileges","--read-only",
  "--memory",memory,"--memory-swap",memory,"--cpus",cpu,"--pids-limit","256",
  "--ulimit","nofile=1024:1024","--log-driver","local","--log-opt","max-size=1m","--log-opt","max-file=2",
  "--tmpfs","/tmp:rw,nosuid,nodev,size=256m,mode=1777","--workdir","/app","--env","HOME=/tmp",
  "--env","NODE_ENV=production"
];
async function safeTree(root:string,writeMode=false):Promise<number>{
  let total=0;
  const walk=async(dir:string):Promise<void>=>{
    for(const name of await readdir(dir)){
      const p=path.join(dir,name),s=await lstat(p);
      if(s.isSymbolicLink()||(!s.isFile()&&!s.isDirectory())||(s.isFile()&&s.nlink>1))throw new ProjectError("PROJECT_ARTIFACT_INVALID","构建产物包含不允许的链接或设备。",422);
      if(s.isDirectory())await walk(p);else{total+=s.size;if(total>20971520)throw new ProjectError("PROJECT_ARTIFACT_QUOTA","构建产物超过 20 MB。",413);}
      if(writeMode){await chown(p,0,0);await chmod(p,s.isDirectory()?0o755:0o644);}
    }
  };await walk(root);return total;
}
async function prepare(input:ExecutorRequest):Promise<string>{
  const id=identifier(input.projectId,"prj"),version=identifier(input.versionId,"ver");
  const root=path.join(ROOT,"versions",id,version);
  try{await lstat(path.join(root,"ready"));return root;}catch{/* New version. */}
  const files=checkedFiles(input.files);
  const temp=root+".preparing";
  try{const info=await lstat(temp);if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==0)throw new Error("Unsafe preparation directory");await rm(temp,{recursive:true});}catch(e){if(!(e instanceof Error)||!("code" in e)||e.code!=="ENOENT")throw e;}
  await mkdir(temp,{recursive:true,mode:0o755});
  for(const f of files){const p=path.join(temp,f.path);await mkdir(path.dirname(p),{recursive:true,mode:0o755});await writeFile(p,f.content,{mode:0o644,flag:"wx"});}
  await symlink("/opt/node_modules",path.join(temp,"node_modules"));
  await writeFile(path.join(temp,"ready"),"source-v1",{mode:0o444});
  await rename(temp,root);
  return root;
}
async function build(input:ExecutorRequest):Promise<string>{
  if(buildBusy)throw new ProjectError("PROJECT_CAPACITY_WAIT","另一个项目正在构建，请稍候。",429);
  await headroom(1536);
  const id=identifier(input.projectId,"prj"),version=identifier(input.versionId,"ver");
  const name="hp-build-"+id.slice(4)+"-"+version.slice(4,12);
  const root=await prepare(input);
  const output=path.join(ROOT,"artifacts",id,version);
  buildBusy=true;
  try{
    try{await lstat(output+".complete");return output;}catch{/* Build once. */}
    await mkdir(output,{recursive:true,mode:0o755});await chown(output,1000,1000);
    const args=[...baseArgs(name,"1536m","1"),"--mount","type=bind,src="+root+",dst=/app,readonly",
      "--mount","type=bind,src="+output+",dst=/output",IMAGE,"node","/opt/harness/build.mjs"];
    await command(args);
    await command(["rm",name],30000);
    await safeTree(output,true);await chown(output,0,0);await chmod(output,0o755);
    await writeFile(output+".complete",version,{mode:0o444});
    return output;
  }finally{
    await command(["rm","-f",name],30000).catch(()=>undefined);
    buildBusy=false;
  }
}
function instance(input:ExecutorRequest):{name:string;root:string;socket:string}{
  const id=identifier(input.projectId,"prj"),version=identifier(input.versionId,"ver");
  const mode=input.mode==="production"?"production":"development";
  const name="hp-"+id.slice(4)+"-"+mode+"-"+version.slice(4,12);
  const root=path.join(ROOT,"instances",name);
  return {name,root,socket:path.join(root,"app.sock")};
}
async function healthy(socket:string):Promise<void>{
  await unixJson(socket,"/health",{},undefined,3000);
}
async function start(input:ExecutorRequest):Promise<Record<string,unknown>>{
  const production=input.mode==="production",target=instance(input);
  try{await healthy(target.socket);return{...target,reused:true};}catch{/* Start or recover. */}
  if(production){
    const all=(await command(["ps","--filter","label=daoyin.harness.project=1","--format","{{.Names}}"])).trim().split("\n");
    const projects=new Set(all.filter(n=>n.includes("-production-")).map(n=>n.split("-production-")[0]));
    if(projects.size>=2&&!projects.has("hp-"+input.projectId.slice(4)))throw new ProjectError("PROJECT_HOSTING_QUOTA","试运行最多同时托管两个网站；当前网站保持运行。",429);
    if(all.filter(n=>n.includes("-production-")).length>=3)throw new ProjectError("PROJECT_CAPACITY_WAIT","发布切换资源正被使用，请稍候。",429);
  }else{
    const all=(await command(["ps","--filter","label=daoyin.harness.project=1","--format","{{.Names}}"])).trim().split("\n");
    const others=all.filter(n=>n.includes("-development-"));
    for(const n of others){
      if(n.startsWith("hp-"+input.projectId.slice(4)+"-"))await command(["rm","-f",n],30000);
      else throw new ProjectError("PROJECT_CAPACITY_WAIT","另一个项目正在预览；空闲后将自动释放环境。",429);
    }
  }
  const artifact=await build(input);
  await headroom(production?512:1536);
  await mkdir(target.root,{recursive:true,mode:0o711});await chown(target.root,1000,1000);
  await unlink(target.socket).catch(()=>undefined);
  await command(["rm","-f",target.name],30000).catch(()=>undefined);
  const source=path.join(ROOT,"versions",input.projectId,input.versionId!);
  const broker=path.join("/run/daoyin-projects/brokers",input.projectId,production?"production":"development");
  const args=[...baseArgs(target.name,production?"512m":"1536m",production?"0.5":"1"),"-d",
    "--mount","type=bind,src="+source+",dst=/app,readonly",
    "--mount","type=bind,src="+artifact+",dst=/app/dist,readonly",
    "--mount","type=bind,src="+target.root+",dst=/run/app",
    "--mount","type=bind,src="+broker+",dst=/run/broker,readonly",
    IMAGE,"/opt/node_modules/.bin/tsx","server.ts"];
  try{
    await command(args,30000);
    for(let i=0;i<30;i++){
      try{await healthy(target.socket);return{...target,reused:false};}catch{await new Promise(r=>setTimeout(r,500));}
    }
    throw new ProjectError("PROJECT_HEALTH_FAILED","新版本启动检查失败，原网站保持运行。",422);
  }catch(e){await command(["rm","-f",target.name],30000).catch(()=>undefined);throw e;}
}
async function dispatch(input:ExecutorRequest):Promise<unknown>{
  if(input.action==="domains"){await registerDomain(input.projectId,String(input.slug));return{registered:true};}
  if(input.action==="readiness")return{ready,runtime:RUNTIME,network:"none",image:IMAGE};
  if(!ready)throw new ProjectError("PROJECT_SANDBOX_UNAVAILABLE","隔离执行环境尚未就绪；已保存的项目不受影响。",503);
  identifier(input.projectId,"prj");
  if(input.action==="prepare")return{path:await prepare(input)};
  if(input.action==="check")return{artifact:await build(input),checked:true};
  if(input.action==="preview"||input.action==="publish"||input.action==="rollback")return start(input);
  if(input.action==="status"){
    const target=instance(input);try{await healthy(target.socket);return{running:true,...target};}catch{return{running:false,...target};}
  }
  if(input.action==="stop"){
    const prefix="hp-"+input.projectId.slice(4)+"-"+(input.mode==="production"?"production":"development")+"-";
    const names=(await command(["ps","-a","--filter","label=daoyin.harness.project=1","--format","{{.Names}}"])).trim().split("\n");
    for(const name of names)if((name.startsWith("hp-build-"+input.projectId.slice(4)+"-")&&input.mode!=="production")||name.startsWith(prefix)&&(!input.versionId||name===instance(input).name))await command(["rm","-f",name],30000);
    return{stopped:true};
  }
  throw new ProjectError("PROJECT_EXECUTOR_OPERATION_DENIED","不允许的执行操作。",403);
}
await mkdir(ROOT,{recursive:true,mode:0o711});
await mkdir(path.dirname(SOCKET),{recursive:true,mode:0o750});
await chown(path.dirname(SOCKET),0,gid);
await unlink(SOCKET).catch(()=>undefined);
try{
  const info=JSON.parse(await command(["info","--format","{{json .Runtimes}}"],15000)) as Record<string,unknown>;
  if(!info[RUNTIME])throw new Error("Missing isolated runtime");
  await command([...baseArgs("hp-probe","128m","0.2"),"--rm",IMAGE,"node","-e","process.stdout.write('isolated-node-ok')"],30000);
  ready=true;
}catch{process.stderr.write("Project isolation probe unavailable; execution remains disabled.\n");}
http.createServer((req,res)=>{
  if(req.method!=="POST"||req.url!=="/execute"){res.writeHead(404).end();return;}
  let body="";req.on("data",(b:Buffer)=>{body+=b.toString();if(Buffer.byteLength(body)>1048576)req.destroy();});
  req.on("end",()=>{void(async()=>{
    try{const value=await dispatch(JSON.parse(body) as ExecutorRequest);res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify(value));}
    catch(e){const err=e instanceof ProjectError?e:new ProjectError("PROJECT_EXECUTOR_FAILED","隔离执行失败；源码和原发布版本保留。",503);
      res.writeHead(err.status,{"Content-Type":"application/json"}).end(JSON.stringify({error:{code:err.code,message:err.message}}));}
  })();});
}).listen(SOCKET,()=>{void chown(SOCKET,0,gid).then(()=>chmod(SOCKET,0o660));});
