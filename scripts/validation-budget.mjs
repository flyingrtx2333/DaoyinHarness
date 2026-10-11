// Real cloud validation uses a trusted server-side admission ledger. No credentials enter this module.
import { spawn } from 'node:child_process';
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/u.test(value);
const auditError = code => Object.assign(new Error(`Validation budget audit failed (${code}); no further runs admitted.`), { code });
function auditFailureCode(exitCode, diagnostic) {
  if (exitCode === 255) return 'VALIDATION_AUDIT_SSH_TRANSPORT';
  // Match only our fixed diagnostic messages; remote stderr is never exposed.
  for (const [message, code] of [
    ['Read-only platform audit failed', 'VALIDATION_AUDIT_PLATFORM_READ'],
    ['Frozen model configuration changed', 'VALIDATION_AUDIT_MODEL_DRIFT'],
    ['Frozen scene configuration or pricing changed', 'VALIDATION_AUDIT_CONFIGURATION_DRIFT'],
    ['Validation policy expired', 'VALIDATION_AUDIT_POLICY_EXPIRED'],
    ['Admission ledger lock unavailable', 'VALIDATION_AUDIT_LEDGER_LOCK'],
    ['Actual usage differs from frozen model', 'VALIDATION_AUDIT_USAGE_MODEL_DRIFT'],
    ['Actual usage exceeds reservation', 'VALIDATION_AUDIT_RESERVATION_EXCEEDED'],
  ]) if (diagnostic.includes(message)) return code;
  return 'VALIDATION_AUDIT_REMOTE_FAILURE';
}
export function validationBudget(directory) {
  if (!/^\/var\/lib\/daoyin-harness\/validation\/[a-zA-Z0-9_-]+$/u.test(directory ?? '')) throw new Error('An explicit trusted validation budget directory is required.');
  const controlPath = `/tmp/daoyin-validation-ssh-${directory.split('/').at(-1)}`;
  async function remote(operation, input = {}) {
    const configurationProgram = [
      'import json,hashlib',
      'from database import get_db',
      'from services.saishi_agent_bridge import AGENT_MODEL_MAX_TOKENS',
      'with get_db() as c,c.cursor() as q:',
      ` q.execute("SELECT id,scene_key,provider_key,model_name,config_json,is_enabled FROM ai_app_bindings WHERE app_key=%s AND scene_key IN (%s,%s) ORDER BY scene_key",('daoyin-harness','agent_turn','capability_routing'))`,
      ' bindings=q.fetchall()',
      ` assert len(bindings)==2 and all(r['is_enabled'] for r in bindings), 'Frozen scene bindings unavailable'`,
      ` scenes={r['scene_key']:{'id':r['id'],'provider':r['provider_key'],'model':r['model_name'],'config':json.loads(r['config_json']) if isinstance(r['config_json'],str) else r['config_json']} for r in bindings}`,
      ` primary=scenes['agent_turn']; assert all(s['provider']==primary['provider'] and s['model']==primary['model'] for s in scenes.values()), 'Routing model differs from frozen agent model'`,
      ` q.execute("SELECT provider_key,model_name,currency,pricing_json,source_url,effective_from,is_enabled FROM ai_model_pricing_rules WHERE provider_key=%s AND model_name=%s",(primary['provider'],primary['model']))`,
      ' prices=q.fetchall()',
      ` assert len(prices)==1 and prices[0]['is_enabled'] and prices[0]['currency']=='CNY', 'Actual pricing unavailable'`,
      ` pricing=prices[0]; pricing['pricing_json']=json.loads(pricing['pricing_json']) if isinstance(pricing['pricing_json'],str) else pricing['pricing_json']; date=pricing['effective_from']; pricing['effective_from']=date.isoformat() if hasattr(date,'isoformat') else str(date) if date is not None else None`,
      ` canonical=lambda v:json.dumps(v,sort_keys=True,separators=(',',':')).encode()`,
      ` facts={'scenes':scenes,'maxOutputTokens':AGENT_MODEL_MAX_TOKENS}`,
      ` print(json.dumps({'provider':primary['provider'],'model':primary['model'],**facts,'modelConfigurationSha256':hashlib.sha256(canonical(facts)).hexdigest(),'pricing':pricing,'pricingSha256':hashlib.sha256(canonical(pricing)).hexdigest()}))`,
    ].join('\n');
    const usageProgram = operation === 'settle' ? [
      'import json',
      'from database import get_db',
      `run=${JSON.stringify(input.runId)}`,
      'with get_db() as c,c.cursor() as q:',
      ` q.execute(${JSON.stringify("SELECT id,provider_key,model_name,cost_status,cost_currency,cost_amount,tokens_request,tokens_response,JSON_UNQUOTE(JSON_EXTRACT(usage_json,'$.operationId')) AS operation_id FROM ai_usage_logs WHERE JSON_VALID(usage_json) AND JSON_UNQUOTE(JSON_EXTRACT(usage_json,'$.runId'))=%s ORDER BY id")},(run,))`,
      ' print(json.dumps(q.fetchall(),default=str))',
    ].join('\n') : '';
    const parameters = Buffer.from(JSON.stringify({ directory, operation, ...input, usageProgram, configurationProgram })).toString('base64');
    const program = String.raw`import json,pathlib,subprocess,time,os,decimal,hashlib,base64
p=json.loads(base64.b64decode('${parameters}'))
root=pathlib.Path(p['directory']); policy_path=root/'policy.json'; ledger_path=root/'ledger.json'
policy=json.loads(policy_path.read_text())
def sql(code):
 r=subprocess.run(['docker','exec','daoyintech-backend','python','-c',code],capture_output=True,text=True,timeout=20)
 if r.returncode: raise RuntimeError('Read-only platform audit failed')
 return json.loads(r.stdout)
configuration=sql(p['configurationProgram'])
if any(configuration[k]!=policy[k] for k in ('provider','model','maxOutputTokens')): raise RuntimeError('Frozen model configuration changed; no new request admitted')
if any(configuration[k]!=policy.get(k) for k in ('modelConfigurationSha256','pricingSha256')): raise RuntimeError('Frozen scene configuration or pricing changed; no new request admitted')
if policy['expiresAt']<=int(time.time()*1000): raise RuntimeError('Validation policy expired')
rows=sql(p['usageProgram']) if p['operation']=='settle' else []
lock=pathlib.Path(str(ledger_path)+'.lock'); until=time.monotonic()+5
while True:
 try: lock.mkdir(mode=0o700); break
 except FileExistsError:
  if time.monotonic()>until: raise RuntimeError('Admission ledger lock unavailable')
  time.sleep(.05)
try:
 ledger=json.loads(ledger_path.read_text())
 if p['operation']=='register':
  sid=p['sessionId']
  if sid not in policy['sessionIds']: policy['sessionIds'].append(sid)
  owner=policy_path.stat(); tmp=policy_path.with_suffix('.next'); tmp.write_text(json.dumps(policy)+'\n'); tmp.chmod(owner.st_mode&0o777); os.chown(tmp,owner.st_uid,owner.st_gid); os.replace(tmp,policy_path)
 elif p['operation']=='settle':
  run=p['runId']
  for reservation in ledger['reservations']:
   if reservation['runId']!=run: continue
   matches=[r for r in rows if r['operation_id']==reservation['operationId']]
   if len(matches)!=1: continue
   row=matches[0]
   if row['provider_key']!=policy['provider'] or row['model_name']!=policy['model']: raise RuntimeError('Actual usage differs from frozen model')
   if row['cost_status']!='CALCULATED' or row['cost_currency']!='CNY' or row['cost_amount'] is None: continue
   cost=int((decimal.Decimal(str(row['cost_amount']))*1000000).to_integral_value(rounding=decimal.ROUND_CEILING))
   if cost>reservation['reservedMicroCny']: raise RuntimeError('Actual usage exceeds reservation; stop new requests')
   reservation['settledMicroCny']=cost
   reservation['usageId']=row['id']
  owner=ledger_path.stat(); tmp=ledger_path.with_suffix('.next'); tmp.write_text(json.dumps(ledger)+'\n'); tmp.chmod(owner.st_mode&0o777); os.chown(tmp,owner.st_uid,owner.st_gid); os.replace(tmp,ledger_path)
 else:
  rows=[]
 total=sum(r.get('settledMicroCny',r['reservedMicroCny']) for r in ledger['reservations'])
 print(json.dumps({'configuration':configuration,'requestsReserved':len(ledger['reservations']),'requestsReservedForRun':sum(r['runId']==p.get('runId') for r in ledger['reservations']),'committedMicroCny':total,'settledMicroCny':sum(r.get('settledMicroCny',0) for r in ledger['reservations']),'unsettledReservations':sum('settledMicroCny' not in r for r in ledger['reservations']),'maxRequests':policy['maxRequests'],'maxMicroCny':policy['maxMicroCny'],'usage':rows if p['operation']=='settle' else [],'ledgerSha256':hashlib.sha256(ledger_path.read_bytes()).hexdigest()}))
finally: lock.rmdir()
`;
    return await new Promise((resolve, reject) => {
      const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ControlMaster=auto', '-o', 'ControlPersist=600', '-o', `ControlPath=${controlPath}`, 'root@42.194.159.81', 'python3', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks = []; let size = 0; let diagnostic = '';
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(auditError('VALIDATION_AUDIT_TIMEOUT')); }, 55000);
      child.stdout.on('data', chunk => { size += chunk.length; if (size > 2_000_000) child.kill('SIGTERM'); else chunks.push(chunk); });
      child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString('utf8')).slice(-4096); });
      child.on('error', () => { clearTimeout(timer); reject(auditError('VALIDATION_AUDIT_SSH_START')); });
      child.on('close', code => {
        clearTimeout(timer);
        if (size > 2_000_000) { reject(auditError('VALIDATION_AUDIT_OUTPUT_LIMIT')); return; }
        if (code !== 0) { reject(auditError(auditFailureCode(code, diagnostic))); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(auditError('VALIDATION_AUDIT_RECEIPT_INVALID')); }
      });
      child.stdin.end(program);
    });
  }
  return {
    directory,
    inspect: () => remote('inspect'),
    registerSession: sessionId => { if (!identifier(sessionId)) throw new Error('Invalid validation session.'); return remote('register', { sessionId }); },
    settleRun: runId => { if (!identifier(runId)) throw new Error('Invalid validation run.'); return remote('settle', { runId }); },
  };
}
