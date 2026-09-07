// Deploy committed artifacts to this installation; no tests, migrations, or platform writes.
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, cp, copyFile, readlink, symlink, rename, lstat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve, dirname, join } from 'node:path';
const args = process.argv.slice(2);
const revision = args.find(a => /^[a-f0-9]{40}$/.test(a));
if (!args.includes('--apply') || !revision || process.platform !== 'linux' || process.getuid?.() !== 0) {
  throw new Error('Run as root in the independent Linux clone: node scripts/deploy-existing-server.mjs --apply <40-character revision>');
}
const base='/opt/daoyin-harness', service='daoyin-harness-cloud.service';
const runtimeSource=resolve('.cache/cloud-release',revision), uiSource=resolve('.cache/workbench-release',revision);
const runtimeDest=join(base,'releases',revision), uiDest=join(base,'workbench/releases',revision);
const runtimeLink=join(base,'current'), uiLink=join(base,'workbench/current');
const report={revision,startedAt:new Date().toISOString(),environment:'independent-linux-server',testsRun:false,realModelValidation:'not-run',dataMigration:false};
const phase=(name)=>console.log(JSON.stringify({phase:name,revision}));
const run=(file,argv,options={})=>{try{return execFileSync(file,argv,{encoding:'utf8',timeout:60000,stdio:['ignore','pipe','pipe'],...options});}catch(e){throw new Error(`Command failed: ${file} (exit ${e.status??'unknown'}); raw output withheld to protect configuration.`);}};
const digest=b=>createHash('sha256').update(b).digest('hex');
async function verify(path, ui=false){
  const manifest=JSON.parse(await readFile(join(path,'release.json'),'utf8'));
  if(manifest.revision!==revision || manifest.preview===true || !manifest.files) throw new Error('Release revision/preview mismatch.');
  for(const [file,expected] of Object.entries(manifest.files)){
    if(!/^(?:assets\/)?[A-Za-z0-9_.-]+$/.test(file) || digest(await readFile(join(path,file)))!==expected)throw new Error('Artifact integrity mismatch.');
  }
  if(!manifest.files[ui?'index.html':'main.mjs'])throw new Error('Missing release entrypoint.');
  return manifest;
}
async function replaceLink(path,target){
  if(!(await lstat(path)).isSymbolicLink())throw new Error('Expected a deployment symlink; refusing to replace a directory.');
  const temp=path+'.next-'+randomUUID();await symlink(target,temp);await rename(temp,path);
}
async function probe(url,expectedStatus=200){
  const response=await fetch(url,{signal:AbortSignal.timeout(7000),redirect:'error',headers:{'cache-control':'no-cache'}});
  if(response.status!==expectedStatus)throw new Error(`Endpoint status ${response.status}: ${url}`);
  return response;
}
const oldRuntime=await readlink(runtimeLink),oldUi=await readlink(uiLink);
if(!oldRuntime.startsWith(base+'/releases/') || !oldUi.startsWith(base+'/workbench/releases/'))throw new Error('Unexpected deployment layout.');
report.previous={runtime:oldRuntime,workbench:oldUi};
const journal=join(base,'deployments',new Date().toISOString().replaceAll(':','-')+'-'+revision.slice(0,7)+'.json');
await mkdir(dirname(journal),{recursive:true,mode:0o700});
const save=()=>writeFile(journal,JSON.stringify(report,null,2)+'\n',{mode:0o600});
await save();
phase('verify-and-stage');
const runtimeManifest=await verify(runtimeSource),uiManifest=await verify(uiSource,true);
for(const [src,dest]of [[runtimeSource,runtimeDest],[uiSource,uiDest]]){
  try{await lstat(dest);await verify(dest,dest===uiDest);}catch(e){if(e.code!=='ENOENT')throw e;await cp(src,dest,{recursive:true,errorOnExist:true,force:false});}
}
run(join(base,'node/bin/node'),[join(base,'node/lib/node_modules/npm/bin/npm-cli.js'),'ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:runtimeDest,timeout:120000,env:{...process.env,PATH:join(base,'node/bin')+':'+process.env.PATH}});
await verify(runtimeDest);await verify(uiDest,true);
// Preserve every old hashed asset for already-open browsers.
for(const [file,hash]of Object.entries(uiManifest.files)){
  if(!file.startsWith('assets/'))continue;
  const dest=join(base,'workbench',file);await mkdir(dirname(dest),{recursive:true});
  try{if(digest(await readFile(dest))!==hash)throw new Error('Hashed asset name collision.');}
  catch(e){if(e.code!=='ENOENT')throw e;await copyFile(join(uiDest,file),dest);}
}
const raw=await readFile('/etc/daoyin-harness/cloud.env','utf8');
const env=Object.fromEntries(raw.split('\n').filter(x=>x.trim()&&!x.trim().startsWith('#')).map(x=>{const i=x.indexOf('=');return[x.slice(0,i),x.slice(i+1).trim().replace(/^['"]|['"]$/g,'')];}));
if(!env.DAOYIN_CLOUD_POSTGRES_URL || env.DAOYIN_CLOUD_PORT!=='4700')throw new Error('Expected existing PostgreSQL/4700 configuration.');
const {Pool}=createRequire(join(runtimeDest,'package.json'))('pg');
const pool=new Pool({connectionString:env.DAOYIN_CLOUD_POSTGRES_URL,max:1,connectionTimeoutMillis:5000});
try{const counts=await pool.query("SELECT count(*)::integer AS n FROM cloud_runs WHERE status='running'");if(counts.rows[0].n!==0)throw new Error('Active runs exist; no service switch performed.');report.activeRunsBeforeSwitch=0;}finally{await pool.end();}
report.artifacts={runtime:runtimeManifest.files,workbench:uiManifest.files};
report.build={platform:'linux',node:run(join(base,'node/bin/node'),['--version']).trim()};
report.phase='staged';await save();
let stopped=false;
try{
  phase('switch-runtime');run('systemctl',['stop',service]);stopped=true;
  await replaceLink(runtimeLink,runtimeDest);
  run('systemctl',['start',service]);
  let ready=false;
  for(let i=0;i<12;i++){
    try{const r=await probe('http://127.0.0.1:4700/health/ready');if((await r.json()).status==='ready'){ready=true;break;}}catch{}
    await new Promise(r=>setTimeout(r,1000));
  }
  if(!ready)throw new Error('New runtime did not become ready; rolling back.');
  phase('switch-workbench');await replaceLink(uiLink,uiDest);
  const publicRelease=await(await probe('https://www.daoyintech.com/harness/release.json')).json();
  if(publicRelease.revision!==revision)throw new Error('Public workbench revision mismatch.');
  const html=await(await probe('https://www.daoyintech.com/harness/')).text();
  if(digest(Buffer.from(html))!==uiManifest.files['index.html'])throw new Error('Public workbench HTML differs from release.');
  for(const[file,hash]of Object.entries(uiManifest.files)){
    if(!file.startsWith('assets/'))continue;
    const actual=Buffer.from(await(await probe('https://www.daoyintech.com/harness/'+file)).arrayBuffer());
    if(digest(actual)!==hash)throw new Error('Public asset integrity mismatch.');
  }
  await probe('http://127.0.0.1:4700/api/v1/cloud/sessions',401);
  if(run('systemctl',['is-active',service]).trim()!=='active')throw new Error('Runtime service inactive.');
  report.phase='deployed';report.health={readiness:'ready',publicWorkbench:200,publicAssetHashes:'matched',anonymousApi:401};
  report.completedAt=new Date().toISOString();await save();console.log(JSON.stringify({...report,journal},null,2));
}catch(e){
  report.failure=e.message;report.phase='failed';
  if(stopped){
    try{run('systemctl',['stop',service]);await replaceLink(runtimeLink,oldRuntime);await replaceLink(uiLink,oldUi);run('systemctl',['start',service]);report.rollback='restored-previous-links-and-service';}
    catch(rollback){report.rollback=rollback.message;}
  }
  await save();console.error(JSON.stringify({phase:report.phase,failure:report.failure,rollback:report.rollback,journal}));process.exitCode=1;
}
