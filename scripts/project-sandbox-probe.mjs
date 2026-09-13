
import fs from 'node:fs/promises';
import net from 'node:net';
import {broker} from '/opt/harness/runtime.mjs';
const deniedPaths=[];
for(const p of ['/var/run/docker.sock','/run/daoyin-project-executor/control.sock','/root/DaoyinHarness','/var/lib/daoyin-projects','/run/daoyin-projects-db']){
 try{await fs.access(p);throw new Error('Host path visible');}catch(e){if(e.code!=='ENOENT'&&e.code!=='EACCES')throw e;deniedPaths.push(p);}
}
let sourceReadonly=false;try{await fs.writeFile('/app/__boundary_probe.txt','denied');}catch(e){sourceReadonly=e.code==='EROFS'||e.code==='EACCES';}
if(!sourceReadonly)throw new Error('Source mutable at runtime');
const egress=[];
for(const host of ['127.0.0.1','169.254.169.254','10.0.0.1']){
 const refused=await new Promise(resolve=>{const s=net.createConnection({host,port:80});s.setTimeout(1200);s.on('connect',()=>{s.destroy();resolve(false)});s.on('error',()=>resolve(true));s.on('timeout',()=>{s.destroy();resolve(true)});});
 if(!refused)throw new Error('Direct network unexpectedly allowed');egress.push(host);
}
const brokerDenied=[];
for(const url of ['https://127.0.0.1/','https://169.254.169.254/','https://10.0.0.1/']){
 try{await broker({action:'http',url});throw new Error('Private egress accepted');}catch(e){if(e.status!==403)throw e;brokerDenied.push(url);}
}
const publicApi=await broker({action:'http',url:'https://www.daoyintech.com/'});
if(publicApi.status!==200)throw new Error('Controlled public HTTPS unavailable');
console.log(JSON.stringify({uid:process.getuid(),deniedPaths,sourceReadonly,directNetworkDenied:egress,brokerDenied,publicHttpsStatus:publicApi.status,secretEnvironmentAbsent:!Object.keys(process.env).some(k=>/TOKEN|SECRET|PASSWORD|DATABASE/.test(k))}));
