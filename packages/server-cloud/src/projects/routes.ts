import type {FastifyInstance,FastifyRequest} from "fastify";
import type {ExecutionIdentity} from "@daoyin/harness-contracts";
import type {CloudRepository} from "../repository.js";
import {CloudError} from "../repository.js";
import {projectCall} from "./tools.js";
import {ProjectError} from "./contracts.js";
export function registerProjectRoutes(app:FastifyInstance,options:{
 repository:CloudRepository;identityFor(request:FastifyRequest):ExecutionIdentity;
 ensureActive(identity:ExecutionIdentity,signal?:AbortSignal):Promise<void>;
}):void{
 app.post<{Body:Record<string,unknown>}>("/api/v1/cloud/projects/control",{
  bodyLimit:600000,
  schema:{body:{type:"object",additionalProperties:false,required:["action"],properties:{
   action:{type:"string",enum:["capabilities","list","create","get","bound","bind","files","write","rename","versions","operations","check","preview","publish","rollback","ticket","cancel"]},
   projectId:{type:"string",pattern:"^prj_[a-f0-9]{24}$"},title:{type:"string",minLength:1,maxLength:80},
   requestId:{type:"string",minLength:8,maxLength:160},sessionId:{type:"string",maxLength:160},
   revision:{type:"integer",minimum:1},files:{type:"array",maxItems:60},slug:{type:"string",maxLength:42},
   versionId:{type:"string",pattern:"^ver_[a-f0-9]{24}$"},operationId:{type:"string",pattern:"^op_[a-f0-9]{24}$"}
  }}}
 },async(request)=>{
  const identity=options.identityFor(request);await options.ensureActive(identity);
  if(typeof request.body.sessionId==="string"){
   await options.repository.getSession(identity,request.body.sessionId);
   if(["bind","create"].includes(String(request.body.action))){
    const runs=await options.repository.listRuns(identity,request.body.sessionId);
    if(runs.some(r=>["running","queued"].includes(r.status)))throw new CloudError(409,"PROJECT_SESSION_BUSY","请等待当前对话执行完成后切换项目。");
   }
  }
  try{return await projectCall(identity,request.body);}
  catch(e){if(e instanceof ProjectError)throw new CloudError(e.status,e.code,e.message);throw e;}
 });
}
