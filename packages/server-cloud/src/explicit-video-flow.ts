import type { ModelClient, ModelRequest, ModelReply } from "@daoyin/harness-agent-core";
import type { CloudRun } from "./repository.js";

const MINI = "doubao-seedance-2-0-mini-260615";
const REQUIRED_TOOLS = ["story_video_options", "story_estimate_video", "request_video_confirmation", "story_create_video"] as const;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function isExplicitNewVideoRequest(message: string): boolean {
  const text = message.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!text || text.includes("[已上传参考") || /^(?:如何|怎么|为什么|为何|是否支持|能否查询|查询|查看|刷新|取消|停止|不要)/u.test(text)) return false;
  // Multi-shot deliverables must stay in the normal Agent path so it can plan
  // a durable Story production, narration, subtitles and the final export.
  if (/(?:宣传片|宣传短片|宣传视频|成片|短剧|分镜|混剪|片尾|旁白|字幕|配音)|(?:[2-9]\d|[1-9]\d{2,})\s*秒|(?:半|一|两|二)\s*分钟/u.test(text)) return false;
  return /^(?:(?:请|请你|帮我|给我|我要|我想|想要|立即|直接)\s*)?(?:生成|制作|创建|做)(?:一段|一个|个|段)?[^。！？\n]{0,100}(?:视频|短片)(?:[。！!]?)$/u.test(text);
}

function toolResult(request: ModelRequest, name: string): Record<string, unknown> | undefined {
  const item = [...request.messages].reverse().find((message) => message.role === "tool" && message.toolName === name);
  if (item?.role !== "tool") return undefined;
  try { const value: unknown = JSON.parse(item.content); return record(value) ? value : undefined; }
  catch { return undefined; }
}

function text(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value : undefined; }
function integer(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined; }

function defaults(request: ModelRequest, prompt: string, requestKey: string): Record<string, unknown> {
  const outcome = toolResult(request, "story_video_options");
  const result = record(outcome?.result) ? outcome.result : undefined;
  const data = record(result?.data) ? result.data : undefined;
  const models = Array.isArray(data?.models) ? data.models.filter(record) : [];
  const selected = models.find((model) => model.model_name === MINI) ??
    models.find((model) => model.model_name === data?.default_model) ?? models[0];
  const resolutions = Array.isArray(selected?.resolutions) ? selected.resolutions.filter((item): item is string => typeof item === "string") : [];
  const durations = Array.isArray(selected?.duration_seconds) ? selected.duration_seconds.map(integer).filter((item): item is number => item !== undefined) : [];
  return {
    modelName: text(selected?.model_name) ?? text(data?.default_model) ?? MINI,
    resolution: resolutions.includes("720p") ? "720p" : text(selected?.default_resolution) ?? text(data?.default_resolution) ?? "720p",
    durationSeconds: durations.includes(10) ? 10 : integer(data?.duration_seconds) ?? durations[0] ?? 10,
    prompt, aspectRatio: "16:9", target: "new", request_key: requestKey,
  };
}

async function polishPrompt(model: ModelClient, request: ModelRequest, original: string): Promise<string> {
  const reply = await model.complete({ messages: [{ role: "user", content: original }], tools: [], signal: request.signal,
    systemPrompt: { stableText: `你是视频生成提示词编辑器。把用户的简短视频创意润色为一段可直接交给视频生成模型的中文提示词。
忠实保留主题，不添加用户未要求的台词、品牌、人物身份或敏感内容；补全镜头、主体动作、环境、光影、节奏和声音设计。
没有明确口播时写明“无旁白、无人物对白”；高燃内容匹配有冲击力的背景音乐。只输出提示词正文，不解释、不列参数、不使用 Markdown，最多 1200 字。`,
      dynamicText: "", sections: [{ id: "video_prompt_polish", kind: "stable" }] } });
  if (reply.kind !== "assistant") throw new Error("Video prompt polishing did not return text.");
  const polished = reply.content.trim();
  if (!polished || polished.length > 5000) throw new Error("Video prompt polishing returned invalid text.");
  return polished;
}

function call(id: string, name: string, input: Record<string, unknown>): ModelReply {
  return { kind: "tool_calls", calls: [{ id, name, input }] };
}

/** Deterministic paid-action preflight: explicit creation opens the existing modal instead of becoming prose. */
export function createExplicitVideoFlow(run: CloudRun, model: ModelClient): ModelClient | undefined {
  if (!isExplicitNewVideoRequest(run.userMessage)) return undefined;
  const requestKey = `harness_${run.id.replace(/^run_/u, "").replaceAll("-", "")}`;
  let stage = 0;
  let input: Record<string, unknown> | undefined;
  return { complete: async (request) => {
    request.signal.throwIfAborted();
    if (!REQUIRED_TOOLS.every((name) => request.tools.some((tool) => tool.name === name))) {
      return { kind: "assistant", content: "当前视频生成能力未完整接入，本轮未提交生成任务。" };
    }
    if (stage === 0) { stage = 1; return call("video_options", "story_video_options", {}); }
    if (stage === 1) {
      const options = toolResult(request, "story_video_options");
      if (options?.ok !== true) return { kind: "assistant", content: text(options?.message) ?? "当前未能读取可用视频模型，本轮未提交生成任务。" };
      let prompt: string;
      try { prompt = await polishPrompt(model, request, run.userMessage); }
      catch { return { kind: "assistant", content: "AI 未能完成视频提示词润色，本轮未提交生成任务，请重试。" }; }
      input = defaults(request, prompt, requestKey); stage = 2;
      return call("video_estimate", "story_estimate_video", { modelName: input.modelName!, resolution: input.resolution!,
        durationSeconds: input.durationSeconds!, hasVideoInput: false });
    }
    if (stage === 2) {
      const estimate = toolResult(request, "story_estimate_video");
      if (estimate?.ok !== true) return { kind: "assistant", content: text(estimate?.message) ?? "当前未能完成费用估算，本轮未提交生成任务。" };
      stage = 3; return call("video_confirmation", "request_video_confirmation", { operation: "story_create_video", input: input! });
    }
    if (stage === 3) {
      const confirmation = toolResult(request, "request_video_confirmation");
      const confirmed = record(confirmation?.result) && confirmation.result.operation === "story_create_video" && record(confirmation.result.input)
        ? confirmation.result.input : undefined;
      if (confirmation?.ok !== true || confirmed === undefined) return { kind: "assistant", content: "已取消本次视频生成，未提交生成任务。" };
      input = confirmed; stage = 4; return call("video_create", "story_create_video", confirmed);
    }
    const created = toolResult(request, "story_create_video");
    if (created?.ok !== true) return { kind: "assistant", content: text(created?.message) ?? "视频生成请求未完成，请查看上方失败原因。" };
    return { kind: "assistant", content: "视频生成任务已提交，可在下方查看状态；生成积分以任务最终结算为准。" };
  } };
}
