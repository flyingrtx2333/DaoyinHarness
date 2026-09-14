import{describe,expect,it}from"vitest";
import{providerSafeConceptText}from"./concept-prompt.js";
describe("provider-safe concept prompts",()=>{
  it("keeps dashboard intent while avoiding provider-sensitive map wording",()=>{
    expect(providerSafeConceptText("全国地图与实时监控大屏")).toBe("抽象区域热力分布图与实时运营态势");
  });
});
