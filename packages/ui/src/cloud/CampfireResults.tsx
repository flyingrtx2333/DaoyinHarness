import { useState } from "react";
import type { AgentEvent } from "@daoyin/harness-protocol";
import type { WorkbenchClient } from "./client.js";
import { campfireAsset, type CampfireAsset } from "./campfire-client.js";
import { CampfirePreview } from "./CampfireLibrary.js";

export function CampfireResults({ client, events, runId }: { client: WorkbenchClient; events: AgentEvent[]; runId: string }): React.JSX.Element | null {
  const [selected, setSelected] = useState<CampfireAsset>(); const assets = new Map<string, CampfireAsset>();
  for (const event of events) {
    if (event.turnId !== runId || event.type !== "tool.completed" || event.payload.toolName !== "resource_campfire_render") continue;
    const result = event.payload.evidence.result;
    if (!result || typeof result !== "object" || Array.isArray(result) || !("asset" in result)) continue;
    try { const asset = campfireAsset(result.asset); if (asset.role === "output_video") assets.set(asset.id, asset); } catch { /* Only validated, persisted render receipts produce a preview. */ }
  }
  if (!assets.size) return null;
  return <div className="campfire-results">{[...assets.values()].map(asset => <button key={asset.id} type="button" onClick={() => setSelected(asset)}>预览成片 · {asset.title}</button>)}{selected && <CampfirePreview client={client} asset={selected} onClose={() => setSelected(undefined)} />}</div>;
}
