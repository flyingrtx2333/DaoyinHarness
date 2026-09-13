import {open} from "node:fs/promises";
import {constants} from "node:fs";
import http from "node:http";
import { ProjectError } from "./contracts.js";
export async function unixJson<T>(socketPath:string,path:string,body:unknown,signal?:AbortSignal,timeout=15000):Promise<T>{
  const bytes=Buffer.from(JSON.stringify(body));
  return new Promise((resolve,reject)=>{
    const req=http.request({agent:false,socketPath,path,method:"POST",headers:{"Content-Type":"application/json","Content-Length":String(bytes.length)},
      ...(signal?{signal}:{})},res=>{
      const chunks:Buffer[]=[];let count=0;
      res.on("data",(chunk:Buffer)=>{count+=chunk.length;if(count>8388608){res.destroy();reject(new ProjectError("PROJECT_RESPONSE_LIMIT","项目服务返回内容过大。",502));}else chunks.push(chunk);});
      res.on("error",reject);res.on("end",()=>{
        try{const value=JSON.parse(Buffer.concat(chunks).toString()) as T & {error?:{code:string;message:string}};
          if((res.statusCode??500)>=400)reject(new ProjectError(value.error?.code??"PROJECT_SERVICE_FAILED",value.error?.message??"项目服务暂不可用。",res.statusCode));else resolve(value);
        }catch{reject(new ProjectError("PROJECT_RESPONSE_INVALID","项目服务返回格式无效。",502));}
      });
    });
    req.setTimeout(timeout,()=>req.destroy(new Error("Project service timeout")));
    req.on("error",reject);req.end(bytes);
  });
}

// Linux O_PATH pins the actual Unix socket inode. O_NOFOLLOW rejects a user-created
// symlink, and /proc/self/fd avoids a path-replacement race before connect().
export async function pinAppSocket(socketPath:string):Promise<{path:string;close:()=>Promise<void>}>{
 const handle=await open(socketPath,0x200000|constants.O_NOFOLLOW);
 try{
  const stat=await handle.stat();
  if(!stat.isSocket())throw new ProjectError("PROJECT_SOCKET_INVALID","应用通信入口无效。",503);
  return {path:"/proc/self/fd/"+handle.fd,close:()=>handle.close()};
 }catch(e){await handle.close();throw e;}
}
