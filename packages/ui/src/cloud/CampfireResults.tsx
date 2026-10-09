import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { AgentEvent } from "@daoyin/harness-protocol";
import type { WorkbenchClient } from "./client.js";
import { campfireAsset, type CampfireAsset } from "./campfire-client.js";

function InlineCampfireVideo({ client, asset }: { client: WorkbenchClient; asset: CampfireAsset }): React.JSX.Element {
  const container = useRef<HTMLElement>(null);
  const [url, setUrl] = useState(""); const [error, setError] = useState(""); const [attempt, setAttempt] = useState(0);
  const [ratio, setRatio] = useState(() => typeof asset.width === "number" && typeof asset.height === "number" && Number.isFinite(asset.width) && Number.isFinite(asset.height) && asset.width > 0 && asset.height > 0 ? asset.width / asset.height : 16 / 9);
  const scope = client.accountScope;
  useEffect(() => {
    setUrl(""); setError("");
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      try { setUrl(client.mediaUrl(asset.id)); }
      catch (cause) { setError(cause instanceof Error ? cause.message : "成片无法读取。"); }
    }, { rootMargin: "200px" });
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, [client, scope, asset.id, attempt]);
  return <section ref={container} className="campfire-result" aria-label={asset.title} style={{ "--campfire-video-ratio": ratio } as CSSProperties}>
    <video src={url || undefined} controls playsInline preload="metadata" aria-label={asset.title} onLoadedMetadata={event => { const video = event.currentTarget; if (video.videoWidth > 0 && video.videoHeight > 0) setRatio(video.videoWidth / video.videoHeight); }} onError={() => setError("成片读取未完成，请重试；若账号已变化，请重新登录。")} />
    {!url && !error && <p role="status">正在读取成片…</p>}
    {error && <><p role="alert">{error}</p><button type="button" onClick={() => setAttempt(value => value + 1)}>重新读取成片</button></>}
    <div className="asset-control"><span>{asset.title}</span>{url && <a href={client.mediaUrl(asset.id, true)} download={asset.title.endsWith(".mp4") ? asset.title : asset.title + ".mp4"}>下载成片</a>}</div>
    {!!asset.generatedSegments?.length && <p className="asset-library-note">此历史成片包含 AI 演绎片段，画面内已标记来源。</p>}
  </section>;
}

export function CampfireResults({ client, events, runId }: { client: WorkbenchClient; events: AgentEvent[]; runId: string }): React.JSX.Element | null {
  const assets = new Map<string, CampfireAsset>();
  for (const event of events) {
    if (event.turnId !== runId || event.type !== "tool.completed" || !["resource_campfire_render", "resource_campfire_inspect"].includes(String(event.payload.toolName))) continue;
    const result = event.payload.evidence.result;
    if (!result || typeof result !== "object" || Array.isArray(result) || !("asset" in result)) continue;
    try { const asset = campfireAsset(result.asset); if (asset.role === "output_video" && asset.mediaType === "video/mp4") assets.set(asset.id, asset); } catch { /* Only validated output manifests from successful tools produce a preview. */ }
  }
  if (!assets.size) return null;
  return <div className="campfire-results">{[...assets.values()].map(asset => <InlineCampfireVideo key={`${client.accountScope}:${asset.id}`} client={client} asset={asset} />)}</div>;
}
