import {describe,expect,it} from "vitest";
import {PROJECT_DEFINITIONS,PROJECT_INSTRUCTIONS,projectProgressDetail,validateProjectInput} from "./tools.js";

const projectId="prj_"+"a".repeat(24);
describe("independent project concept-to-ui policy",()=>{
  it("publishes the complete selection-gated tool contract",()=>{
    expect(PROJECT_DEFINITIONS.map(item=>item.name)).toEqual(expect.arrayContaining([
      "project_concepts","project_concept_generate","project_concept_select","project_concept_discard"
    ]));
    expect(PROJECT_INSTRUCTIONS).toContain("A、B、C");
    expect(PROJECT_INSTRUCTIONS).toContain("不得调用 project_write");
    expect(PROJECT_INSTRUCTIONS).toContain("每次优先只更新一个文件");
    expect(PROJECT_INSTRUCTIONS).toContain("单次写入内容不超过12000个字符");
    expect(PROJECT_INSTRUCTIONS).toContain("不能把整张概念图当页面背景");
  });
  it("accepts only the fixed concept viewport and closed direction schema",()=>{
    const valid={projectId,direction:"A",screen:"index",width:1536,height:864,title:"清晰主页",
      prompt:"保留登录、数据录入和上传入口，采用清晰的双栏信息层级。",strength:"重点明确",tradeoff:"信息密度较低"};
    expect(validateProjectInput("project_concept_generate",valid)).toBe(true);
    expect(validateProjectInput("project_concept_generate",{...valid,direction:"D"})).toBe(false);
    expect(validateProjectInput("project_concept_generate",{...valid,width:1440})).toBe(false);
    expect(validateProjectInput("project_concept_generate",{...valid,unknown:true})).toBe(false);
    expect(validateProjectInput("project_concept_select",{projectId,direction:"B"})).toBe(true);
  });
  it("reports user-safe sandbox commands without host-management details",()=>{
    expect(projectProgressDetail("preview","running")).toEqual({stage:"build_and_start",
      commands:["node /opt/harness/build.mjs","tsx server.ts"],sandbox:"gVisor",environment:"development"});
    expect(JSON.stringify(projectProgressDetail("preview","running"))).not.toContain("docker");
    expect(projectProgressDetail("check","queued")).toEqual({stage:"resource_queue",resource:"隔离开发环境"});
  });
});
