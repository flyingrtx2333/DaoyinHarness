import {spawn} from "node:child_process";
const run=args=>new Promise((resolve,reject)=>{
 const p=spawn("node",args,{cwd:"/app",stdio:"inherit",env:{PATH:"/usr/local/bin:/usr/bin:/bin",HOME:"/tmp",NODE_ENV:"production"}});
 p.on("error",reject);p.on("exit",c=>c===0?resolve():reject(new Error("Build check failed")));
});
await run(["/opt/node_modules/typescript/bin/tsc","--noEmit"]);
await run(["/opt/node_modules/vite/bin/vite.js","build","--outDir","/output","--emptyOutDir"]);
