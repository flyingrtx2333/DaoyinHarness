import { useEffect, useRef, useState } from "react";
import type { AgentEvent } from "@daoyin/harness-protocol";
import type { WorkbenchClient } from "./client.js";
import { campfireAsset, campfireBlob, type CampfireAsset } from "./campfire-client.js";

function InlineCampfireVideo({ client, asset }: { client: WorkbenchClient; asset: CampfireAsset }): React.JSX.Element {
  const container = useRef<HTMLElement>(null);
  const [url, setUrl] = useState(""); const [error, setError] = useState(""); const [attempt, setAttempt] = useState(0);
  const scope = client.accountScope;
  useEffect(() => {
    const controller = new AbortController(); let objectUrl = ""; let started = false;
    setUrl(""); setError("");
    const load = (): void => {
      if (started || controller.signal.aborted) return;
      started = true;
      void campfireBlob(client, asset, controller.signal).then(blob => {
        if (controller.signal.aborted || client.accountScope !== scope) return;
        objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
      }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "成片读取失败，请重试。"); });
    };
    // Read immutable account media only when its player approaches the viewport.
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); load(); }
    }, { rootMargin: "200px" });
    if (container.current) observer.observe(container.current);
    return () => { observer.disconnect(); controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [client, scope, asset.id, asset.size, asset.mediaType, attempt]);
  return <section ref={container} className="campfire-result" aria-label={asset.title}>
    <video src={url || undefined} controls playsInline preload="metadata" aria-label={asset.title} />
    {!url && !error && <p role="status">正在读取成片…</p>}
    {error && <><p role="alert">{error}</p><button type="button" onClick={() => setAttempt(value => value + 1)}>重新读取成片</button></>}
    <div className="asset-control"><span>{asset.title}</span>{url && <a href={url} download={asset.title.endsWith(".mp4") ? asset.title : asset.title + ".mp4"}>下载成片</a>}</div>
    {!!asset.generatedSegments?.length && <p className="asset-library-note">此历史成片包含 AI 演绎片段，画面内已标记来源。</p>}
  </section>;
}

export function CampfireResults({ client, events, runId }: { client: WorkbenchClient; events: AgentEvent[]; runId: string }): React.JSX.Element | null {
  const assets = new Map<string, CampfireAsset>();
  for (const event of events) {
    if (event.turnId !== runId || event.type !== "tool.completed" || event.payload.toolName !== "resource_campfire_render") continue;
    const result = event.payload.evidence.result;
    if (!result || typeof result !== "object" || Array.isArray(result) || !("asset" in result)) continue;
    try { const asset = campfireAsset(result.asset); if (asset.role === "output_video" && asset.mediaType === "video/mp4") assets.set(asset.id, asset); } catch { /* Only validated, persisted render receipts produce a preview. */ }
  }
  if (!assets.size) return null;
  return <div className="campfire-results">{[...assets.values()].map(asset => <InlineCampfireVideo key={`${client.accountScope}:${asset.id}`} client={client} asset={asset} />)}</div>;
}
