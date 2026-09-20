import type { AgentEvent } from "@daoyin/harness-protocol";
import type { CloudRun } from "./client.js";

export interface PublicSource { id: string; title: string; location: string; content: string }
export interface EventImage { id: number; eventId: number; kind: "event_cover" | "material" | "highlight" | "video_preview"; title: string }
export interface ActivityView {
  id: string;
  kind: "routing" | "phase" | "commentary" | "tool";
  status: "running" | "completed" | "failed";
  text: string;
  startedAt: string;
  finishedAt?: string;
  phaseGroup?: string;
  detailSummary?: string | undefined;
  details?: ActivityDetail[];
}
export interface ActivityDetail { label: string; value: string }
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
const sensitiveKey = /authorization|cookie|credential|password|secret|token|api[_-]?key|stack/i;
const detailLabels: Record<string, string> = {
  args: "参数", argv: "参数", command: "命令", completed: "已完成", cwd: "工作目录", filePath: "文件", limit: "数量",
  method: "请求方式", operation: "操作", path: "路径", projectId: "项目", query: "查询", total: "总数", url: "地址",
};
function redactDetailString(value: string): string {
  return value.slice(0, 2000)
    .replace(/(bearer\s+)[a-z0-9._~+/-]+/gi, "$1[已隐藏]")
    .replace(/([?&](?:access_token|api_key|key|secret|token)=)[^&\s]+/gi, "$1[已隐藏]")
    .replace(/\bsk-[a-z0-9_-]{8,}\b/gi, "[已隐藏]");
}
function boundedDetail(value: unknown, depth = 0): unknown {
  if (depth > 4) return "…";
  if (typeof value === "string") return redactDetailString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => boundedDetail(item, depth + 1));
  if (!record(value)) return String(value ?? "");
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => item !== undefined && item !== "undefined" && !sensitiveKey.test(key)).slice(0, 30)
    .map(([key, item]) => [key, boundedDetail(item, depth + 1)]));
}
function detailText(value: unknown): string {
  const safe = boundedDetail(value);
  const text = typeof safe === "string" ? safe : JSON.stringify(safe, null, 2);
  return (text || "无").slice(0, 12000);
}
function compactValue(value: unknown): string {
  if (typeof value === "string") return redactDetailString(value).replace(/\s+/g, " ").trim().slice(0, 180);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.slice(0, 8).map(compactValue).filter(Boolean).join(" ").slice(0, 180);
  return "";
}
function summarizeInput(value: unknown): string | undefined {
  if (!record(value)) return undefined;
  const command = compactValue(value.command);
  const program = compactValue(value.program);
  const args = compactValue(value.args ?? value.argv);
  const commands = compactValue(value.commands);
  if (command) return `命令：${command}${args ? ` ${args}` : ""}`.slice(0, 240);
  if (program) return `命令：${program}${args ? ` ${args}` : ""}`.slice(0, 240);
  if (commands) return `命令：${commands}`.slice(0, 240);
  const preferred = ["query", "path", "filePath", "url", "operation", "projectId", "method", "limit"];
  const parts = preferred.flatMap((key) => {
    const compact = compactValue(value[key]);
    return compact ? [`${detailLabels[key] ?? key}：${compact}`] : [];
  });
  if (parts.length) return parts.slice(0, 2).join(" · ").slice(0, 240);
  const fallback = Object.entries(value).filter(([key, item]) => !sensitiveKey.test(key) && compactValue(item)).slice(0, 2)
    .map(([key, item]) => `${detailLabels[key] ?? key}：${compactValue(item)}`);
  return fallback.length ? fallback.join(" · ").slice(0, 240) : undefined;
}
function resultCount(value: unknown): string | undefined {
  if (!record(value)) return undefined;
  const data = record(value.data) ? value.data : value;
  for (const key of ["items", "results", "records", "files", "projects"]) {
    if (Array.isArray(data[key])) return `获取 ${data[key].length} 条数据`;
  }
  return undefined;
}
function phaseDetailSummary(value: unknown): string | undefined {
  if (!record(value)) return undefined;
  if (Array.isArray(value.actions)) {
    const labels = value.actions.flatMap((action) => record(action) ? [toolLabel(action)] : []).slice(0, 4);
    if (labels.length) return `下一步：${labels.join(" → ")}`;
  }
  return compactValue(value.next) || compactValue(value.status);
}
function setDetail(activity: ActivityView, label: string, value: unknown): void {
  const next = { label, value: detailText(value) };
  activity.details ??= [];
  const index = activity.details.findIndex((item) => item.label === label);
  if (index >= 0) activity.details[index] = next;
  else activity.details.push(next);
}
function appendDetail(activity: ActivityView, label: string, value: unknown): void {
  activity.details ??= [];
  const next = { label, value: detailText(value) };
  const previous = activity.details.at(-1);
  if (previous?.label === next.label && previous.value === next.value) return;
  activity.details.push(next);
  if (activity.details.length > 24) activity.details.splice(1, activity.details.length - 24);
}
function toolLabel(value: unknown): string {
  if (record(value) && typeof value.displayName === "string" && value.displayName.trim()) return value.displayName.trim().slice(0, 80);
  return "执行操作";
}

function completedActivityText(text: string): string {
  const replacements: Record<string, string> = {
    "正在准备任务上下文…": "任务上下文已准备",
    "正在规划下一步操作…": "下一步操作规划完成",
    "正在根据操作结果继续处理…": "操作结果处理完成",
    "正在理解需求并整理目标…": "下一步操作规划完成",
    "正在选择合适的操作步骤…": "下一步操作规划完成",
    "正在等待规划结果…": "下一步操作规划完成",
    "正在分析操作结果…": "操作结果处理完成",
    "正在整理下一步处理…": "操作结果处理完成",
    "正在等待后续处理结果…": "操作结果处理完成",
    "仍在处理，请稍候…": "处理完成",
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
    if (event.type === "assistant.commentary") {
      const currentBlock = blocks.get(event.turnId);
      const visibleText = turn.text.trimEnd();
      if (currentBlock === event.payload.contentBlockId && visibleText.endsWith(event.payload.text)) {
        turn.text = visibleText.slice(0, -event.payload.text.length).trimEnd();
        blocks.delete(event.turnId);
      }
      finishNonToolActivity(turn, event.occurredAt);
      turn.activities.push({
        id: `commentary_${event.eventSeq}`,
        kind: "commentary",
        status: "completed",
        text: event.payload.text,
        startedAt: event.occurredAt,
        finishedAt: event.occurredAt,
        detailSummary: event.payload.source === "model" ? "主模型公开说明" :
          event.payload.source === "router-model" ? "路由模型公开计划" : "系统兜底说明",
      });
    }
    if (event.type === "capability.routed") {
      finishNonToolActivity(turn, event.occurredAt);
      const packCount = event.payload.selectedPackIds.length;
      const toolCount = event.payload.exposedToolCount;
      turn.activities.push({ id: `route_${event.eventSeq}`, kind: "routing", status: "running",
        text: event.payload.phase === "expansion" ? `已追加 ${packCount} 个相关能力包` :
          `已准备 ${packCount} 个相关能力包 · ${toolCount} 个工具`, startedAt: event.occurredAt,
        detailSummary: event.payload.selectedPackIds.slice(0, 3).join("、"), details: [
          { label: "已选能力包", value: event.payload.selectedPackIds.join("\n") || "无" },
          { label: "路由信息", value: detailText({ exposedToolCount: toolCount, schemaCharacters: event.payload.schemaCharacters,
            fallback: event.payload.fallback, blockedHighRiskPackIds: event.payload.blockedHighRiskPackIds }) },
        ] });
    }
    if (event.type === "phase.updated") {
      turn.phaseText = event.payload.displayText;
      const phaseGroup = event.payload.phase + ":" + String(event.payload.step);
      const active = [...turn.activities].reverse().find((activity) => activity.kind === "phase" && activity.status === "running");
      if (active?.phaseGroup === phaseGroup) {
        active.text = event.payload.displayText;
        if (event.payload.detail !== undefined) {
          active.detailSummary = phaseDetailSummary(event.payload.detail) ?? active.detailSummary;
          setDetail(active, "公开规划", event.payload.detail);
        }
      } else {
        finishNonToolActivity(turn, event.occurredAt);
        const detail = event.payload.detail;
        turn.activities.push({ id: "phase_" + String(event.eventSeq), kind: "phase", status: "running",
          text: event.payload.displayText, startedAt: event.occurredAt, phaseGroup,
          detailSummary: phaseDetailSummary(detail) ?? "等待模型首个可显示响应",
          ...(detail === undefined ? {} : { details: [{ label: "公开规划", value: detailText(detail) }] }) });
      }
    }
    if (event.type === "tool.started" || event.type === "tool.progress" || event.type === "tool.completed" || event.type === "tool.failed") {
      const id = event.payload.toolCallId;
      let tool = turn.tools.find((item) => item.id === id);
      const payload: unknown = event.payload;
      const name = record(payload) ? payload.toolName ?? payload.name : undefined;
      const label = toolLabel(payload);
      if (!tool) {
        finishNonToolActivity(turn, event.occurredAt);
        tool = { id, kind: "tool", status: "running", text: `正在${label}…`, startedAt: event.occurredAt };
        turn.tools.push(tool); turn.activities.push(tool);
      }
      if (event.type === "tool.started") {
        const input = record(payload) ? payload.input : undefined;
        tool.detailSummary = summarizeInput(input);
        if (input !== undefined) setDetail(tool, "输入", input);
      }
      if (event.type === "tool.progress") {
        tool.text = event.payload.displayText;
        tool.detailSummary = summarizeInput(event.payload.detail) || event.payload.displayText;
        appendDetail(tool, "执行进度", { displayText: event.payload.displayText,
          completed: event.payload.completed, total: event.payload.total, detail: event.payload.detail });
      }
      if (event.type === "tool.completed" || event.type === "tool.failed") tool.finishedAt = event.occurredAt;
      if (event.type === "tool.completed") {
        const result: unknown = event.payload.evidence.result;
        tool.status = "completed"; tool.text = `${label}完成`;
        const outcomeSummary = resultCount(result) || event.payload.summary;
        tool.detailSummary = tool.detailSummary?.startsWith("命令：") && outcomeSummary
          ? `${tool.detailSummary} · ${outcomeSummary}`.slice(0, 320) : outcomeSummary || tool.detailSummary;
        setDetail(tool, "结果摘要", event.payload.summary || resultCount(result) || "已完成");
        if (result !== undefined) setDetail(tool, "结果数据", result);
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
      if (event.type === "tool.failed") {
        tool.status = "failed"; tool.text = `${label}未完成`; tool.detailSummary = event.payload.message;
        setDetail(tool, "错误", { code: event.payload.code, message: event.payload.message, retryable: event.payload.retryable,
          details: event.payload.details });
      }
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
