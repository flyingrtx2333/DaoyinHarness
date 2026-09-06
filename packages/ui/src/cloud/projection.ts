import type { AgentEvent } from "@daoyin/harness-protocol";
import type { CloudRun } from "./client.js";

export interface PublicSource { id: string; title: string; location: string; content: string }
export interface ToolView { id: string; status: "running" | "completed" | "failed"; text: string }
export interface TurnView { run: CloudRun; text: string; tools: ToolView[]; sources: PublicSource[] }
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function projectTurns(runs: CloudRun[], events: AgentEvent[]): TurnView[] {
  const turns = [...runs].reverse().map((run) => ({ run, text: "", tools: [] as ToolView[], sources: [] as PublicSource[] }));
  const byId = new Map(turns.map((turn) => [turn.run.id, turn]));
  const seen = new Set<number>();
  for (const event of [...events].sort((a, b) => a.eventSeq - b.eventSeq)) {
    if (seen.has(event.eventSeq)) continue;
    seen.add(event.eventSeq);
    const turn = byId.get(event.turnId);
    if (!turn) continue;
    if (event.type === "assistant.delta") turn.text += event.payload.delta;
    if (event.type === "tool.started" || event.type === "tool.completed" || event.type === "tool.failed") {
      const id = event.payload.toolCallId;
      let tool = turn.tools.find((item) => item.id === id);
      const payload: unknown = event.payload;
      const name = record(payload) ? payload.toolName ?? payload.name : undefined;
      const isSaishi = typeof name === "string" && name.startsWith("saishi_");
      if (!tool) { tool = { id, status: "running", text: isSaishi ? "正在查询授权赛事数据" : "正在检索公开资料" }; turn.tools.push(tool); }
      if (event.type === "tool.completed") {
        const result: unknown = event.payload.evidence.result;
        const saishiResult = record(result) && result.readOnly === true && typeof result.tool === "string" && result.tool.startsWith("saishi_");
        tool.status = "completed"; tool.text = saishiResult ? "赛事只读查询完成" : "公开资料检索完成";
        if (record(result) && Array.isArray(result.sources)) for (const source of result.sources.slice(0, 5)) {
          if (record(source) && typeof source.id === "string" && typeof source.title === "string" && typeof source.content === "string" &&
              !turn.sources.some((existing) => existing.id === source.id)) {
            turn.sources.push({ id: source.id, title: source.title.slice(0, 240),
              location: typeof source.location === "string" ? source.location.slice(0, 240) : "", content: source.content.slice(0, 2000) });
          }
        }
      }
      if (event.type === "tool.failed") { tool.status = "failed"; tool.text = isSaishi || tool.text.includes("赛事") ? "赛事查询未完成" : "公开资料检索未完成"; }
    }
  }
  for (const turn of turns) {
    const terminal = turn.run.status !== "running" && turn.run.status !== "queued";
    if (!turn.text && terminal) turn.text = turn.run.finalText || "任务已结束，未返回回答正文。";
    if (terminal) for (const tool of turn.tools) {
      if (tool.status === "running") { tool.status = "failed"; tool.text = "检索已停止"; }
    }
  }
  return turns;
}
