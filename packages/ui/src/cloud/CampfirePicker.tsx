import { useEffect, useRef, useState } from "react";
import { CampfireThumbnail, CampfirePreview } from "./CampfireLibrary.js";
import { CampfireShopManager } from "./CampfireShopManager.js";
import { WorkbenchIcon } from "./WorkbenchIcon.js";
import type { WorkbenchClient } from "./client.js";
import { campfireList, mergeCampfireAssets, campfireUpload, type CampfireAsset, type CampfireSelection } from "./campfire-client.js";

export function CampfirePicker({ client, initialSelection, initialRequirements, onSelect, onClose }: { client: WorkbenchClient; initialSelection?: CampfireSelection; initialRequirements: string; onSelect: (selection: CampfireSelection) => void; onClose: () => void }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null); const input = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<CampfireAsset[]>([]); const [shopId, setShopId] = useState(initialSelection?.shopId ?? ""); const [referenceId, setReferenceId] = useState(initialSelection?.referenceId ?? "");
  const [managerOpen, setManagerOpen] = useState(false);
  const [requirements, setRequirements] = useState(initialRequirements); const [preview, setPreview] = useState<CampfireAsset>();
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
  const systemReferences = references.filter(item => item.systemPreset);
  const uploadedReferences = references.filter(item => !item.systemPreset);
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
  const selectedReference = references.find(item => item.id === referenceId);
  const selectedShop = shops.find(item => item.id === shopId);
  return <>
    <dialog ref={dialog} className="asset-dialog campfire-picker" aria-label="选择营火能力与参考视频" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
      <header className="asset-toolbar campfire-picker-header"><h2>营火 · 实拍剪辑</h2><button type="button" className="campfire-picker-close" aria-label="关闭营火弹窗" disabled={busy} onClick={onClose}>×</button></header>
      <div className="campfire-picker-body">
        <div className="asset-form campfire-picker-form">
          <label>店铺<select aria-label="选择营火店铺" value={shopId} disabled={busy || loadingShops} onChange={event => setShopId(event.target.value)}><option value="">{loadingShops ? "正在加载店铺…" : "选择店铺资料"}</option>{shops.map(shop => <option key={shop.id} value={shop.id}>{shop.title}</option>)}</select></label>
          <button type="button" disabled={busy} onClick={() => setManagerOpen(true)}>管理店铺</button>
          {shopCursor && <button type="button" disabled={busy} onClick={() => { void loadMore("shop_profile"); }}>加载更多店铺</button>}
          {!loadingShops && !shops.length && !error && <p>点击管理店铺，添加店铺资料。</p>}
          <label>制作要求<textarea aria-label="制作要求" rows={6} maxLength={2000} value={requirements} disabled={busy} placeholder="描述想要的风格、时长和重点…" onChange={event => setRequirements(event.target.value)} /><span className="campfire-requirements-count">{requirements.length}/2000</span></label>
          <label className="campfire-no-reference"><input type="radio" name="campfire-reference-mode" checked={!referenceId} disabled={busy} onChange={event => { if (event.target.checked) setReferenceId(""); }} />不使用参考视频</label>
        </div>
        <section className="campfire-reference-library" aria-label="参考视频库">
          <header className="asset-toolbar"><h3>参考视频</h3><button type="button" className="campfire-reference-upload" disabled={busy} onClick={() => input.current?.click()}><WorkbenchIcon name="upload" />{progress === undefined ? "上传参考视频" : `上传中 ${progress}%`}</button></header>
          <input ref={input} className="composer-file-input" tabIndex={-1} type="file" accept="video/mp4" aria-label="上传营火参考视频" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file); }} />
          {loadingReferences && <p role="status">正在读取参考视频…</p>}
          {!loadingReferences && !references.length && !error && <p className="campfire-reference-empty">暂无可用参考视频，请重新加载。</p>}
          {[{title:"系统预设",items:systemReferences},{title:"我上传的",items:uploadedReferences}].filter(group=>group.items.length).map(group=><section key={group.title} aria-label={group.title}><h3>{group.title}</h3>
          <div className="campfire-reference-masonry">
            {group.items.map(reference => <article key={reference.id} className={`campfire-reference-card${reference.id === referenceId ? " is-selected" : ""}`}>
              <button type="button" className="campfire-reference-preview" aria-label={`预览参考视频：${reference.title}`} onClick={() => setPreview(reference)}><CampfireThumbnail client={client} asset={reference} /></button>
              <button type="button" className="campfire-reference-select" aria-label={`选择参考视频：${reference.title}`} aria-pressed={reference.id === referenceId} disabled={busy} onClick={() => setReferenceId(current => current === reference.id ? "" : reference.id)}><span aria-hidden="true">{reference.id === referenceId ? "✓" : ""}</span></button>
              <div className="campfire-reference-caption"><span title={reference.title}>{reference.title.replace(/\.mp4$/iu, "")}</span>{typeof reference.durationSeconds === "number" && <small>{Math.round(reference.durationSeconds)}秒</small>}</div>
            </article>)}
          </div>
          </section>)}
          {referenceCursor && <button type="button" disabled={busy} onClick={() => { void loadMore("reference_video"); }}>加载更多参考视频</button>}
        </section>
      </div>
      {loadingShops && <p role="status">正在读取店铺…</p>}
      {error && <div className="campfire-picker-error"><p role="alert">{error}</p><button type="button" disabled={busy || loadingShops || loadingReferences} onClick={() => setReload(current => current + 1)}>重新加载素材</button></div>}
      <footer className="campfire-picker-footer"><div className="campfire-picked-summary" aria-live="polite">{selectedReference ? <><span>已选择 1 个参考视频</span><b title={selectedReference.title}>{selectedReference.title}</b><button type="button" aria-label="移除已选参考视频" disabled={busy} onClick={() => setReferenceId("")}>×</button></> : <span>不使用参考视频</span>}</div><button type="button" className="primary" disabled={busy || !selectedShop || !!referenceId && !selectedReference} onClick={() => { if (selectedShop) onSelect({ shopId, shopTitle: selectedShop.title, ...(selectedReference ? { referenceId: selectedReference.id, referenceTitle: selectedReference.title } : {}), ...(requirements.trim() ? { requirements: requirements.trim() } : {}) }); }}>使用营火能力</button></footer>
    </dialog>
    {managerOpen && <CampfireShopManager key={client.accountScope} client={client} initialShopId={shopId} onClose={() => setManagerOpen(false)} useLabel="使用此店铺" onChanged={asset => { setItems(current => mergeCampfireAssets([asset], current.filter(item => item.id !== asset.id))); }} onUse={asset => { setItems(current => mergeCampfireAssets([asset], current.filter(item => item.id !== asset.id))); setShopId(asset.id); setManagerOpen(false); }} />}
    {preview && <CampfirePreview client={client} asset={preview} onClose={() => setPreview(undefined)} />}
  </>;
}
