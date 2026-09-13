import http from "node:http";
import { ProjectError } from "./contracts.js";
export async function unixJson<T>(socketPath:string,path:string,body:unknown,signal?:AbortSignal,timeout=15000):Promise<T>{
  const bytes=Buffer.from(JSON.stringify(body));
  return new Promise((resolve,reject)=>{
    const req=http.request({socketPath,path,method:"POST",headers:{"Content-Type":"application/json","Content-Length":String(bytes.length)},
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
