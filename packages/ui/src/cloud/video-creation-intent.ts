export interface VideoCreationRequest {
  mode: "quick" | "drama";
  title: string;
  content: string;
  aspectRatio: "16:9" | "9:16" | "1:1";
  duration: "4" | "5" | "10" | "15" | "30" | "60" | "90";
  resolution: "auto" | "480p" | "720p" | "768p" | "1080p";
  voiceover: string;
  music: string;
  notes: string;
}

const videoTarget = /(短剧|短视频|视频片段|宣传片|广告片|预告片|高燃剪辑|视频|短片|片子)/u;
const creationAction = /(生成|制作|做一?[个段部]?|创建|新建|剪辑|合成|产出)/u;
const directRequest = /(我想|我要|我需要|帮我|请|给我|替我|直接|马上)[，,：:\s]*(?:要|新|重新|直接|马上)?[，,：:\s]*(生成|制作|做一?[个段部]?|创建|新建|剪辑|合成|产出)/u;
const troubleshooting = /(失败|报错|错误|故障|无法生成|不能生成|没生成|没有生成|停止生成|取消生成|不要生成|不想生成|无需生成|别生成)/u;
const informational = /(怎么|如何|怎样|为什么|是什么|有哪些|介绍|教程|流程|区别|推荐|价格|费用|多少钱|支持吗|可以吗|能否|模型)/u;

export function isVideoCreationIntent(message: string): boolean {
  const normalized = message.replace(/\s+/gu, " ").trim();
  if (!normalized || !videoTarget.test(normalized) || troubleshooting.test(normalized)) return false;
  if (directRequest.test(normalized)) return true;
  return creationAction.test(normalized) && !informational.test(normalized);
}

export function buildVideoCreationMessage(request: VideoCreationRequest): string {
  const resolution = request.resolution === "auto" ? "按当前可用模型推荐" : request.resolution;
  const optional = (value: string): string => value.trim() || "无特殊要求";
  if (request.mode === "drama") {
    return [
      "请调用 story_create_production，一键创建可恢复的完整短剧父任务。",
      `项目名称：${request.title.trim() || request.content.trim().slice(0, 40)}`,
      `故事创意与内容要求：${request.content.trim()}`,
      `画幅：${request.aspectRatio}`,
      `目标总时长：${request.duration} 秒`,
      "单段时长：8 秒",
      "视频模型：AutoDL-MiniMax-H3",
      `清晰度：${resolution === "按当前可用模型推荐" ? "768p" : resolution}`,
      `配音或旁白：${optional(request.voiceover)}`,
      `背景音乐：${optional(request.music)}`,
      `其他要求：${optional(request.notes)}`,
      "我已通过制作表单明确确认本次剧本、分镜、分段视频、合片和字幕所产生的当前账号费用；请直接创建一次父任务，不要拆成多轮确认，也不要手工串联临时调用。",
    ].join("\n");
  }
  return [
    "请使用短剧制作工具新生成一段视频。",
    `画面内容：${request.content.trim()}`,
    `画幅：${request.aspectRatio}`,
    `时长：${request.duration} 秒`,
    `清晰度：${resolution}`,
    `配音或旁白：${optional(request.voiceover)}`,
    `背景音乐：${optional(request.music)}`,
    `其他要求：${optional(request.notes)}`,
    "请先查询当前账号可用的视频模型；以上参数受支持时直接提交生成，仅在存在关键冲突时再向我确认。",
  ].join("\n");
}
