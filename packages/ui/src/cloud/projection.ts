import type { AgentEvent } from "@daoyin/harness-protocol";
import type { CloudRun } from "./client.js";

export interface PublicSource { id: string; title: string; location: string; content: string }
export interface EventImage { id: number; eventId: number; kind: "material" | "highlight" | "video_preview"; title: string }
export interface ToolView { id: string; status: "running" | "completed" | "failed"; text: string; startedAt: string; finishedAt?: string }
export interface TurnView { run: CloudRun; text: string; tools: ToolView[]; sources: PublicSource[]; images: EventImage[]; assistantOccurredAt: string }
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const toolLabels: Record<string, string> = {
  search_company_knowledge: "检索公开资料", saishi_list_events: "查询赛事列表", saishi_get_event: "查询赛事详情",
  saishi_list_cameras: "查询摄像机", saishi_list_materials: "查询素材", saishi_get_map: "查询赛事地图",
  saishi_find_participants: "查询参赛者", saishi_get_timeline: "查询赛事时间线", saishi_get_job: "查询任务进度",
  saishi_list_images: "查找赛事图片",
};

export function projectTurns(runs: CloudRun[], events: AgentEvent[]): TurnView[] {
  const turns = [...runs].reverse().map((run) => ({ run, text: "", tools: [] as ToolView[], sources: [] as PublicSource[], images: [] as EventImage[], assistantOccurredAt: run.createdAt }));
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
      if (turn.text && blocks.get(event.turnId) !== event.payload.contentBlockId) turn.text += "\n\n";
      blocks.set(event.turnId, event.payload.contentBlockId);
      turn.text += event.payload.delta;
    }
    if (event.type === "tool.started" || event.type === "tool.completed" || event.type === "tool.failed") {
      const id = event.payload.toolCallId;
      let tool = turn.tools.find((item) => item.id === id);
      const payload: unknown = event.payload;
      const name = record(payload) ? payload.toolName ?? payload.name : undefined;
      const isSaishi = typeof name === "string" && name.startsWith("saishi_");
      const label = typeof name === "string" ? toolLabels[name] ?? (isSaishi ? "查询赛事数据" : "执行工具") : "执行工具";
      if (!tool) { tool = { id, status: "running", text: `正在${label}…`, startedAt: event.occurredAt }; turn.tools.push(tool); }
      if (event.type !== "tool.started") tool.finishedAt = event.occurredAt;
      if (event.type === "tool.completed") {
        const result: unknown = event.payload.evidence.result;
        tool.status = "completed"; tool.text = `${label}完成`;
        if (name === "saishi_list_images" && record(result) && result.tool === name && record(result.data) && Array.isArray(result.data.items)) {
          for (const image of result.data.items.slice(0, 12)) {
            if (!record(image) || typeof image.image_id !== "number" || !Number.isSafeInteger(image.image_id) || image.image_id < 1 ||
                typeof image.event_id !== "number" || !Number.isSafeInteger(image.event_id) || image.event_id < 1 ||
                !["material", "highlight", "video_preview"].includes(String(image.image_kind)) || turn.images.length >= 24) continue;
            const kind = image.image_kind as EventImage["kind"];
            if (!turn.images.some(item => item.id === image.image_id && item.kind === kind && item.eventId === image.event_id)) {
              turn.images.push({ id: image.image_id, eventId: image.event_id, kind, title: typeof image.title === "string" ? image.title.slice(0, 160) : "赛事图片" });
            }
          }
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
  }
  for (const turn of turns) {
    const terminal = turn.run.status !== "running" && turn.run.status !== "queued";
    if (!turn.text && terminal) turn.text = turn.run.finalText || "任务已结束，未返回回答正文。";
    if (terminal) for (const tool of turn.tools) {
      if (tool.status === "running") { tool.status = "failed"; tool.text = "执行已停止"; tool.finishedAt = turn.assistantOccurredAt; }
    }
  }
  return turns;
}
