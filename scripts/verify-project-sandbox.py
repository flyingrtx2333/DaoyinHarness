import json,pathlib,subprocess
root=pathlib.Path('/root/DaoyinHarness')
name=next(n for n in subprocess.check_output(['docker','ps','--format','{{.Names}}'],text=True).splitlines() if n.startswith('hp-412187209e7d6f7a369ed98e-production-'))
def docker(code):return subprocess.run(['docker','exec','--user','1000:1000',name,'node','--input-type=module','-e',code],text=True,capture_output=True,check=True)
result=docker((root/'scripts/project-sandbox-probe.mjs').read_text());report=json.loads(result.stdout)
quota=docker("""import fs from 'node:fs/promises';let code='';try{await fs.writeFile('/run/app/quota-probe.bin',Buffer.alloc(2*1024*1024));}catch(e){code=e.code;}finally{await fs.unlink('/run/app/quota-probe.bin').catch(()=>{});}if(code!=='ENOSPC')throw new Error('Writable socket storage not bounded');await fs.link('/run/app/app.sock','/run/app/pinned-test.sock');console.log(JSON.stringify({writeLimit:code}));""")
report['writableSocketQuota']=json.loads(quota.stdout)
policy=pathlib.Path('/opt/daoyin-projects/current/socketPolicy.mjs')
node="""
import {pinAppSocket,unixJson} from 'POLICY';
import {execFileSync} from 'node:child_process';
const name='NAME',file='/var/lib/daoyin-projects/instances/'+name+'/pinned-test.sock';
const pin=await pinAppSocket(file);
try{
 execFileSync('/usr/bin/docker',['exec','--user','1000:1000',name,'node','--input-type=module','-e',"import fs from 'node:fs/promises';await fs.unlink('/run/app/pinned-test.sock');await fs.symlink('/run/daoyin-project-executor/control.sock','/run/app/pinned-test.sock');"]);
 const result=await unixJson(pin.path,'/health',{},undefined,3000);if(result.ok!==true)throw new Error('Pinned connection switched targets');
 let rejected=false;try{const bad=await pinAppSocket(file);await bad.close();}catch{rejected=true;}if(!rejected)throw new Error('Symlink accepted');
 console.log(JSON.stringify({pathReplacementRace:'original-socket-only',symlinkRejected:true}));
}finally{await pin.close();execFileSync('/usr/bin/docker',['exec','--user','1000:1000',name,'node','--input-type=module','-e',"import fs from 'node:fs/promises';await fs.unlink('/run/app/pinned-test.sock');"]);}
""".replace('POLICY',str(policy)).replace('NAME',name)
r=subprocess.run(['/opt/daoyin-harness/node/bin/node','--input-type=module','-e',node],text=True,capture_output=True,check=True)
report['socketBoundary']=json.loads(r.stdout)
h=json.loads(subprocess.check_output(['docker','inspect',name],text=True))[0]['HostConfig'];report['limits']={k:h[k] for k in ['Runtime','Memory','MemorySwap','NanoCpus','PidsLimit','ReadonlyRootfs','NetworkMode']}
out=pathlib.Path('/opt/daoyin-projects/acceptance/sandbox-boundaries.json');out.write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2))
