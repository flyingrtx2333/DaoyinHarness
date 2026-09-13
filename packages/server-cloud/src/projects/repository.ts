import { randomBytes, createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { ProjectError, ownerKey, checkedFiles, slugValue, type ProjectOwner, type Project, type ProjectFile, type ProjectVersion, type ProjectOperation } from "./contracts.js";
import { projectTemplate } from "./template.js";
export const newId = (prefix: string): string => prefix + "_" + randomBytes(12).toString("hex");
export const digest = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const projectColumns = 'id,title,slug,revision,active_version AS "activeVersion",created_at AS "createdAt",updated_at AS "updatedAt"';
const operationColumns = 'id,project_id AS "projectId",kind,status,result,error,created_at AS "createdAt"';
export class ProjectRepository {
  constructor(readonly pool: Pool) {}
  async locked<T>(key: string, fn: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try { await db.query("BEGIN"); await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
      const value = await fn(db); await db.query("COMMIT"); return value;
    } catch (e) { await db.query("ROLLBACK"); throw e; } finally { db.release(); }
  }
  async list(owner: ProjectOwner): Promise<Project[]> {
    return (await this.pool.query<Project>('SELECT '+projectColumns+' FROM harness_projects WHERE owner_key=$1 ORDER BY updated_at DESC',[ownerKey(owner)])).rows;
  }
  async get(owner: ProjectOwner, id: string, db: Pool | PoolClient = this.pool): Promise<Project> {
    const result = await db.query<Project>('SELECT '+projectColumns+' FROM harness_projects WHERE id=$1 AND owner_key=$2',[id,ownerKey(owner)]);
    if (!result.rows[0]) throw new ProjectError("PROJECT_NOT_FOUND","项目不存在或当前账号无权访问。",404);
    return result.rows[0];
  }
  async create(owner: ProjectOwner, title: string, requestId: string): Promise<Project> {
    if (!title.trim() || title.length > 80 || !/^[A-Za-z0-9_-]{8,160}$/u.test(requestId)) throw new ProjectError("PROJECT_CREATE_INVALID","项目名称或请求标识无效。");
    const id="prj_"+digest([ownerKey(owner),requestId]).slice(0,24);
    return this.locked("owner:"+ownerKey(owner),async db=>{
      const prior=await db.query("SELECT title FROM harness_projects WHERE id=$1",[id]);
      if(prior.rows[0]) {
        if(prior.rows[0].title!==title.trim()) throw new ProjectError("PROJECT_REQUEST_CONFLICT","同一请求不能创建不同项目。",409);
        return this.get(owner,id,db);
      }
      const count=await db.query<{count:string}>("SELECT count(*) FROM harness_projects WHERE owner_key=$1",[ownerKey(owner)]);
      if(Number(count.rows[0]?.count)>=5) throw new ProjectError("PROJECT_QUOTA","试运行期间每个账号最多创建 5 个项目。",429);
      await db.query("INSERT INTO harness_projects(id,owner_key,title,slug) VALUES($1,$2,$3,$4)",[id,ownerKey(owner),title.trim(),"h-"+id.slice(4,16)]);
      for(const f of projectTemplate(title.trim())) await db.query("INSERT INTO harness_project_files VALUES($1,$2,$3)",[id,f.path,f.content]);
      return this.get(owner,id,db);
    });
  }
  async bind(owner: ProjectOwner,id:string,sessionId:string):Promise<void>{
    await this.get(owner,id);
    await this.pool.query("INSERT INTO harness_project_sessions VALUES($1,$2,$3) ON CONFLICT(owner_key,session_id) DO UPDATE SET project_id=excluded.project_id",[ownerKey(owner),sessionId,id]);
  }
  async bound(owner:ProjectOwner,sessionId:string):Promise<Project|null>{
    const row=(await this.pool.query<{project_id:string}>("SELECT project_id FROM harness_project_sessions WHERE owner_key=$1 AND session_id=$2",[ownerKey(owner),sessionId])).rows[0];
    return row?this.get(owner,row.project_id):null;
  }
  async files(owner:ProjectOwner,id:string):Promise<ProjectFile[]>{
    await this.get(owner,id);
    return (await this.pool.query<ProjectFile>("SELECT path,content FROM harness_project_files WHERE project_id=$1 ORDER BY path",[id])).rows;
  }
  async write(owner:ProjectOwner,id:string,revision:number,input:unknown):Promise<Project>{
    const files=checkedFiles(input);
    return this.locked(id,async db=>{
      const p=await this.get(owner,id,db);
      if(p.revision!==revision) throw new ProjectError("PROJECT_REVISION_CONFLICT","项目已被另一个对话修改，请重新读取文件后继续。",409);
      const active=await db.query("SELECT id FROM harness_project_operations WHERE project_id=$1 AND status IN ('queued','running') LIMIT 1",[id]);
      if(active.rowCount) throw new ProjectError("PROJECT_BUSY","项目正在检查或发布，请等待当前操作完成。",409);
      for(const f of files) await db.query("INSERT INTO harness_project_files VALUES($1,$2,$3) ON CONFLICT(project_id,path) DO UPDATE SET content=excluded.content",[id,f.path,f.content]);
      const size=await db.query<{bytes:string;count:string}>("SELECT sum(octet_length(content)) AS bytes,count(*) FROM harness_project_files WHERE project_id=$1",[id]);
      if(Number(size.rows[0]?.bytes)>5242880 || Number(size.rows[0]?.count)>200) throw new ProjectError("PROJECT_STORAGE_QUOTA","项目超过 5 MB 源码或 200 个文件限额。",413);
      await db.query("UPDATE harness_projects SET revision=revision+1,updated_at=now() WHERE id=$1",[id]);
      return this.get(owner,id,db);
    });
  }
  async rename(owner:ProjectOwner,id:string,slug:unknown):Promise<Project>{
    const value=slugValue(slug);
    return this.locked(id,async db=>{
      const p=await this.get(owner,id,db);
      if(p.activeVersion) throw new ProjectError("PROJECT_DOMAIN_LOCKED","已发布项目的网址保持固定；请在首次发布前修改。",409);
      const operation=await db.query("SELECT id FROM harness_project_operations WHERE project_id=$1 AND status IN ('queued','running') LIMIT 1",[id]);
      if(operation.rowCount)throw new ProjectError("PROJECT_BUSY","请等待当前操作完成后修改网址。",409);
      const exists=await db.query("SELECT id FROM harness_projects WHERE slug=$1 AND id<>$2",[value,id]);
      if(exists.rowCount)throw new ProjectError("PROJECT_DOMAIN_TAKEN","网址名称已被占用。",409);
      await db.query("UPDATE harness_projects SET slug=$1 WHERE id=$2",[value,id]);return this.get(owner,id,db);
    });
  }
  async snapshot(owner:ProjectOwner,id:string,db:PoolClient):Promise<ProjectVersion>{
    const p=await this.get(owner,id,db);
    const files=(await db.query<ProjectFile>("SELECT path,content FROM harness_project_files WHERE project_id=$1 ORDER BY path",[id])).rows;
    const hash=digest(files); const versionId=newId("ver");
    const versions=await db.query<{count:string}>("SELECT count(*) FROM harness_project_versions WHERE project_id=$1",[id]);
    const exists=(await db.query<ProjectVersion>('SELECT id,project_id AS "projectId",revision,digest,created_at AS "createdAt" FROM harness_project_versions WHERE project_id=$1 AND digest=$2',[id,hash])).rows[0];
    if(exists)return exists;
    if(Number(versions.rows[0]?.count)>=100)throw new ProjectError("PROJECT_VERSION_QUOTA","项目已达到 100 个不可变版本限额。",429);
    const row=await db.query<ProjectVersion>('INSERT INTO harness_project_versions(id,project_id,revision,digest,files) VALUES($1,$2,$3,$4,$5) RETURNING id,project_id AS "projectId",revision,digest,created_at AS "createdAt"',[versionId,id,p.revision,hash,JSON.stringify(files)]);
    return row.rows[0]!;
  }
  async enqueue(owner:ProjectOwner,id:string,kind:string,requestId:string,versionId?:string,authorization?:unknown,sourceRun?:string):Promise<ProjectOperation>{
    if(!["check","preview","publish","rollback"].includes(kind)||!/^[A-Za-z0-9_-]{8,160}$/u.test(requestId))throw new ProjectError("PROJECT_OPERATION_INVALID","操作或请求标识无效。");
    return this.locked(id,async db=>{
      await this.get(owner,id,db);
      const inputHash=digest([kind,versionId??null]);
      const prior=(await db.query<ProjectOperation & {input_hash:string}>('SELECT '+operationColumns+',input_hash FROM harness_project_operations WHERE project_id=$1 AND request_id=$2',[id,requestId])).rows[0];
      if(prior){if(prior.input_hash!==inputHash)throw new ProjectError("PROJECT_REQUEST_CONFLICT","同一请求标识不能用于不同操作。",409);return prior;}
      if(kind==="rollback"&&!versionId)throw new ProjectError("PROJECT_VERSION_REQUIRED","请选择已发布过的版本。");
      if(versionId) {
        const exists=await db.query("SELECT id FROM harness_project_deployments WHERE project_id=$1 AND version_id=$2 LIMIT 1",[id,versionId]);
        if(!exists.rowCount)throw new ProjectError("PROJECT_VERSION_NOT_PUBLISHED","只能回滚到本项目成功发布的版本。",404);
      }
      const active=await db.query("SELECT id FROM harness_project_operations WHERE project_id=$1 AND status IN ('queued','running') LIMIT 1",[id]);
      if(active.rowCount)throw new ProjectError("PROJECT_BUSY","本项目已有操作等待完成。",409);
      const daily=await db.query<{count:string}>("SELECT count(*) FROM harness_project_operations WHERE project_id=$1 AND created_at>now()-interval '24 hours'",[id]);
      if(Number(daily.rows[0]?.count)>=100)throw new ProjectError("PROJECT_OPERATION_QUOTA","项目已达到每日 100 次执行限额。",429);
      const version=versionId??(await this.snapshot(owner,id,db)).id;
      const opId=newId("op");
      const row=await db.query<ProjectOperation>('INSERT INTO harness_project_operations(id,project_id,request_id,kind,input_hash,result,execution_identity,source_run) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING '+operationColumns,[opId,id,requestId,kind,inputHash,JSON.stringify({versionId:version}),JSON.stringify(authorization??null),sourceRun??null]);
      return row.rows[0]!;
    });
  }
  async operations(owner:ProjectOwner,id:string):Promise<ProjectOperation[]>{
    await this.get(owner,id);return (await this.pool.query<ProjectOperation>('SELECT '+operationColumns+' FROM harness_project_operations WHERE project_id=$1 ORDER BY created_at DESC LIMIT 30',[id])).rows;
  }
  async versions(owner:ProjectOwner,id:string):Promise<ProjectVersion[]>{
    await this.get(owner,id);return (await this.pool.query<ProjectVersion>('SELECT v.id,v.project_id AS "projectId",v.revision,v.digest,v.created_at AS "createdAt",EXISTS(SELECT 1 FROM harness_project_deployments d WHERE d.version_id=v.id) AS published FROM harness_project_versions v WHERE project_id=$1 ORDER BY created_at DESC LIMIT 30',[id])).rows;
  }
  async cancel(owner:ProjectOwner,id:string,operationId:string):Promise<void>{
    await this.get(owner,id);
    await this.pool.query("UPDATE harness_project_operations SET status='cancelled',error='用户已停止操作；原发布版本保留。',updated_at=now() WHERE project_id=$1 AND id=$2 AND status IN ('queued','running')",[id,operationId]);
  }
  async ticket(owner:ProjectOwner,id:string):Promise<string>{
    await this.get(owner,id); const token=randomBytes(32).toString("base64url");
    await this.pool.query("INSERT INTO harness_project_preview_tickets VALUES($1,$2,$3,now()+interval '60 seconds',NULL)",[digest(token),id,ownerKey(owner)]);
    return token;
  }
}
