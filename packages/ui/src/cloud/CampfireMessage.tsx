import { useEffect, useRef, useState } from "react";
import { CampfirePreview, CampfireThumbnail } from "./CampfireLibrary.js";
import { WorkbenchIcon } from "./WorkbenchIcon.js";
import { campfireAsset, type CampfireAsset } from "./campfire-client.js";
import type { CampfireMessageSelection } from "./campfire-message.js";
import type { WorkbenchClient } from "./client.js";

export function CampfireMessage({ client, selection }: { client: WorkbenchClient; selection: CampfireMessageSelection }): React.JSX.Element {
  const container = useRef<HTMLElement>(null); const [visible, setVisible] = useState(false);
  const [shop, setShop] = useState<CampfireAsset>(); const [reference, setReference] = useState<CampfireAsset>(); const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<CampfireAsset>();
  useEffect(() => {
    const node = container.current; if (!node) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: "100px" });
    observer.observe(node); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController(); const scope = client.accountScope; setLoading(true); setShop(undefined); setReference(undefined);
    async function read(id: string, role: "shop_profile" | "reference_video"): Promise<void> {
      try {
        const result = await client.resource<{ asset: unknown }>({ action: "resource_campfire_inspect", resourceId: id }, controller.signal);
        const asset = campfireAsset(result.asset);
        if (controller.signal.aborted || client.accountScope !== scope || asset.id !== id || asset.role !== role) return;
        if (role === "shop_profile") setShop(asset); else setReference(asset);
      } catch { /* Keep the persisted capability visible when a referenced resource is unavailable. */ }
    }
    void Promise.all([read(selection.shopId, "shop_profile"), ...(selection.referenceId ? [read(selection.referenceId, "reference_video")] : [])]).finally(() => { if (!controller.signal.aborted && client.accountScope === scope) setLoading(false); });
    return () => controller.abort();
  }, [client, client.accountScope, visible, selection.shopId, selection.referenceId]);
  return <>
    <section ref={container} className="campfire-message-card" aria-label="本轮使用的营火能力">
      <header><span className="campfire-message-icon"><WorkbenchIcon name="story" /></span><div><b>营火 · 实拍剪辑</b><small>使用本店素材</small></div><span className="campfire-message-badge">能力</span></header>
      <button type="button" className="campfire-message-shop" disabled={!shop} onClick={() => { if (shop) setPreview(shop); }}><span>店铺</span><b>{shop?.title ?? (loading ? "正在读取…" : "资料暂不可用")}</b></button>
      {selection.referenceId ? <button type="button" className="campfire-message-reference" aria-label={`预览本轮参考视频${reference ? `：${reference.title}` : ""}`} disabled={!reference} onClick={() => { if (reference) setPreview(reference); }}>
        <span className="campfire-message-thumbnail">{reference ? <CampfireThumbnail client={client} asset={reference} /> : <WorkbenchIcon name="story" />}</span><span className="campfire-message-reference-copy"><small>参考视频</small><b>{reference?.title ?? (loading ? "正在读取…" : "视频暂不可用")}</b></span>
      </button> : <span className="campfire-message-no-reference">未使用参考视频</span>}
    </section>
    {preview && <CampfirePreview client={client} asset={preview} onClose={() => setPreview(undefined)} />}
  </>;
}
