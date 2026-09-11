import { useEffect, useState } from "react";
import type { AgentEvent } from "@daoyin/harness-protocol";
import type { WorkbenchClient } from "./client.js";
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const safeUrl = (v: unknown): string | undefined => { try { const u = new URL(String(v)); return u.protocol === "https:" && !u.username && !u.password ? u.href : undefined; } catch { return undefined; } };
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
  const labels: Record<string, string> = { PENDING: "等待生成", SUBMITTING: "正在提交", QUEUED: "排队中", RUNNING: "视频生成中", SUCCEEDED: "视频已完成", FAILED: "视频生成失败" };
  return <section aria-label="视频任务">
    <p>{labels[String(video?.status)] ?? "正在查询视频任务"} <button type="button" onClick={() => setRevision(v => v+1)}>刷新状态</button></p>
    {error && <p role="status">{error}</p>}
    {video?.status === "FAILED" && <p>{typeof video.error_message === "string" ? video.error_message : "生成未完成，请在 Story 查看详情。"}</p>}
    {url && <><video controls preload="metadata" src={url} style={{ width: "100%", maxHeight: 480 }} /><a href={url} target="_blank" rel="noreferrer">打开视频</a></>}
  </section>;
}
