/* global document, innerWidth -- evaluated inside the actual Chromium page */
// Actual PluginWorkspace + live operator BFF. No fabricated API/model responses.
// Does not test browser login cookies; uses the existing unique active administrator.
// Optional --run-sample creates exactly one bounded, non-destructive real model task.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { createRequire } from 'node:module';
const root = process.cwd(); const out = resolve('output/playwright/evaluation-redesign');
const { build } = createRequire(resolve('packages/cli/package.json'))('esbuild');
const { chromium } = await import(resolve('.cache/evaluation-ui-browser/node_modules/playwright/index.mjs'));
process.env.LD_LIBRARY_PATH = resolve('.cache/evaluation-ui-browser/lib');
const bridgeProgram = String.raw`
import asyncio, json, sys, re, hmac
from database import get_db
from routes import harness_evaluation as api
from services.first_party_accounts import validate_row
from starlette.requests import Request
from starlette.responses import Response
async def main(data):
    with get_db() as conn, conn.cursor() as cur:
        cur.execute("""SELECT DISTINCT s.* FROM first_party_account_sessions s
          JOIN users u ON u.id=s.actor_user_id AND u.status=1
          JOIN tenant_members tm ON tm.user_id=u.id AND tm.status=1
          JOIN tenants t ON t.id=tm.tenant_id AND t.status=1
          JOIN tenant_member_roles tmr ON tmr.tenant_member_id=tm.id AND tmr.status=1
          JOIN roles r ON r.id=tmr.role_id AND r.status=1
          WHERE s.revoked_at IS NULL AND s.expires_at>UTC_TIMESTAMP(6)
            AND r.tenant_id=0 AND r.role_key='admin' ORDER BY s.created_at DESC""")
        rows=cur.fetchall()
        if len({str(row['actor_user_id']) for row in rows}) != 1: raise RuntimeError('Unique active administrator required')
        session=validate_row(cur, rows[0]); api.require_global_admin(cur,int(session['actor_user_id']))
    path=data['path']; method=data['method']; body=data.get('body')
    _, secret, origin=api.configuration()
    scope, csrf=api.assertions(session,secret)
    if path=='/bootstrap' and method=='POST':
        request=Request({'type':'http','headers':[(b'origin',origin.encode())]})
        result=api.bootstrap(api.Strict.model_validate(body),request,Response(),session)
    else:
        if not hmac.compare_digest(data['headers'].get('x-eval-account',''),scope): raise RuntimeError('Account mismatch')
        if method=='POST' and not hmac.compare_digest(data['headers'].get('x-eval-csrf',''),csrf): raise RuntimeError('CSRF mismatch')
        if method=='GET' and (path=='/catalog' or re.fullmatch(r'/runs\?offset=[0-9]+',path) or re.fullmatch(r'/runs/ev_[a-f0-9]{32}(?:/trials/[A-Za-z0-9_-]{1,64}/[1-5]|/report)?',path)):
            result=await api.forward(method,path,session,max_bytes=8_000_000)
        elif method=='POST' and path=='/runs' and data['sampleAllowed']:
            payload=api.NewEvaluation.model_validate(body)
            if payload.title!='界面验收 · 实时题数' or len(payload.cases)!=1 or payload.maxModelCalls!=2 or payload.repetitions!=1: raise RuntimeError('Only the bounded UI sample may execute')
            result=await api.forward(method,path,session,payload.model_dump())
        else: raise RuntimeError('This verifier does not allow that operation')
    return {'status':200,'body':result}
try:
    result=asyncio.run(main(json.load(sys.stdin)))
except Exception as error:
    detail=getattr(error,'detail',None)
    result={'status':getattr(error,'status_code',503),'body':{'detail':detail if isinstance(detail,dict) else {'code':'UI_LIVE_BRIDGE_BLOCKED','message':type(error).__name__}}}
print('__UI_RESPONSE__'+json.dumps(result,ensure_ascii=False))
`;
function upstream(data) { return new Promise((ok, reject) => {
  const child = spawn('docker', ['exec','-i','-w','/app','daoyintech-backend','python','-c',bridgeProgram], {stdio:['pipe','pipe','pipe']});
  let output=''; child.stdout.on('data',part=>{ output+=part; if(output.length>10_000_000) child.kill(); }); child.stderr.resume();
  const timer=setTimeout(()=>child.kill(),20000);
  child.on('error',reject); child.on('close',()=>{clearTimeout(timer); try {const line=output.split('\n').findLast(line=>line.startsWith('__UI_RESPONSE__')); ok(JSON.parse(line.slice('__UI_RESPONSE__'.length)));} catch{reject(new Error('Live bridge did not return a bounded result'));}});
  child.stdin.end(JSON.stringify(data));
});}
await mkdir(out,{recursive:true});
await build({stdin:{contents:`import React from 'react'; import {createRoot} from 'react-dom/client'; import {PluginWorkspace} from './packages/ui/src/cloud/PluginWorkspace.tsx'; import './packages/ui/src/design-tokens.css'; import './packages/ui/src/cloud/cloud.css'; import './packages/ui/src/cloud/cloud-modern.css'; function Preview(){ const [choice,setChoice]=React.useState('saishi');return <div className="workbench"><main className="main"><div className="transcript plugin-transcript"><PluginWorkspace selectedId={choice} onSelect={setChoice} busy={false} authorizedProfiles={['saishi-readonly']} /></div></main></div>};createRoot(document.getElementById('root')).render(<Preview/>);`,loader:'tsx',resolveDir:root},outfile:resolve(out,'app.js'),bundle:true,format:'esm',jsx:'automatic',loader:{'.png':'file'},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
const endpoints=[]; let sampleDispatched=false;
const server=createServer(async(req,res)=>{
  try {
    const host=`127.0.0.1:${server.address().port}`;
    if(req.headers.host!==host || (req.headers.origin && req.headers.origin!==`http://${host}`)){res.writeHead(403);res.end();return;}
    if(req.url.startsWith('/api/harness-evaluation')) {
      const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>512000)throw new Error('Input too large');chunks.push(chunk);}const text=Buffer.concat(chunks).toString();
      const path=req.url.slice('/api/harness-evaluation'.length); endpoints.push(`${req.method} ${path.split('?')[0]}`);
      const sampleAllowed=process.argv.includes('--run-sample')&&!sampleDispatched;
      if(path==='/runs'&&req.method==='POST')sampleDispatched=true;
      const value=await upstream({path,method:req.method,body:text?JSON.parse(text):null,sampleAllowed,headers:{'x-eval-account':req.headers['x-eval-account']??'','x-eval-csrf':req.headers['x-eval-csrf']??''}});
      res.writeHead(value.status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value.body));return;
    }
    const filename=basename(req.url.split('?')[0]);
    const fontRoot=resolve('.cache/evaluation-ui-browser/node_modules/@fontsource/noto-sans-sc');
    if(filename==='font.css'){res.writeHead(200,{'content-type':'text/css'});res.end((await readFile(resolve(fontRoot,'400.css'),'utf8')).replaceAll('Noto Sans SC','Microsoft YaHei'));return;}
    if(req.url.startsWith('/files/') && /^noto-sans-sc-[a-z0-9-]+\.woff2?$/.test(filename)){res.writeHead(200,{'content-type':'font/woff2'});res.end(await readFile(resolve(fontRoot,'files',filename)));return;}
    if(filename==='app.js'||filename==='app.css'||/^harness-logo-[\w-]+\.png$/.test(filename)) {res.writeHead(200,{'content-type':filename.endsWith('.css')?'text/css':filename.endsWith('.png')?'image/png':'text/javascript'});res.end(await readFile(resolve(out,filename)));return;}
    res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/font.css"><link rel="stylesheet" href="/app.css"><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
  }catch{res.writeHead(503,{'content-type':'application/json'});res.end('{"detail":{"code":"UI_LIVE_BRIDGE_FAILED"}}');}
});
await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
let browser; const checks=[];
function check(name,value){checks.push({name,passed:!!value});if(!value)throw new Error(name);}
try{
  browser=await chromium.launch(); const page=await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/harness/#plugins-evaluation`);
  await page.waitForSelector('.eval-connection[data-ready]',{timeout:40000});
  await page.locator('#evaluation-input').fill('我有多少赛事素材');
  check('one-input-counts-immediately',(await page.locator('#evaluation-draft-count').textContent())==='1 题 · 1 次执行');
  check('start-enabled-without-prepare',await page.getByRole('button',{name:'开始测试',exact:true}).isEnabled());
  await page.locator('#evaluation-input').fill('我有多少赛事素材\n\n列出我当前账号的赛事\n  ');
  check('blank-lines-excluded',(await page.locator('#evaluation-draft-count').textContent())==='2 题 · 2 次执行');
  await page.locator('#evaluation-input').fill('一\n二\n三\n四\n五\n六');
  check('six-visible-not-truncated',(await page.locator('#evaluation-draft-count').textContent()).startsWith('6 题') && await page.getByRole('button',{name:'开始测试',exact:true}).isDisabled());
  await page.locator('#evaluation-input').fill('我有多少赛事素材');
  await page.locator('.eval-settings > summary').click();
  await page.getByLabel('每题重复次数',{exact:true}).selectOption('2');
  check('repeat-count-updates',(await page.locator('#evaluation-draft-count').textContent())==='1 题 · 2 次执行');
  await page.getByLabel('每题重复次数',{exact:true}).selectOption('1');
  await page.locator('.eval-settings > summary').click();
  await page.getByRole('button',{name:'开始测试',exact:true}).click();
  check('confirmation-shows-current-input',(await page.locator('.eval-confirm-cases').textContent()).includes('我有多少赛事素材'));
  await page.getByRole('button',{name:'取消',exact:true}).click();
  check('cancel-does-not-create-experiment',!endpoints.includes('POST /runs'));
  await page.waitForSelector('[aria-label="刷新历史实验"]:not(:disabled)',{timeout:30000});
  await page.evaluate(()=>document.fonts.ready);
  await page.locator('.evaluation-header').click();
  await page.screenshot({path:resolve(out,'desktop.png')});
  for(const width of [390,320]){
    await page.setViewportSize({width,height:844});await page.locator('.evaluation-header').scrollIntoViewIfNeeded();
    check(`no-overflow-${width}`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth && [...document.querySelectorAll('.eval-panel')].every(element=>element.scrollWidth<=element.clientWidth+1)));
    await page.screenshot({path:resolve(out,`mobile-${width}.png`)});
  }
  await page.setViewportSize({width:1440,height:900});
  const history=page.locator('.evaluation-history-item');
  if(await history.count()) {await history.first().click();await page.waitForSelector('.evaluation-trial .markdown',{timeout:30000});await page.screenshot({path:resolve(out,'results.png')});check('actual-history-renders',true);}
  if(process.argv.includes('--run-sample')){
    await page.locator('#evaluation-input').fill('不调用任何工具，也不读取或写入记忆。只回复：实时题数已修复。');
    await page.locator('.eval-settings > summary').click();
    await page.getByLabel('实验名称',{exact:true}).fill('界面验收 · 实时题数');
    await page.getByLabel('单题模型调用上限',{exact:true}).fill('2');
    await page.locator('.eval-settings > summary').click();
    await page.getByRole('button',{name:'开始测试',exact:true}).click();
    await page.getByRole('button',{name:'确认并开始',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.evaluation-trial .markdown')?.textContent.includes('实时题数已修复'),null,{timeout:150000});
    check('real-model-through-new-submit',true);await page.screenshot({path:resolve(out,'new-sample.png')});
  }
  check('no-prepare-request',!endpoints.includes('POST /prepare'));check('no-page-runtime-errors',errors.length===0);
  const report={checks,transport:'live-operator-BFF-bridge; no fabricated API/model responses',browserCookieLogin:'not-tested',modelSample:process.argv.includes('--run-sample'),screenshots:out};
  await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){console.error(JSON.stringify({failed:error.message,checks}));process.exitCode=1;}
finally{await browser?.close();server.closeAllConnections();await new Promise(ok=>server.close(ok));}
