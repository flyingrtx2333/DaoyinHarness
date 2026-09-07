// Read-only inspection for the existing server deployment. Never print credentials or user records.
import { readFile, readlink, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const info = { inspectedAt: new Date().toISOString() };
for (const [label, path] of Object.entries({runtime:'/opt/daoyin-harness/current',workbench:'/opt/daoyin-harness/workbench/current'})) {
  try { info[label] = {path, target:await readlink(path), release:JSON.parse(await readFile(path+'/release.json','utf8'))}; }
  catch(e) { info[label]={path,error:e.code??'unavailable'}; }
}
for (const path of ['/opt/daoyin-harness','/opt/daoyin-harness/workbench','/www/server/panel/vhost/nginx']) {
  try { info[path] = await readdir(path); } catch(e) {info[path]=e.code;}
}
const raw = await readFile('/etc/daoyin-harness/cloud.env','utf8');
const env = Object.fromEntries(raw.split('\n').filter(x=>x.trim()&&!x.trim().startsWith('#')).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1).trim().replace(/^['"]|['"]$/g,'')];}));
info.config = {port:env.DAOYIN_CLOUD_PORT,platform:env.DAOYIN_CLOUD_PLATFORM_URL,postgresConfigured:!!env.DAOYIN_CLOUD_POSTGRES_URL,privateAppBridgeConfigured:!!env.DAOYIN_CLOUD_APP_SERVICE_TOKEN,publicBridgeConfigured:!!env.DAOYIN_CLOUD_SERVICE_TOKEN};
info.node = execFileSync('/opt/daoyin-harness/node/bin/node',['--version'],{encoding:'utf8'}).trim();
info.sourceRevision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
info.disk=execFileSync('df',['-h','/opt/daoyin-harness'],{encoding:'utf8'}).trim();
for (const url of ['http://127.0.0.1:4700/health','https://www.daoyintech.com/harness/','https://www.daoyintech.com/harness/release.json']) {
  try {const r=await fetch(url,{signal:AbortSignal.timeout(10000)});const text=await r.text(); info[url]={status:r.status,...(url.endsWith('release.json')||url.endsWith('/health')?{body:text.slice(0,2000)}:{title:text.match(/<title>(.*?)<\/title>/s)?.[1],assets:[...text.matchAll(/(?:src|href)="(\/harness\/assets\/[^\"]+)"/g)].map(x=>x[1])})};} catch(e){info[url]={error:e.name};}
}
// Runtime compatibility probes use existing credentials in memory and report only status flags.
for (const [kind, key] of [['agent-public','DAOYIN_CLOUD_SERVICE_TOKEN'],['agent-apps','DAOYIN_CLOUD_APP_SERVICE_TOKEN']]) {
  if (!env[key]) continue;
  try {const r=await fetch(new URL(`/api/internal/${kind}/v1/health`,env.DAOYIN_CLOUD_PLATFORM_URL),{method:'POST',redirect:'error',headers:{'content-type':'application/json','x-agent-service-token':env[key]},body:'{}',signal:AbortSignal.timeout(8000)}); let body; try {body=await r.json();} catch {} info[kind+'-health']={status:r.status,schemaVersion:body?.schemaVersion,healthStatus:body?.status};} catch(e){info[kind+'-health']={error:e.name};}
}
if (env.DAOYIN_CLOUD_POSTGRES_URL) {
  const {createRequire}=await import('node:module');
  const {Pool}=createRequire('/opt/daoyin-harness/current/package.json')('pg');
  const pool=new Pool({connectionString:env.DAOYIN_CLOUD_POSTGRES_URL,max:1,connectionTimeoutMillis:5000});
  try {info.activeRuns=(await pool.query("SELECT status,COUNT(*)::integer AS count FROM cloud_runs WHERE status='running' GROUP BY status")).rows; info.tables=(await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND (table_name LIKE 'memory_%' OR table_name='durable_memories') ORDER BY table_name")).rows.map(r=>r.table_name);} catch(e){info.databaseInspection={errorCode:e.code??'failed'};} finally {await pool.end();}
}
console.log(JSON.stringify(info,null,2));
