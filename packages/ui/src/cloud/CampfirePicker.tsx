import { useEffect, useRef, useState } from "react";
import type { WorkbenchClient } from "./client.js";
import { campfireList, mergeCampfireAssets, campfireUpload, type CampfireAsset, type CampfireSelection } from "./campfire-client.js";

export function CampfirePicker({ client, onSelect, onClose }: { client: WorkbenchClient; onSelect: (selection: CampfireSelection) => void; onClose: () => void }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null); const input = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<CampfireAsset[]>([]); const [shopId, setShopId] = useState(""); const [referenceId, setReferenceId] = useState("");
  const [shopCursor, setShopCursor] = useState<string | null>(null); const [referenceCursor, setReferenceCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [loadingShops, setLoadingShops] = useState(true); const [loadingReferences, setLoadingReferences] = useState(true);
  const [reload, setReload] = useState(0); const [progress, setProgress] = useState<number>(); const [error, setError] = useState("");
  useEffect(() => {
    const previous = document.activeElement; dialog.current?.showModal();
    return () => { dialog.current?.close(); if (previous instanceof HTMLElement) previous.focus(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController(); setError(""); setLoadingShops(true); setLoadingReferences(true);
    async function load(filterRole: "shop_profile" | "reference_video"): Promise<void> {
      try {
        const page = await campfireList(client, { filterRole }, controller.signal);
        if (controller.signal.aborted) return;
        setItems(current => mergeCampfireAssets(current, page.items));
        if (filterRole === "shop_profile") setShopCursor(page.nextCursor); else setReferenceCursor(page.nextCursor);
      } catch (cause) { if (!controller.signal.aborted) setError(current => [current, cause instanceof Error ? cause.message : "素材读取失败。"].filter(Boolean).join(" ")); }
      finally { if (!controller.signal.aborted) { if (filterRole === "shop_profile") setLoadingShops(false); else setLoadingReferences(false); } }
    }
    void load("shop_profile"); void load("reference_video");
    return () => controller.abort();
  }, [client, reload]);
  const shops = items.filter(item => item.role === "shop_profile"); const references = items.filter(item => item.role === "reference_video");
  async function loadMore(filterRole: "shop_profile" | "reference_video"): Promise<void> {
    const pageCursor = filterRole === "shop_profile" ? shopCursor : referenceCursor; if (!pageCursor || busy) return;
    setBusy(true); setError("");
    try {
      const data = await campfireList(client, { filterRole, pageCursor });
      setItems(current => mergeCampfireAssets(current, data.items));
      if (filterRole === "shop_profile") setShopCursor(data.nextCursor); else setReferenceCursor(data.nextCursor);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "更多素材加载失败。"); }
    finally { setBusy(false); }
  }
  async function upload(file: File): Promise<void> {
    setBusy(true); setProgress(0); setError("");
    try { const asset = await campfireUpload(client, file, "reference_video", undefined, setProgress); setItems(current => [asset, ...current]); setReferenceId(asset.id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "参考视频上传失败。"); }
    finally { setBusy(false); setProgress(undefined); }
  }
  return <dialog ref={dialog} className="asset-dialog" aria-label="选择营火能力与参考视频" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="asset-toolbar"><h2>营火 · 实拍剪辑</h2><button type="button" disabled={busy} onClick={onClose}>关闭</button></header>
    <div className="asset-form">
      <label>店铺<select aria-label="选择营火店铺" value={shopId} disabled={busy || loadingShops} onChange={event => setShopId(event.target.value)}><option value="">{loadingShops ? "正在加载店铺…" : "选择店铺资料"}</option>{shops.map(shop => <option key={shop.id} value={shop.id}>{shop.title}</option>)}</select></label>
      {shopCursor && <button type="button" disabled={busy} onClick={() => { void loadMore("shop_profile"); }}>加载更多店铺</button>}
      {!loadingShops && !shops.length && !error && <p>请先在素材库添加店铺资料与实拍素材。</p>}
      <label>参考视频<select aria-label="选择营火参考视频" value={referenceId} disabled={busy || loadingReferences} onChange={event => setReferenceId(event.target.value)}><option value="">{loadingReferences ? "正在加载参考视频…" : "不使用参考视频"}</option>{references.map(reference => <option key={reference.id} value={reference.id}>{reference.title}</option>)}</select></label>
      {referenceCursor && <button type="button" disabled={busy} onClick={() => { void loadMore("reference_video"); }}>加载更多参考视频</button>}
      <input ref={input} className="composer-file-input" type="file" accept="video/mp4" aria-label="上传营火参考视频" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file); }} />
      <button type="button" disabled={busy} onClick={() => input.current?.click()}>{progress === undefined ? "上传参考视频" : `上传中 ${progress}%`}</button>
      {(loadingShops || loadingReferences) && <p role="status">正在读取素材，可上传参考视频或关闭窗口。</p>}
      {error && <><p role="alert">{error}</p><button type="button" disabled={busy || loadingShops || loadingReferences} onClick={() => setReload(current => current + 1)}>重新加载素材</button></>}
      <button type="button" className="primary" disabled={busy || !shopId} onClick={() => { const shop = shops.find(item => item.id === shopId); const reference = references.find(item => item.id === referenceId); if (shop) onSelect({ shopId, shopTitle: shop.title, ...(reference ? { referenceId: reference.id, referenceTitle: reference.title } : {}) }); }}>使用营火能力</button>
    </div>
  </dialog>;
}
