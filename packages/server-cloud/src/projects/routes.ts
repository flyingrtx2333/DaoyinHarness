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
   action:{type:"string",enum:["capabilities","list","create","get","bound","bind","files","write","rename","versions","operations","concepts","concept_generate","concept_select","concept_discard","check","preview","publish","rollback","ticket","cancel"]},
   projectId:{type:"string",pattern:"^prj_[a-f0-9]{24}$"},title:{type:"string",minLength:1,maxLength:80},
   requestId:{type:"string",minLength:8,maxLength:160},sessionId:{type:"string",maxLength:160},
   revision:{type:"integer",minimum:1},files:{type:"array",maxItems:60},slug:{type:"string",maxLength:42},
   versionId:{type:"string",pattern:"^ver_[a-f0-9]{24}$"},operationId:{type:"string",pattern:"^op_[a-f0-9]{24}$"},
   direction:{type:"string",enum:["A","B","C"]},screen:{type:"string",pattern:"^[A-Za-z0-9_-]{1,40}$"},
   width:{type:"integer",enum:[1536]},height:{type:"integer",enum:[864]},prompt:{type:"string",minLength:20,maxLength:8000},
   strength:{type:"string",minLength:1,maxLength:160},tradeoff:{type:"string",minLength:1,maxLength:160}
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
 app.get<{Params:{accountScope:string;projectId:string;conceptId:string}}>("/api/v1/cloud/projects/:accountScope/:projectId/concepts/:conceptId/image",{
  schema:{params:{type:"object",additionalProperties:false,required:["accountScope","projectId","conceptId"],properties:{
   accountScope:{type:"string",pattern:"^[a-f0-9]{64}$"},projectId:{type:"string",pattern:"^prj_[a-f0-9]{24}$"},conceptId:{type:"string",pattern:"^uic_[a-f0-9]{24}$"}
  }}}
 },async(request,reply)=>{
  const identity=options.identityFor(request);await options.ensureActive(identity);
  try{
   const result=await projectCall<{mimeType:string;content:string}>(identity,{action:"concept_image",projectId:request.params.projectId,conceptId:request.params.conceptId});
   const bytes=Buffer.from(result.content,"base64");
   if(bytes.length<1024||bytes.length>5242880||!["image/png","image/jpeg","image/webp"].includes(result.mimeType))throw new Error("Invalid concept image");
   return reply.header("Cache-Control","private, max-age=300").header("X-Content-Type-Options","nosniff")
    .header("Cross-Origin-Resource-Policy","same-origin").type(result.mimeType).send(bytes);
  }catch(e){if(e instanceof ProjectError)throw new CloudError(e.status,e.code,e.message);throw e;}
 });
}
