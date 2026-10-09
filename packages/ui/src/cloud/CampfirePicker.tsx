import { useEffect, useRef, useState } from "react";
import type { WorkbenchClient } from "./client.js";
import { campfireList, campfireUpload, type CampfireAsset, type CampfireSelection } from "./campfire-client.js";

export function CampfirePicker({ client, onSelect, onClose }: { client: WorkbenchClient; onSelect: (selection: CampfireSelection) => void; onClose: () => void }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null); const input = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<CampfireAsset[]>([]); const [shopId, setShopId] = useState(""); const [referenceId, setReferenceId] = useState("");
  const [busy, setBusy] = useState(true); const [progress, setProgress] = useState<number>(); const [error, setError] = useState("");
  useEffect(() => {
    const previous = document.activeElement; let mounted = true; dialog.current?.showModal();
    void campfireList(client).then(data => { if (mounted) setItems(data.items); }).catch(cause => { if (mounted) setError(cause instanceof Error ? cause.message : "素材读取失败。"); }).finally(() => { if (mounted) setBusy(false); });
    return () => { mounted = false; dialog.current?.close(); if (previous instanceof HTMLElement) previous.focus(); };
  }, [client]);
  const shops = items.filter(item => item.role === "shop_profile"); const references = items.filter(item => item.role === "reference_video");
  async function upload(file: File): Promise<void> {
    setBusy(true); setProgress(0); setError("");
    try { const asset = await campfireUpload(client, file, "reference_video", undefined, setProgress); setItems(current => [asset, ...current]); setReferenceId(asset.id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "参考视频上传失败。"); }
    finally { setBusy(false); setProgress(undefined); }
  }
  return <dialog ref={dialog} className="asset-dialog" aria-label="选择营火能力与参考视频" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="asset-toolbar"><h2>营火 · 实拍剪辑</h2><button type="button" disabled={busy} onClick={onClose}>关闭</button></header>
    <p>用本店实拍素材重剪，参考视频只用于镜头和节奏。缺镜头时先询问是否补充。</p>
    <div className="asset-form">
      <label>店铺<select aria-label="选择营火店铺" value={shopId} disabled={busy} onChange={event => setShopId(event.target.value)}><option value="">选择店铺资料</option>{shops.map(shop => <option key={shop.id} value={shop.id}>{shop.title}</option>)}</select></label>
      {!busy && !shops.length && <p>请先在素材库添加店铺资料与实拍素材。</p>}
      <label>参考视频<select aria-label="选择营火参考视频" value={referenceId} disabled={busy} onChange={event => setReferenceId(event.target.value)}><option value="">不使用参考视频</option>{references.map(reference => <option key={reference.id} value={reference.id}>{reference.title}</option>)}</select></label>
      <input ref={input} className="composer-file-input" type="file" accept="video/mp4" aria-label="上传营火参考视频" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file); }} />
      <button type="button" disabled={busy} onClick={() => input.current?.click()}>{progress === undefined ? "上传参考视频" : `上传中 ${progress}%`}</button>
      {error && <p role="alert">{error}</p>}
      <button type="button" className="primary" disabled={busy || !shopId} onClick={() => { const shop = shops.find(item => item.id === shopId); const reference = references.find(item => item.id === referenceId); if (shop) onSelect({ shopId, shopTitle: shop.title, ...(reference ? { referenceId: reference.id, referenceTitle: reference.title } : {}) }); }}>使用营火能力</button>
    </div>
  </dialog>;
}
