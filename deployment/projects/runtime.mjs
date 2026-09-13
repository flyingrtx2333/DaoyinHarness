import http from "node:http";
import {readFile,lstat,chmod,unlink} from "node:fs/promises";
import path from "node:path";
export function broker(input){
 return new Promise((resolve,reject)=>{
  const body=Buffer.from(JSON.stringify(input));
  const req=http.request({socketPath:"/run/broker/broker.sock",path:"/broker",method:"POST",headers:{"Content-Type":"application/json","Content-Length":body.length}},res=>{
   let result="";res.on("data",b=>{result+=b;if(result.length>7500000)res.destroy()});
   res.on("end",()=>{try{const v=JSON.parse(result);if(res.statusCode>=400)reject(Object.assign(new Error(v.error),{status:res.statusCode}));else resolve(v)}catch(e){reject(e)}});res.on("error",reject);
  });req.setTimeout(20000,()=>req.destroy(new Error("服务响应超时")));req.on("error",reject);req.end(body);
 });
}
export function startApp(routes={}){
 const socket="/run/app/app.sock";
 const server=http.createServer(async(req,res)=>{
  res.setHeader("X-Content-Type-Options","nosniff");
  try{
   const host=req.headers.host;
   const origin="https://"+host;
   if(!/^(?:h-|p-)[a-z0-9-]+\.demo\.daoyintech\.com$/.test(host??"")&&req.url!=="/health")throw Object.assign(new Error("域名无效"),{status:403});
   if(req.url==="/health"){res.writeHead(200,{"Content-Type":"application/json"}).end('{"ok":true}');return;}
   const url=new URL(req.url,origin),parts=url.pathname.split("/").filter(Boolean);
   const cookie=String(req.headers.cookie??"").split(";").map(s=>s.trim()).find(s=>s.startsWith("__Host-hp-user="))?.slice(15)??"";
   if(!["GET","HEAD"].includes(req.method)&&req.headers.origin!==origin)throw Object.assign(new Error("请求来源无效"),{status:403});
   let body={};
   if(!["GET","HEAD"].includes(req.method)){
    let text="";for await(const b of req){text+=b;if(Buffer.byteLength(text)>7500000)throw Object.assign(new Error("上传内容过大"),{status:413})}
    body=JSON.parse(text||"{}");
   }
   let result;
   if(parts[0]==="api"){
    res.setHeader("Cache-Control","no-store");
    if(parts[1]==="auth"){
     const action=parts[2];if(!["register","login","logout","me"].includes(action)||req.method!==(action==="me"?"GET":"POST"))throw Object.assign(new Error("接口不存在"),{status:404});
     result=await broker({...body,action,token:cookie});
     if(result.token){res.setHeader("Set-Cookie","__Host-hp-user="+result.token+"; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=604800");delete result.token}
     if(action==="logout")res.setHeader("Set-Cookie","__Host-hp-user=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0");
    }else if(parts[1]==="data"){
     const action=req.method==="GET"?(parts[3]?"get":"list"):req.method==="POST"?"create":req.method==="PUT"?"update":req.method==="DELETE"?"delete":null;
     if(!action)throw Object.assign(new Error("请求方法无效"),{status:405});
     result=await broker({action,collection:parts[2],id:parts[3],data:body,token:cookie});
    }else if(parts[1]==="uploads"){
     if(req.method==="POST")result=await broker({action:"upload",name:body.name,data:body.data,token:cookie});
     else if(req.method==="GET"&&parts[2]){
      result=await broker({action:"download",id:parts[2],token:cookie});
      res.writeHead(200,{"Content-Type":"application/octet-stream","Content-Disposition":"attachment; filename*=UTF-8''"+encodeURIComponent(result.name)}).end(Buffer.from(result.data,"base64"));return;
     }else throw Object.assign(new Error("请求方法无效"),{status:405});
    }else if(routes[url.pathname])result=await routes[url.pathname]({req,body,broker,token:cookie});
    else throw Object.assign(new Error("接口不存在"),{status:404});
    res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify(result));return;
   }
   if(!["GET","HEAD"].includes(req.method))throw Object.assign(new Error("请求方法无效"),{status:405});
   const root="/app/dist";
   const pathname=decodeURIComponent(url.pathname);if(pathname.includes("\\")||pathname.split("/").includes(".."))throw Object.assign(new Error("路径无效"),{status:400});
   let file=path.resolve(root,"."+pathname);
   if(!file.startsWith(root+"/"))file=root+"/index.html";
   try{if(!(await lstat(file)).isFile())file=root+"/index.html"}catch{file=root+"/index.html"}
   const types={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".svg":"image/svg+xml",".json":"application/json"};
   const content=await readFile(file);res.writeHead(200,{"Content-Type":types[path.extname(file)]??"application/octet-stream","Cache-Control":file.endsWith(".html")?"no-cache":"public, max-age=3600"}).end(req.method==="HEAD"?undefined:content);
  }catch(e){res.writeHead(e.status??500,{"Content-Type":"application/json"}).end(JSON.stringify({error:e.status?e.message:"请求未完成"}));}
 });
 unlink(socket).catch(()=>{}).then(()=>server.listen(socket,()=>chmod(socket,0o666)));
 return server;
}
