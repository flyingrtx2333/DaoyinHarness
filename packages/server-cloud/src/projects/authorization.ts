import http from "node:http";
import {unlink,chmod} from "node:fs/promises";
import type {FastifyInstance} from "fastify";
import {assertExecutionIdentity,type ExecutionIdentity} from "@daoyin/harness-contracts";
import type {CloudRepository} from "../repository.js";
export function registerProjectAuthorization(app:FastifyInstance,options:{
 repository:CloudRepository;ensureActive(identity:ExecutionIdentity,signal?:AbortSignal):Promise<void>;
}):void{
 const socket=process.env.DAOYIN_PROJECT_AUTH_SOCKET;
 if(socket!=="/run/daoyin-project-authorization/auth.sock")return;
 const server=http.createServer((req,res)=>{
  if(req.method!=="POST"||req.url!=="/authorize"){res.writeHead(404).end();return;}
  let bytes="";req.on("data",(b:Buffer)=>{bytes+=b.toString();if(Buffer.byteLength(bytes)>16384)req.destroy();});
  req.on("end",()=>{void(async()=>{
   try{
    const value=JSON.parse(bytes) as {identity:unknown;sourceRun?:unknown};assertExecutionIdentity(value.identity);
    await options.ensureActive(value.identity,AbortSignal.timeout(5000));
    if(typeof value.sourceRun==="string"){
     const run=await options.repository.getRun(value.identity,value.sourceRun);
     if(run.cancelRequested||["cancelled","failed","interrupted"].includes(run.status))throw new Error("Run no longer allows work");
    }
    res.writeHead(200,{"Content-Type":"application/json"}).end('{"active":true}');
   }catch{res.writeHead(403,{"Content-Type":"application/json"}).end('{"error":{"code":"PROJECT_AUTHORIZATION_REVOKED","message":"账号权限或对话状态已变化；操作停止，原网站保留。"}}');}
  })();});
 });
 app.addHook("onReady",async()=>{
  await unlink(socket).catch(()=>undefined);
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(socket,resolve);});
  await chmod(socket,0o660);
 });
 app.addHook("onClose",async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await unlink(socket).catch(()=>undefined);});
}
