import type { AgentEvent } from "@daoyin/harness-protocol";
import type { CloudRun } from "./client.js";

export interface PublicSource { id: string; title: string; location: string; content: string }
export interface EventImage { id: number; eventId: number; kind: "event_cover" | "material" | "highlight" | "video_preview"; title: string }
export interface ActivityView {
  id: string;
  kind: "routing" | "phase" | "tool";
  status: "running" | "completed" | "failed";
  text: string;
  startedAt: string;
  finishedAt?: string;
}
export interface ToolView extends ActivityView { kind: "tool" }
export interface TurnView { run: CloudRun; text: string; phaseText: string; activities: ActivityView[]; tools: ToolView[]; sources: PublicSource[]; images: EventImage[]; assistantOccurredAt: string }
export interface PendingVideoInteraction {
  interactionId: string;
  runId: string;
  operation: "story_create_video" | "story_create_production";
  input: Record<string, unknown>;
  estimate?: unknown;
  firstFrameUrl?: string;
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const toolLabels: Record<string, string> = {
  project_list: "查看云端项目", project_create: "创建云端项目", project_files: "读取项目文件",
  project_write: "更新项目文件", project_concepts: "读取界面方案", project_concept_generate: "生成界面方案",
  project_concept_select: "选择界面方案", project_concept_discard: "放弃界面方案", project_check: "检查项目",
  project_preview: "构建开发预览", project_publish: "发布正式网站", project_rollback: "回滚网站版本",
  memory_search: "查询长期记忆", memory_remember: "保存长期记忆", memory_update: "更新长期记忆",
  memory_forget: "删除长期记忆", capability_search: "查找可用能力",
  search_company_knowledge: "检索公开资料", saishi_list_events: "查询赛事列表", saishi_get_event: "查询赛事详情",
  saishi_list_cameras: "查询摄像机", saishi_list_materials: "查询素材", saishi_get_map: "查询赛事地图",
  saishi_find_participants: "查询参赛者", saishi_get_timeline: "查询赛事时间线", saishi_get_job: "查询任务进度",
  saishi_list_images: "查找赛事图片", saishi_list_registrations: "查询报名记录", saishi_list_appeals: "查询申诉记录",
  saishi_list_scores: "查询成绩", saishi_create_competition: "创建大赛事", saishi_update_competition: "更新大赛事",
  saishi_create_event: "创建赛事", saishi_update_event: "更新赛事", saishi_review_registration: "审核报名",
  saishi_record_score: "录入成绩", saishi_resolve_appeal: "处理申诉", saishi_bind_camera: "绑定摄像机",
  saishi_update_camera: "更新摄像机", saishi_retry_job: "重试任务", saishi_publish_map: "发布赛事地图",
  story_video_options: "查询视频模型", story_recent_videos: "查询历史视频", story_get_video: "查询视频状态",
  story_estimate_video: "估算视频费用", story_create_video: "提交视频生成",
  request_video_confirmation: "等待视频确认",
};
function toolLabel(name: unknown): string {
  if (typeof name !== "string") return "执行操作";
  if (toolLabels[name]) return toolLabels[name];
  if (name.startsWith("saishi_")) return "查询赛事数据";
  if (name.includes("delegate")) return "分派子任务";
  if (name.includes("workflow") || name.includes("goal")) return "执行工作流";
  return "执行操作";
}
function completedActivityText(text: string): string {
  const replacements: Record<string, string> = {
    "正在准备任务上下文…": "任务上下文已准备",
    "正在规划下一步操作…": "下一步操作规划完成",
    "正在根据操作结果继续处理…": "操作结果处理完成",
  };
  return replacements[text] ?? text;
}
function finishNonToolActivity(turn: TurnView, finishedAt: string): void {
  for (const activity of turn.activities) {
    if (activity.kind !== "tool" && activity.status === "running") {
      activity.status = "completed";
      activity.text = completedActivityText(activity.text);
      activity.finishedAt = finishedAt;
    }
  }
}

export function pendingVideoInteraction(events: AgentEvent[], sessionId: string): PendingVideoInteraction | undefined {
  const terminalRuns = new Set(events.filter((event) => event.sessionId === sessionId &&
    ["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"].includes(event.type)).map((event) => event.turnId));
  const resolved = new Set(events.filter((event) => event.sessionId === sessionId && event.type === "interaction.resolved")
    .map((event) => event.type === "interaction.resolved" ? event.payload.interactionId : ""));
  const requested = [...events].reverse().find((event) => event.sessionId === sessionId && !terminalRuns.has(event.turnId) && event.type === "interaction.requested" &&
    event.payload.kind === "video_confirmation" && !resolved.has(event.payload.interactionId));
  if (requested?.type !== "interaction.requested" || !record(requested.payload.input)) return undefined;
  let firstFrameUrl: string | undefined;
  if (requested.payload.input.target === "continue") {
    for (const event of events) {
      if (event.turnId !== requested.turnId || event.type !== "tool.completed" || event.payload.toolName !== "story_get_video") continue;
      const result = event.payload.evidence.result;
      if (!record(result) || !record(result.data) || result.data.id !== requested.payload.input.source_video_id) continue;
      try { const url = new URL(String(result.data.last_frame_url)); if (url.protocol === "https:" && !url.username && !url.password) firstFrameUrl = url.href; } catch { /* No usable preview. */ }
    }
  }
  return { interactionId: requested.payload.interactionId, runId: requested.turnId, operation: requested.payload.operation,
    input: structuredClone(requested.payload.input), ...(firstFrameUrl ? { firstFrameUrl } : {}), ...(requested.payload.estimate === undefined ? {} : { estimate: requested.payload.estimate }) };
}

function appendImage(turn: TurnView, image: unknown): void {
  if (!record(image) || typeof image.image_id !== "number" || !Number.isSafeInteger(image.image_id) || image.image_id < 1 ||
      typeof image.event_id !== "number" || !Number.isSafeInteger(image.event_id) || image.event_id < 1 ||
      !["event_cover", "material", "highlight", "video_preview"].includes(String(image.image_kind)) || turn.images.length >= 24) return;
  const kind = image.image_kind as EventImage["kind"];
  if (turn.images.some(item => item.id === image.image_id && item.kind === kind && item.eventId === image.event_id)) return;
  turn.images.push({ id: image.image_id, eventId: image.event_id, kind,
    title: typeof image.title === "string" ? image.title.slice(0, 160) : kind === "event_cover" ? "赛事封面" : "赛事图片" });
}

function appendEventCover(turn: TurnView, event: unknown): void {
  if (!record(event) || typeof event.id !== "number" || !Number.isSafeInteger(event.id) || event.id < 1 ||
      typeof event.cover_image_id !== "number" || !Number.isSafeInteger(event.cover_image_id) || event.cover_image_id !== event.id) return;
  appendImage(turn, { image_id: event.cover_image_id, event_id: event.id, image_kind: "event_cover",
    title: typeof event.title === "string" ? `${event.title.slice(0, 140)} · 赛事封面` : "赛事封面" });
}

export function projectTurns(runs: CloudRun[], events: AgentEvent[]): TurnView[] {
  const turns = [...runs].reverse().map((run) => ({ run, text: "", phaseText: "", activities: [] as ActivityView[], tools: [] as ToolView[], sources: [] as PublicSource[], images: [] as EventImage[], assistantOccurredAt: run.createdAt }));
  const byId = new Map(turns.map((turn) => [turn.run.id, turn]));
  const seen = new Set<number>();
  const blocks = new Map<string, string>();
  for (const event of [...events].sort((a, b) => a.eventSeq - b.eventSeq)) {
    if (seen.has(event.eventSeq)) continue;
    seen.add(event.eventSeq);
    const turn = byId.get(event.turnId);
    if (!turn) continue;
    if (event.type.startsWith("assistant.") || (event.type.startsWith("turn.") && event.type !== "turn.started")) turn.assistantOccurredAt = event.occurredAt;
    if (event.type === "assistant.delta") {
      finishNonToolActivity(turn, event.occurredAt);
      if (turn.text && blocks.get(event.turnId) !== event.payload.contentBlockId) turn.text += "\n\n";
      blocks.set(event.turnId, event.payload.contentBlockId);
      turn.text += event.payload.delta;
    }
    if (event.type === "capability.routed") {
      finishNonToolActivity(turn, event.occurredAt);
      const packCount = event.payload.selectedPackIds.length;
      const toolCount = event.payload.exposedToolCount;
      turn.activities.push({ id: `route_${event.eventSeq}`, kind: "routing", status: "running",
        text: event.payload.phase === "expansion" ? `已追加 ${packCount} 个相关能力包` :
          `已准备 ${packCount} 个相关能力包 · ${toolCount} 个工具`, startedAt: event.occurredAt });
    }
    if (event.type === "phase.updated") {
      finishNonToolActivity(turn, event.occurredAt);
      turn.phaseText = event.payload.displayText;
      if (event.payload.phase !== "tool") {
        turn.activities.push({ id: `phase_${event.eventSeq}`, kind: "phase", status: "running",
          text: event.payload.displayText, startedAt: event.occurredAt });
      }
    }
    if (event.type === "tool.started" || event.type === "tool.progress" || event.type === "tool.completed" || event.type === "tool.failed") {
      const id = event.payload.toolCallId;
      let tool = turn.tools.find((item) => item.id === id);
      const payload: unknown = event.payload;
      const name = record(payload) ? payload.toolName ?? payload.name : undefined;
      const label = toolLabel(name);
      if (!tool) {
        finishNonToolActivity(turn, event.occurredAt);
        tool = { id, kind: "tool", status: "running", text: `正在${label}…`, startedAt: event.occurredAt };
        turn.tools.push(tool); turn.activities.push(tool);
      }
      if (event.type === "tool.progress") tool.text = event.payload.displayText;
      if (event.type === "tool.completed" || event.type === "tool.failed") tool.finishedAt = event.occurredAt;
      if (event.type === "tool.completed") {
        const result: unknown = event.payload.evidence.result;
        tool.status = "completed"; tool.text = `${label}完成`;
        if (record(result) && result.tool === name && record(result.data)) {
          if (name === "saishi_list_images" && Array.isArray(result.data.items)) {
            for (const image of result.data.items.slice(0, 12)) appendImage(turn, image);
          }
          if (name === "saishi_list_events" && Array.isArray(result.data.items)) {
            for (const item of result.data.items.slice(0, 8)) appendEventCover(turn, item);
          }
          if (name === "saishi_get_event") appendEventCover(turn, result.data);
        }
        if (record(result) && Array.isArray(result.sources)) for (const source of result.sources.slice(0, 5)) {
          if (record(source) && typeof source.id === "string" && typeof source.title === "string" && typeof source.content === "string" &&
              !turn.sources.some((existing) => existing.id === source.id)) {
            turn.sources.push({ id: source.id, title: source.title.slice(0, 240),
              location: typeof source.location === "string" ? source.location.slice(0, 240) : "", content: source.content.slice(0, 2000) });
          }
        }
      }
      if (event.type === "tool.failed") { tool.status = "failed"; tool.text = `${label}未完成`; }
    }
    if (["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"].includes(event.type)) {
      const status = event.type === "turn.completed" ? "completed" : "failed";
      for (const activity of turn.activities) if (activity.status === "running") {
        activity.status = status;
        if (status === "completed" && activity.kind !== "tool") activity.text = completedActivityText(activity.text);
        activity.finishedAt = event.occurredAt;
      }
    }
  }
  for (const turn of turns) {
    const terminal = turn.run.status !== "running" && turn.run.status !== "queued";
    if (!turn.text && terminal) turn.text = turn.run.finalText || "任务已结束，未返回回答正文。";
    if (terminal) for (const tool of turn.tools) {
      if (tool.status === "running") { tool.status = "failed"; tool.text = "执行已停止"; tool.finishedAt = turn.assistantOccurredAt; }
    }
    if (terminal) for (const activity of turn.activities) if (activity.status === "running") {
      activity.status = turn.run.status === "completed" ? "completed" : "failed";
      if (activity.status === "completed" && activity.kind !== "tool") activity.text = completedActivityText(activity.text);
      activity.finishedAt = turn.assistantOccurredAt;
    }
  }
  return turns;
}
