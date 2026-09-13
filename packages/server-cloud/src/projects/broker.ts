import http from "node:http";
import https from "node:https";
import dns from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { randomBytes, createHmac, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { mkdir, chmod, unlink } from "node:fs/promises";
import { Pool, type PoolConfig } from "pg";
import { identifier, ProjectError } from "./contracts.js";
import { digest, newId } from "./repository.js";
const scrypt=promisify(scryptCallback);
const blocked=new BlockList();
for(const [network,prefix] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]] as const)blocked.addSubnet(network,prefix,"ipv4");
export async function publicRequest(raw:string,method="GET",body?:string):Promise<{status:number;body:string;contentType:string}>{
  const url=new URL(raw);
  if(url.protocol!=="https:"||url.username||url.password||url.port&&url.port!=="443"||url.hostname==="localhost"||url.hostname.endsWith(".local"))
    throw new ProjectError("PROJECT_EGRESS_DENIED","仅允许公开 HTTPS 接口。",403);
  if(!["GET","POST"].includes(method)||Buffer.byteLength(body??"")>65536)throw new ProjectError("PROJECT_EGRESS_INVALID","外部接口请求超出限制。");
  const addresses=await dns.lookup(url.hostname,{all:true,family:4});
  if(!addresses.length||addresses.some(a=>isIP(a.address)!==4||blocked.check(a.address,"ipv4")))throw new ProjectError("PROJECT_EGRESS_DENIED","禁止访问内网或云元数据地址。",403);
  const address=addresses[0]!.address;
  return new Promise((resolve,reject)=>{
    const req=https.request(url,{method,family:4,headers:{"Content-Type":"application/json","User-Agent":"DaoyinHarnessProject/1"},
      lookup:(_host,_options,callback)=>callback(null,address,4)},res=>{
      let value="";res.on("data",(b:Buffer)=>{value+=b.toString();if(Buffer.byteLength(value)>1048576)res.destroy(new Error("Response limit"));});
      res.on("error",reject);res.on("end",()=>resolve({status:res.statusCode??502,body:value,contentType:String(res.headers["content-type"]??"text/plain")}));
    });req.setTimeout(15000,()=>req.destroy(new Error("External request timeout")));req.on("error",reject);req.end(body);
  });
}
const appSchema=String.raw`
CREATE TABLE IF NOT EXISTS app_users(id text PRIMARY KEY,email text UNIQUE NOT NULL,salt text NOT NULL,password_hash text NOT NULL,created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS app_sessions(token_hash text PRIMARY KEY,user_id text REFERENCES app_users(id),expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS app_documents(id text PRIMARY KEY,collection text NOT NULL,user_id text REFERENCES app_users(id),data jsonb NOT NULL,created_at timestamptz DEFAULT now());
CREATE INDEX IF NOT EXISTS app_documents_owner ON app_documents(user_id,collection);
CREATE TABLE IF NOT EXISTS app_uploads(id text PRIMARY KEY,user_id text REFERENCES app_users(id),name text NOT NULL,body bytea NOT NULL,created_at timestamptz DEFAULT now());
`;
const name=(v:unknown):string=>{
  if(typeof v!=="string"||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(v))throw new ProjectError("APP_COLLECTION_INVALID","集合名称无效。");
  return v;
};
interface BrokerInput { action:string; token?:string; email?:string; password?:string; collection?:string; id?:string; data?:unknown; name?:string; url?:string; method?:string; body?:string }
export class ProjectBrokers {
  readonly servers=new Map<string,http.Server>();
  readonly pools=new Map<string,Pool>();
  inflight=0;
  readonly reading=new Map<string,number>();
  readonly pending=new Map<string,Promise<unknown>>();
  readonly depths=new Map<string,number>();
  readonly rates=new Map<string,{count:number;expires:number}>();
  constructor(readonly admin:Pool,readonly config:PoolConfig,readonly secret:string){}
  async ensure(projectId:string,mode:"development"|"production"):Promise<void>{
    identifier(projectId,"prj");const key=projectId+"_"+mode;
    if(this.servers.has(key))return;
    const dbName="hp_"+projectId.slice(4)+"_"+(mode==="production"?"p":"d");
    const password=createHmac("sha256",this.secret).update(dbName).digest("hex");
    const existing=await this.admin.query("SELECT datname FROM pg_database WHERE datname=$1",[dbName]);
    if(!existing.rowCount){
      const role=await this.admin.query("SELECT rolname FROM pg_roles WHERE rolname=$1",[dbName]);
      if(!role.rowCount)await this.admin.query('CREATE ROLE "'+dbName+'" LOGIN PASSWORD \''+password+"' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 4");
      await this.admin.query('CREATE DATABASE "'+dbName+'" OWNER "'+dbName+'"');
      await this.admin.query('REVOKE ALL ON DATABASE "'+dbName+'" FROM PUBLIC');
      const setup=new Pool({...this.config,database:dbName,max:1});
      try{await setup.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");}finally{await setup.end();}
    }
    const pool=new Pool({...this.config,user:dbName,password,database:dbName,max:2,statement_timeout:5000,idleTimeoutMillis:30000});
    await pool.query(appSchema);this.pools.set(key,pool);
    const dir="/run/daoyin-projects/brokers/"+projectId+"/"+mode;
    await mkdir(dir,{recursive:true,mode:0o700});await chmod(dir,0o711);
    const socket=dir+"/broker.sock";await unlink(socket).catch(()=>undefined);
    const server=http.createServer((req,res)=>{
      if(req.url!=="/broker"||req.method!=="POST"){res.writeHead(404).end();return;}
      if(this.inflight>=8||(this.reading.get(key)??0)>=2){res.writeHead(429,{"Connection":"close","Content-Type":"application/json"}).end(JSON.stringify({error:"请求较多，请稍后重试。"}));req.resume();return;}
      this.inflight++;this.reading.set(key,(this.reading.get(key)??0)+1);
      let released=false;
      const release=():void=>{if(released)return;released=true;this.inflight--;this.reading.set(key,(this.reading.get(key)??1)-1);};
      res.once("close",release);req.once("aborted",release);req.setTimeout(20000,()=>req.destroy());

      let body="";req.on("data",(b:Buffer)=>{body+=b.toString();if(Buffer.byteLength(body)>7500000)req.destroy();});
      req.on("end",()=>{void(async()=>{
        try{
          const input=JSON.parse(body) as BrokerInput;
          const result=await this.serial(pool,key,input);
          res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify(result));
        }catch(e){
          const err=e instanceof ProjectError?e:new ProjectError("APP_REQUEST_FAILED","请求未完成，请稍后重试。",503);
          res.writeHead(err.status,{"Content-Type":"application/json"}).end(JSON.stringify({error:err.message}));
        }
      })();});
    });
    await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(socket,()=>resolve());});
    await chmod(socket,0o666);this.servers.set(key,server);
  }
  async serial(db:Pool,key:string,input:BrokerInput):Promise<unknown>{
    const count=this.depths.get(key)??0;
    if(count>=32)throw new ProjectError("APP_BUSY","请求较多，请稍后重试。",429);
    this.depths.set(key,count+1);
    const previous=this.pending.get(key)??Promise.resolve();
    const next=previous.catch(()=>undefined).then(()=>this.dispatch(db,key,input));this.pending.set(key,next);
    try{return await next;}finally{this.depths.set(key,(this.depths.get(key)??1)-1);if(this.pending.get(key)===next)this.pending.delete(key);}
  }
  limit(key:string,max:number):void{
    const now=Date.now();let entry=this.rates.get(key);
    if(!entry||entry.expires<now){entry={count:0,expires:now+60000};this.rates.set(key,entry);}
    if(++entry.count>max)throw new ProjectError("APP_RATE_LIMIT","请求过于频繁，请稍后重试。",429);
    if(this.rates.size>10000)for(const[k,v]of this.rates)if(v.expires<now)this.rates.delete(k);
  }
  async dispatch(db:Pool,key:string,input:BrokerInput):Promise<unknown>{
    this.limit(key,300);
    if(input.action==="http"){this.limit(key+":http",30);return publicRequest(String(input.url),input.method,input.body);}
    if(["register","login"].includes(input.action)){
      this.limit(key+":auth",20);
      const email=String(input.email??"").trim().toLowerCase(),password=String(input.password??"");
      if(!/^[^@\s]{1,80}@[^@\s]{1,120}\.[^@\s]{1,30}$/u.test(email)||password.length<10||password.length>128)throw new ProjectError("APP_LOGIN_INVALID","请填写有效邮箱及 10 至 128 位密码。");
      const found=(await db.query<{id:string;salt:string;password_hash:string}>("SELECT id,salt,password_hash FROM app_users WHERE email=$1",[email])).rows[0];
      let id=found?.id;
      if(input.action==="register"){
        if(found)throw new ProjectError("APP_REGISTER_FAILED","无法注册该邮箱，请尝试登录。",409);
        const count=await db.query<{count:string}>("SELECT count(*) FROM app_users");
        if(Number(count.rows[0]?.count)>=1000)throw new ProjectError("APP_USER_QUOTA","网站试运行用户额度已满。",429);
        id=newId("usr");const salt=randomBytes(16).toString("hex");const hash=await scrypt(password,salt,32) as Buffer;
        await db.query("INSERT INTO app_users(id,email,salt,password_hash) VALUES($1,$2,$3,$4)",[id,email,salt,hash.toString("hex")]);
      }else{
        const hash=await scrypt(password,found?.salt??"fixed-timing-salt",32) as Buffer;
        if(!found||!timingSafeEqual(hash,Buffer.from(found.password_hash,"hex")))throw new ProjectError("APP_LOGIN_FAILED","邮箱或密码不正确。",401);
      }
      const token=randomBytes(32).toString("base64url");
      await db.query("INSERT INTO app_sessions VALUES($1,$2,now()+interval '7 days')",[digest(token),id]);
      return{user:{id,email},token};
    }
    const session=(await db.query<{id:string;email:string}>("SELECT u.id,u.email FROM app_sessions s JOIN app_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()",[digest(input.token??"")])).rows[0];
    if(!session)throw new ProjectError("APP_LOGIN_REQUIRED","请先登录此网站。",401);
    if(input.action==="me")return{user:session};
    if(input.action==="logout"){await db.query("DELETE FROM app_sessions WHERE token_hash=$1",[digest(input.token??"")]);return{ok:true};}
    if(input.action==="list")return{items:(await db.query("SELECT id,data,created_at FROM app_documents WHERE collection=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 100",[name(input.collection),session.id])).rows};
    if(["create","update"].includes(input.action)){
      if(!input.data||typeof input.data!=="object"||Array.isArray(input.data)||JSON.stringify(input.data).length>16000)throw new ProjectError("APP_DATA_INVALID","记录必须是小于 16 KB 的对象。");
      const count=await db.query<{count:string}>("SELECT count(*) FROM app_documents");
      if(Number(count.rows[0]?.count)>=10000)throw new ProjectError("APP_DATA_QUOTA","网站记录额度已满。",429);
      if(input.action==="create"){const id=newId("doc");await db.query("INSERT INTO app_documents(id,collection,user_id,data) VALUES($1,$2,$3,$4)",[id,name(input.collection),session.id,JSON.stringify(input.data)]);return{id,data:input.data};}
      const result=await db.query("UPDATE app_documents SET data=$1 WHERE id=$2 AND collection=$3 AND user_id=$4 RETURNING id,data",[JSON.stringify(input.data),input.id,name(input.collection),session.id]);
      if(!result.rowCount)throw new ProjectError("APP_DATA_NOT_FOUND","记录不存在。",404);return result.rows[0];
    }
    if(input.action==="get"||input.action==="delete"){
      const result=await db.query(input.action==="get"?"SELECT id,data FROM app_documents WHERE id=$1 AND collection=$2 AND user_id=$3":"DELETE FROM app_documents WHERE id=$1 AND collection=$2 AND user_id=$3 RETURNING id",[input.id,name(input.collection),session.id]);
      if(!result.rowCount)throw new ProjectError("APP_DATA_NOT_FOUND","记录不存在。",404);return result.rows[0];
    }
    if(input.action==="upload"){
      if(typeof input.data!=="string"||!/^[A-Za-z0-9+/]*={0,2}$/u.test(input.data)||input.data.length%4!==0||typeof input.name!=="string"||input.name.length>180)throw new ProjectError("APP_UPLOAD_INVALID","文件格式无效。");
      const bytes=Buffer.from(input.data,"base64");if(bytes.length>5242880)throw new ProjectError("APP_UPLOAD_LIMIT","单个文件最多 5 MB。",413);
      const total=await db.query<{size:string}>("SELECT coalesce(sum(octet_length(body)),0) AS size FROM app_uploads");
      if(Number(total.rows[0]?.size)+bytes.length>104857600)throw new ProjectError("APP_UPLOAD_QUOTA","网站文件存储已达到 100 MB。",429);
      const id=newId("upl");await db.query("INSERT INTO app_uploads(id,user_id,name,body) VALUES($1,$2,$3,$4)",[id,session.id,input.name.replace(/[\r\n/\\]/gu,"_"),bytes]);
      return{id,name:input.name,url:"/api/uploads/"+id};
    }
    if(input.action==="download"){
      const result=(await db.query<{name:string;body:Buffer}>("SELECT name,body FROM app_uploads WHERE id=$1 AND user_id=$2",[input.id,session.id])).rows[0];
      if(!result)throw new ProjectError("APP_UPLOAD_NOT_FOUND","文件不存在。",404);return{name:result.name,data:result.body.toString("base64")};
    }
    throw new ProjectError("APP_ACTION_DENIED","不支持此操作。",403);
  }
}
