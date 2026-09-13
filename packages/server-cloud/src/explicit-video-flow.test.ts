import { describe, expect, it, vi } from "vitest";
import type { CloudRun } from "./repository.js";
import { createExplicitVideoFlow, isExplicitNewVideoRequest } from "./explicit-video-flow.js";

describe("explicit video flow", () => {
  it("routes explicit new-video commands but leaves questions and referenced edits to the Agent", () => {
    expect(isExplicitNewVideoRequest("生成一段高燃混剪视频")).toBe(true);
    expect(isExplicitNewVideoRequest("帮我制作一个体育宣传短片")).toBe(true);
    expect(isExplicitNewVideoRequest("怎么生成视频？")).toBe(false);
    expect(isExplicitNewVideoRequest("查询视频生成进度")).toBe(false);
    expect(isExplicitNewVideoRequest("生成视频\n\n[已上传参考图片，文件名：a.png，素材 ID：asset_1]")).toBe(false);
  });

  it("starts with capability discovery without calling the paid generation tool", async () => {
    const run = { id: "run_12345678-1234-1234-1234-123456789012", userMessage: "生成一段高燃混剪视频" } as CloudRun;
    const polish = vi.fn(async () => ({ kind: "assistant" as const, content: "高速动作蒙太奇，强对比光影，无旁白。" }));
    const model = createExplicitVideoFlow(run, { complete: polish })!;
    const tools = ["story_video_options", "story_estimate_video", "request_video_confirmation", "story_create_video"].map(name => ({
        name, description: name, inputSchema: {}, category: "extension" as const, mutating: name === "story_create_video",
      }));
    const common = { tools, systemPrompt: { stableText: "", dynamicText: "", sections: [] }, signal: new AbortController().signal };
    const reply = await model.complete({ ...common, messages: [{ role: "user", content: run.userMessage }] });
    expect(reply).toMatchObject({ kind: "tool_calls", calls: [{ name: "story_video_options" }] });
    const estimated = await model.complete({ ...common, messages: [{ role: "user", content: run.userMessage },
      { role: "tool", toolCallId: "video_options", toolName: "story_video_options",
        content: JSON.stringify({ ok: true, result: { data: { default_model: "doubao-seedance-2-0-mini-260615",
          models: [{ model_name: "doubao-seedance-2-0-mini-260615", resolutions: ["480p", "720p"], duration_seconds: [5, 10] }] } } }) }] });
    expect(polish).toHaveBeenCalledOnce();
    expect(estimated).toMatchObject({ kind: "tool_calls", calls: [{ name: "story_estimate_video",
      input: { modelName: "doubao-seedance-2-0-mini-260615", resolution: "720p", durationSeconds: 10 } }] });
  });
});
