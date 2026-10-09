import { useEffect, useRef, useState } from "react";
import type { WorkbenchClient } from "./client.js";
import { CAMPFIRE_LABELS, campfireBlob, campfireList, campfireProfile, campfireUpload, type CampfireAsset, type CampfireRole } from "./campfire-client.js";

export function CampfireLibrary({ client, ready }: { client: WorkbenchClient; ready: boolean }): React.JSX.Element {
  const [items, setItems] = useState<CampfireAsset[]>([]);
  const [shopId, setShopId] = useState("");
  const [role, setRole] = useState<Exclude<CampfireRole, "shop_profile" | "output_video">>("shop_video");
  const [title, setTitle] = useState(""); const [content, setContent] = useState("");
  const [showProfile, setShowProfile] = useState(false);
  const [busy, setBusy] = useState(false); const [progress, setProgress] = useState<number>(); const [error, setError] = useState(""); const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState<CampfireAsset>(); const fileInput = useRef<HTMLInputElement>(null);
  const scope = client.accountScope;
  async function refresh(): Promise<void> {
    setBusy(true); setError("");
    try { const data = await campfireList(client); if (client.accountScope === scope) { setItems(data.items); setHasMore(data.hasMore); } }
    catch (cause) { setError(cause instanceof Error ? cause.message : "素材加载失败。"); }
    finally { setBusy(false); }
  }
  useEffect(() => { if (ready) void refresh(); }, [client, ready, scope]);
  async function saveProfile(event: React.FormEvent): Promise<void> {
    event.preventDefault(); if (!title.trim() || !content.trim() || busy) return; setBusy(true); setError("");
    try {
      const asset = await campfireProfile(client, title.trim(), content.trim());
      if (scope !== client.accountScope) return;
      setItems(current => [asset, ...current]); setShopId(asset.id); setTitle(""); setContent(""); setShowProfile(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "店铺资料未保存。"); }
    finally { setBusy(false); }
  }
  async function upload(files: File[]): Promise<void> {
    setBusy(true); setError("");
    try {
      for (const file of files.slice(0, 5)) {
        setProgress(0);
        const asset = await campfireUpload(client, file, role, role === "reference_video" ? undefined : shopId, setProgress);
        if (scope !== client.accountScope) return;
        setItems(current => [asset, ...current]);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "素材未完成上传。"); }
    finally { setBusy(false); setProgress(undefined); }
  }
  const shops = items.filter(item => item.role === "shop_profile");
  return <section className="campfire-library" aria-label="营火素材库">
    <header className="asset-toolbar"><h2>营火素材</h2><button type="button" disabled={!ready || busy} onClick={() => setShowProfile(value => !value)}>添加店铺资料</button><button type="button" disabled={!ready || busy} onClick={() => { void refresh(); }}>刷新营火素材</button></header>
    <p className="asset-library-note">保存本店资料与实拍素材。参考视频只用于镜头和节奏分析；成片优先使用本店素材，缺镜头时先询问。</p>
    {showProfile && <form className="asset-form" onSubmit={event => { void saveProfile(event); }}>
      <label>店铺名称<input value={title} onChange={event => setTitle(event.target.value)} maxLength={120} required disabled={busy} /></label>
      <label>店铺资料<textarea value={content} onChange={event => setContent(event.target.value)} maxLength={10000} rows={5} required disabled={busy} placeholder="填写真实商品、特色、地址和可用的宣传信息；不确定的信息请留空。" /></label>
      <button type="submit" disabled={busy}>保存店铺资料</button>
    </form>}
    <div className="asset-toolbar">
      <label className="asset-control">店铺<select aria-label="营火素材所属店铺" value={shopId} onChange={event => setShopId(event.target.value)} disabled={busy}><option value="">选择店铺</option>{shops.map(shop => <option key={shop.id} value={shop.id}>{shop.title}</option>)}</select></label>
      <label className="asset-control">用途<select aria-label="营火素材用途" value={role} onChange={event => setRole(event.target.value as typeof role)} disabled={busy}>{(["shop_image", "shop_video", "shop_document", "reference_video"] as const).map(key => <option key={key} value={key}>{CAMPFIRE_LABELS[key]}</option>)}</select></label>
      <input ref={fileInput} className="composer-file-input" aria-label="上传营火素材" type="file" multiple disabled={busy || !ready || !shopId && role !== "reference_video"}
        accept={role === "shop_image" ? "image/jpeg,image/png,image/webp" : role === "shop_document" ? ".txt,.md" : "video/mp4"}
        onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ""; void upload(files); }} />
      <button type="button" disabled={busy || !ready || !shopId && role !== "reference_video"} onClick={() => fileInput.current?.click()}>{progress === undefined ? "上传素材" : `上传中 ${progress}%`}</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {busy && progress === undefined && <p role="status">正在读取或保存营火素材…</p>}
    {!busy && !items.length && <p role="status">暂无营火素材。先添加店铺资料，再上传实拍图片、视频或参考视频。</p>}
    <div className="asset-grid">{items.filter(item => !shopId || item.id === shopId || item.shopId === shopId || item.role === "reference_video").map(item => <article className="asset-item" key={item.id}>
      <button type="button" className="asset-preview" aria-label={`预览营火素材 ${item.title}`} onClick={() => setSelected(item)}><span className="asset-preview-fallback">{CAMPFIRE_LABELS[item.role]}</span></button>
      <div className="asset-meta"><h2>{item.title}</h2><p>{CAMPFIRE_LABELS[item.role]}{item.size ? ` · ${(item.size / 1024 / 1024).toFixed(1)} MB` : ""}</p></div>
    </article>)}</div>
    {hasMore && <p role="status">当前显示最近 100 项营火素材。</p>}
    {selected && <CampfirePreview client={client} asset={selected} onClose={() => setSelected(undefined)} />}
  </section>;
}

export function CampfirePreview({ client, asset, onClose }: { client: WorkbenchClient; asset: CampfireAsset; onClose: () => void }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null); const [url, setUrl] = useState(""); const [text, setText] = useState(""); const [error, setError] = useState("");
  useEffect(() => {
    const previous = document.activeElement; const controller = new AbortController(); let objectUrl = "";
    dialog.current?.showModal();
    void (async () => {
      if (asset.role === "shop_profile") {
        const result = await client.resource<{ asset: CampfireAsset }>({ action: "resource_campfire_inspect", resourceId: asset.id });
        if (!controller.signal.aborted) setText(result.asset.content ?? "");
      } else {
        const blob = await campfireBlob(client, asset, controller.signal);
        if (asset.mediaType === "text/plain") { const content = await blob.text(); if (!controller.signal.aborted) setText(content); }
        else if (!controller.signal.aborted) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); }
      }
    })().catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "素材无法预览。"); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); dialog.current?.close(); if (previous instanceof HTMLElement) previous.focus(); };
  }, [client, asset]);
  return <dialog ref={dialog} className="asset-dialog" aria-label={asset.title} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="asset-toolbar"><h2>{asset.title}</h2><button type="button" onClick={onClose}>关闭</button></header>
    {error ? <p role="alert">{error}</p> : url ? asset.mediaType === "video/mp4" ? <video src={url} controls playsInline preload="metadata" /> : <img src={url} alt={asset.title} /> : text ? <pre className="asset-document">{text}</pre> : <p role="status">正在读取素材…</p>}
    {url && <a href={url} download={asset.title + (asset.mediaType === "video/mp4" && !asset.title.endsWith(".mp4") ? ".mp4" : "")}>下载素材</a>}
  </dialog>;
}
