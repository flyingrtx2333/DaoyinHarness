import { randomBytes, createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { ProjectError, ownerKey, checkedFiles, slugValue, conceptDirection, type ConceptDirection, type ProjectOwner,
  type Project, type ProjectFile, type ProjectVersion, type ProjectOperation, type ProjectConceptSet } from "./contracts.js";
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
      const concept=await db.query("SELECT id FROM harness_project_concept_sets WHERE project_id=$1 AND status IN ('generating','awaiting_selection') ORDER BY created_at DESC LIMIT 1",[id]);
      if(concept.rowCount)throw new ProjectError("PROJECT_CONCEPT_SELECTION_REQUIRED","请先查看并选择 A、B、C 界面方案；选择前不会修改项目界面。",409);
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
  async concepts(owner:ProjectOwner,id:string):Promise<ProjectConceptSet|null>{
    await this.get(owner,id);
    const set=(await this.pool.query<Omit<ProjectConceptSet,"concepts">>('SELECT id,project_id AS "projectId",revision,screen,width,height,status,selected_direction AS "selectedDirection",created_at AS "createdAt",updated_at AS "updatedAt" FROM harness_project_concept_sets WHERE project_id=$1 AND status<>\'superseded\' ORDER BY created_at DESC LIMIT 1',[id])).rows[0];
    if(!set)return null;
    const concepts=(await this.pool.query<{id:string;setId:string;direction:ConceptDirection;title:string;prompt:string;strength:string;tradeoff:string;mimeType:string;bytes:number;createdAt:string}>('SELECT id,set_id AS "setId",direction,title,prompt,strength,tradeoff,mime_type AS "mimeType",size_bytes AS bytes,created_at AS "createdAt" FROM harness_project_concepts WHERE set_id=$1 AND status=\'completed\' ORDER BY direction',[set.id])).rows;
    return{...set,concepts};
  }
  async beginConcept(owner:ProjectOwner,id:string,input:{requestId:string;direction:unknown;screen:string;width:number;height:number;prompt:string;title:string;strength:string;tradeoff:string}):Promise<{setId:string;conceptId:string;cached:boolean}>{
    const direction=conceptDirection(input.direction);
    if(!/^[A-Za-z0-9_-]{8,160}$/u.test(input.requestId)||!/^[A-Za-z0-9_-]{1,40}$/u.test(input.screen)||
      input.width!==1536||input.height!==864||input.prompt.length<20||input.prompt.length>8000||
      !input.title.trim()||input.title.length>80||!input.strength.trim()||input.strength.length>160||!input.tradeoff.trim()||input.tradeoff.length>160)
      throw new ProjectError("PROJECT_CONCEPT_INPUT_INVALID","界面方案参数无效。");
    return this.locked(id,async db=>{
      const project=await this.get(owner,id,db);
      const prior=(await db.query<{id:string;set_id:string;direction:ConceptDirection;status:string}>("SELECT id,set_id,direction,status FROM harness_project_concepts WHERE project_id=$1 AND request_id=$2",[id,input.requestId])).rows[0];
      if(prior){
        if(prior.direction!==direction)throw new ProjectError("PROJECT_REQUEST_CONFLICT","同一请求标识不能生成不同方案。",409);
        if(prior.status==="completed")return{setId:prior.set_id,conceptId:prior.id,cached:true};
        throw new ProjectError("PROJECT_CONCEPT_REQUEST_SETTLED","该方案请求已在处理或已失败，请刷新状态后使用新请求重试。",409);
      }
      const daily=await db.query<{count:string}>("SELECT count(*) FROM harness_project_concepts WHERE project_id=$1 AND created_at>now()-interval '24 hours'",[id]);
      if(Number(daily.rows[0]?.count)>=9)throw new ProjectError("PROJECT_CONCEPT_QUOTA","该项目今天已生成 9 张概念图，请明天继续。",429);
      let set=(await db.query<{id:string;revision:number;screen:string;status:string}>("SELECT id,revision,screen,status FROM harness_project_concept_sets WHERE project_id=$1 AND status IN ('generating','awaiting_selection') ORDER BY created_at DESC LIMIT 1 FOR UPDATE",[id])).rows[0];
      if(set?.status==="awaiting_selection")throw new ProjectError("PROJECT_CONCEPT_SELECTION_REQUIRED","三套方案已生成，请先选择 A、B 或 C。",409);
      if(set&&(set.revision!==project.revision||set.screen!==input.screen))throw new ProjectError("PROJECT_CONCEPT_SET_CONFLICT","当前概念批次与项目版本不一致，请先完成现有选择。",409);
      if(!set){
        await db.query("UPDATE harness_project_concept_sets SET status='superseded',updated_at=now() WHERE project_id=$1 AND status='selected'",[id]);
        const setId=newId("uis");
        await db.query("INSERT INTO harness_project_concept_sets(id,project_id,revision,screen,width,height) VALUES($1,$2,$3,$4,$5,$6)",[setId,id,project.revision,input.screen,input.width,input.height]);
        set={id:setId,revision:project.revision,screen:input.screen,status:"generating"};
      }
      const existing=(await db.query<{id:string;status:string}>("SELECT id,status FROM harness_project_concepts WHERE set_id=$1 AND direction=$2 FOR UPDATE",[set.id,direction])).rows[0];
      if(existing?.status==="completed")return{setId:set.id,conceptId:existing.id,cached:true};
      if(existing?.status==="generating")throw new ProjectError("PROJECT_CONCEPT_BUSY","该方向正在生成，请等待完成。",409);
      const conceptId=existing?.id??newId("uic");
      if(existing)await db.query("UPDATE harness_project_concepts SET request_id=$1,title=$2,prompt=$3,strength=$4,tradeoff=$5,status='generating',error=NULL,updated_at=now() WHERE id=$6",
        [input.requestId,input.title.trim(),input.prompt,input.strength.trim(),input.tradeoff.trim(),conceptId]);
      else await db.query("INSERT INTO harness_project_concepts(id,set_id,project_id,request_id,direction,title,prompt,strength,tradeoff) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [conceptId,set.id,id,input.requestId,direction,input.title.trim(),input.prompt,input.strength.trim(),input.tradeoff.trim()]);
      return{setId:set.id,conceptId,cached:false};
    });
  }
  async completeConcept(owner:ProjectOwner,id:string,conceptId:string,mimeType:string,content:Buffer):Promise<ProjectConceptSet>{
    if(!["image/png","image/jpeg","image/webp"].includes(mimeType)||content.length<1024||content.length>5242880)
      throw new ProjectError("PROJECT_CONCEPT_IMAGE_INVALID","图片结果格式或大小无效。",502);
    await this.locked(id,async db=>{
      await this.get(owner,id,db);
      const row=(await db.query<{set_id:string}>("SELECT set_id FROM harness_project_concepts WHERE id=$1 AND project_id=$2 AND status='generating' FOR UPDATE",[conceptId,id])).rows[0];
      if(!row)throw new ProjectError("PROJECT_CONCEPT_NOT_PENDING","界面方案生成状态已变化。",409);
      await db.query("UPDATE harness_project_concepts SET status='completed',mime_type=$1,content=$2,sha256=$3,size_bytes=$4,error=NULL,updated_at=now() WHERE id=$5",
        [mimeType,content,createHash("sha256").update(content).digest("hex"),content.length,conceptId]);
      const count=await db.query<{count:string}>("SELECT count(DISTINCT direction) FROM harness_project_concepts WHERE set_id=$1 AND status='completed'",[row.set_id]);
      await db.query("UPDATE harness_project_concept_sets SET status=$1,updated_at=now() WHERE id=$2",[Number(count.rows[0]?.count)===3?"awaiting_selection":"generating",row.set_id]);
    });
    return(await this.concepts(owner,id))!;
  }
  async failConcept(owner:ProjectOwner,id:string,conceptId:string,message:string):Promise<void>{
    await this.get(owner,id);
    await this.pool.query("UPDATE harness_project_concepts SET status='failed',error=$1,content=NULL,updated_at=now() WHERE id=$2 AND project_id=$3 AND status='generating'",[message.slice(0,500),conceptId,id]);
  }
  async discardConcepts(owner:ProjectOwner,id:string):Promise<void>{
    await this.locked(id,async db=>{
      await this.get(owner,id,db);
      const changed=await db.query("UPDATE harness_project_concept_sets SET status='superseded',updated_at=now() WHERE project_id=$1 AND status IN ('generating','awaiting_selection')",[id]);
      if(!changed.rowCount)throw new ProjectError("PROJECT_CONCEPT_SET_NOT_ACTIVE","当前没有等待处理的界面方案。",409);
    });
  }
  async selectConcept(owner:ProjectOwner,id:string,directionInput:unknown):Promise<{project:Project;conceptSet:ProjectConceptSet}>{
    const direction=conceptDirection(directionInput);
    const result=await this.locked(id,async db=>{
      const project=await this.get(owner,id,db);
      const set=(await db.query<{id:string;status:string;selected_direction:ConceptDirection|null;screen:string}>("SELECT id,status,selected_direction,screen FROM harness_project_concept_sets WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE",[id])).rows[0];
      if(!set||!["awaiting_selection","selected"].includes(set.status))throw new ProjectError("PROJECT_CONCEPTS_INCOMPLETE","请先生成完整的 A、B、C 三套方案。",409);
      if(set.status==="selected"){
        if(set.selected_direction!==direction)throw new ProjectError("PROJECT_CONCEPT_ALREADY_SELECTED","本批次已选择其他方案。",409);
        return project;
      }
      const concepts=(await db.query<{direction:ConceptDirection;title:string;prompt:string;strength:string;tradeoff:string;id:string}>("SELECT id,direction,title,prompt,strength,tradeoff FROM harness_project_concepts WHERE set_id=$1 AND status='completed' ORDER BY direction",[set.id])).rows;
      if(concepts.length!==3||!concepts.some(item=>item.direction===direction))throw new ProjectError("PROJECT_CONCEPTS_INCOMPLETE","三套方案尚未全部生成。",409);
      await db.query("UPDATE harness_project_concept_sets SET status='selected',selected_direction=$1,updated_at=now() WHERE id=$2",[direction,set.id]);
      const path="evidence/ui-concepts/"+set.screen+"/concept-manifest.json";
      const manifest=JSON.stringify({screen:set.screen,viewport:[1536,864],concepts:concepts.map(item=>({id:item.direction,title:item.title,path:"project-concept:"+item.id,prompt_direction:item.prompt,strength:item.strength,tradeoff:item.tradeoff})),selected:direction},null,2);
      await db.query("INSERT INTO harness_project_files VALUES($1,$2,$3) ON CONFLICT(project_id,path) DO UPDATE SET content=excluded.content",[id,path,manifest]);
      await db.query("UPDATE harness_projects SET revision=revision+1,updated_at=now() WHERE id=$1",[id]);
      return this.get(owner,id,db);
    });
    return{project:result,conceptSet:(await this.concepts(owner,id))!};
  }
  async conceptImage(owner:ProjectOwner,id:string,conceptId:string):Promise<{mimeType:string;content:Buffer}>{
    await this.get(owner,id);
    const row=(await this.pool.query<{mime_type:string;content:Buffer}>("SELECT mime_type,content FROM harness_project_concepts WHERE id=$1 AND project_id=$2 AND status='completed'",[conceptId,id])).rows[0];
    if(!row?.content||!["image/png","image/jpeg","image/webp"].includes(row.mime_type))throw new ProjectError("PROJECT_CONCEPT_NOT_FOUND","界面方案图片不存在。",404);
    return{mimeType:row.mime_type,content:row.content};
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
