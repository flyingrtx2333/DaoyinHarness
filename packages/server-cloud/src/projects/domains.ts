import {readFile,writeFile,readdir,rename} from "node:fs/promises";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {identifier,slugValue,ProjectError} from "./contracts.js";
const run=promisify(execFile);
const dir="/www/server/panel/vhost/nginx";
const target=dir+"/harness-projects-independent.conf";
const registry="/var/lib/daoyin-projects/domains.json";
let updating:Promise<unknown>=Promise.resolve();
export function registerDomain(projectId:string,slug:string):Promise<void>{
 const next=updating.then(()=>apply(projectId,slug));updating=next.catch(()=>undefined);return next;
}
async function apply(projectId:string,slug:string):Promise<void>{
 identifier(projectId,"prj");slugValue(slug);
 let entries:Record<string,string>={};
 try{entries=JSON.parse(await readFile(registry,"utf8")) as Record<string,string>;}catch{/* First install. */}
 if(entries[projectId]===slug)return;
 if(Object.entries(entries).some(([id,value])=>value===slug&&id!==projectId))throw new ProjectError("PROJECT_DOMAIN_TAKEN","网址名称已被占用。",409);
 const names=[slug+".demo.daoyintech.com","p-"+projectId.slice(4)+".demo.daoyintech.com"];
 for(const file of await readdir(dir)){
  if(!file.endsWith(".conf")||file==="harness-projects-independent.conf")continue;
  const text=await readFile(dir+"/"+file,"utf8");
  const hosts=[...text.matchAll(/server_name\s+([^;]+);/gu)].flatMap(m=>m[1]!.split(/\s+/u));
  if(names.some(n=>hosts.includes(n)))throw new ProjectError("PROJECT_DOMAIN_TAKEN","网址已由其他站点使用，未覆盖原路由。",409);
 }
 entries[projectId]=slug;
 const hosts=Object.entries(entries).flatMap(([id,value])=>[value+".demo.daoyintech.com","p-"+id.slice(4)+".demo.daoyintech.com"]).join(" ");
 const config=String.raw`# Managed exclusively by the independent Harness project executor.
server {
 listen 80;
 listen [::]:80;
 server_name ${hosts};
 return 301 https://$host$request_uri;
}
server {
 listen 443 ssl;
 listen [::]:443 ssl;
 http2 on;
 server_name ${hosts};
 ssl_certificate /etc/letsencrypt/live/demo.daoyintech.com/fullchain.pem;
 ssl_certificate_key /etc/letsencrypt/live/demo.daoyintech.com/privkey.pem;
 ssl_protocols TLSv1.2 TLSv1.3;
 client_max_body_size 8m;
 add_header Strict-Transport-Security "max-age=31536000" always;
 access_log off;
 location / {
  proxy_pass http://127.0.0.1:4715;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto https;
  proxy_set_header X-Forwarded-For "";
  proxy_set_header Authorization "";
  proxy_read_timeout 35s;
 }
}
`;
 let previous:string|undefined;
 try{previous=await readFile(target,"utf8");}catch{/* New config. */}
 await writeFile(target+".next",config,{mode:0o644});await rename(target+".next",target);
 try{
  await run("/www/server/nginx/sbin/nginx",["-t"],{timeout:15000,maxBuffer:65536});
  await run("/www/server/nginx/sbin/nginx",["-s","reload"],{timeout:15000,maxBuffer:65536});
  await writeFile(registry,JSON.stringify(entries),{mode:0o600});
 }catch{
  await writeFile(target,previous??"# Project domain registration failed; no routes enabled.\n",{mode:0o644});
  throw new ProjectError("PROJECT_DOMAIN_SETUP_FAILED","网址路由检查失败，原有站点未更改。",503);
 }
}
