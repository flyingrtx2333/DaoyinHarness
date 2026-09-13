import { useEffect, useState } from "react";
import type { AgentEvent } from "@daoyin/harness-protocol";
import type { WorkbenchClient } from "./client.js";
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const safeUrl = (v: unknown): string | undefined => { try { const u = new URL(String(v)); return u.protocol === "https:" && !u.username && !u.password ? u.href : undefined; } catch { return undefined; } };
export function hasCreatedStoryVideo(events: AgentEvent[], runId: string): boolean {
  return events.some((event) => {
    if (event.turnId !== runId || event.type !== "tool.completed" || event.payload.toolName !== "story_create_video") return false;
    const result: unknown = event.payload.evidence.result;
    return record(result) && result.tool === "story_create_video" && record(result.data) && typeof result.data.id === "string";
  });
}
export function StoryVideos({ events, runId, client }: { events: AgentEvent[]; runId: string; client: WorkbenchClient }): React.JSX.Element | null {
  const ids: string[] = [];
  for (const event of events) {
    if (event.turnId !== runId || event.type !== "tool.completed") continue;
    const result: unknown = event.payload.evidence.result;
    if (record(result) && ["story_create_video", "story_get_video"].includes(String(result.tool)) && record(result.data) &&
        typeof result.data.id === "string" && !ids.includes(result.data.id)) ids.push(result.data.id);
  }
  return ids.length ? <div>{ids.slice(0, 8).map(id => <VideoCard key={id} id={id} client={client} />)}</div> : null;
}
function VideoCard({ id, client }: { id: string; client: WorkbenchClient }): React.JSX.Element {
  const [video, setVideo] = useState<Record<string, unknown>>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const until = Date.now() + 20 * 60_000;
    async function refresh(): Promise<void> {
      try {
        const result = await client.storyVideo(id, controller.signal);
        if (controller.signal.aborted) return;
        setVideo(result); setError("");
        if (!["SUCCEEDED", "FAILED", "CANCELLED"].includes(String(result.status)) && Date.now() < until) timer = setTimeout(() => { void refresh(); }, 8000);
      } catch { if (!controller.signal.aborted) setError("暂时无法更新视频状态，请刷新查看原任务。"); }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [id, client, revision]);
  const url = video?.status === "SUCCEEDED" ? safeUrl(video.output_url) : undefined;
  const status = String(video?.status ?? "");
  const labels: Record<string, string> = { PENDING: "等待生成", SUBMITTING: "正在提交", QUEUED: "排队中", RUNNING: "视频生成中", FAILED: "视频生成失败", CANCELLED: "视频生成已取消" };
  return <section className="story-video-card" aria-label="视频生成结果">
    {url && <><span className="sr-only" role="status">视频已完成，可以播放。</span>
      <video className="story-video-player" controls preload="metadata" src={url}>你的浏览器不支持视频播放。</video></>}
    {!url && <p className="story-video-status" role="status"><span>{labels[status] ?? "正在查询视频任务"}</span>
      <button type="button" onClick={() => setRevision(v => v+1)}>刷新状态</button></p>}
    {error && <p className="story-video-error" role="status">{error}</p>}
    {status === "FAILED" && <p className="story-video-error">{typeof video?.error_message === "string" ? video.error_message : "生成未完成，请在 Story 查看详情。"}</p>}
  </section>;
}
