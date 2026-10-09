import { useEffect, useRef, useState } from "react";
import type { WorkbenchClient } from "./client.js";
import { CAMPFIRE_LABELS, campfireBlob, campfireList, campfireProfile, campfireReadProfile, mergeCampfireAssets, campfireUpload, type CampfireAsset, type CampfireRole } from "./campfire-client.js";

export function CampfireLibrary({ client, ready }: { client: WorkbenchClient; ready: boolean }): React.JSX.Element {
  const [items, setItems] = useState<CampfireAsset[]>([]);
  const [shopId, setShopId] = useState("");
  const [role, setRole] = useState<Exclude<CampfireRole, "shop_profile" | "output_video">>("shop_video");
  const [title, setTitle] = useState(""); const [content, setContent] = useState("");
  const [showProfile, setShowProfile] = useState(false); const [editing, setEditing] = useState<CampfireAsset>();
  const [shops, setShops] = useState<CampfireAsset[]>([]); const [shopCursor, setShopCursor] = useState<string | null>(null); const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [progress, setProgress] = useState<number>(); const [error, setError] = useState("");
  const [selected, setSelected] = useState<CampfireAsset>(); const fileInput = useRef<HTMLInputElement>(null);
  const scope = client.accountScope; const loadGeneration = useRef(0);
  async function refresh(): Promise<void> {
    const generation = ++loadGeneration.current; setBusy(true); setError("");
    try {
      const [data, profiles] = await Promise.all([campfireList(client, { limit: 20, ...(shopId ? { shopId } : {}) }), campfireList(client, { filterRole: "shop_profile" })]);
      if (client.accountScope === scope && generation === loadGeneration.current) { setItems(data.items); setNextCursor(data.nextCursor); setShops(mergeCampfireAssets(profiles.items, data.items.filter(item => item.role === "shop_profile"))); setShopCursor(profiles.nextCursor); }
    } catch (cause) { if (scope === client.accountScope && generation === loadGeneration.current) setError(cause instanceof Error ? cause.message : "素材加载失败。"); }
    finally { if (scope === client.accountScope && generation === loadGeneration.current) setBusy(false); }
  }
  async function loadMore(profiles = false): Promise<void> {
    const cursor = profiles ? shopCursor : nextCursor; if (!cursor || busy) return;
    setBusy(true); setError("");
    try {
      const data = await campfireList(client, { limit: profiles ? 100 : 20, pageCursor: cursor, ...(profiles ? { filterRole: "shop_profile" as const } : shopId ? { shopId } : {}) });
      if (scope !== client.accountScope) return;
      if (profiles) { setShops(current => mergeCampfireAssets(current, data.items)); setShopCursor(data.nextCursor); }
      else { setItems(current => mergeCampfireAssets(current, data.items)); setNextCursor(data.nextCursor); }
    } catch (cause) { if (scope === client.accountScope) setError(cause instanceof Error ? cause.message : "更多素材未能加载。"); }
    finally { if (scope === client.accountScope) setBusy(false); }
  }
  useEffect(() => { if (ready) void refresh(); }, [client, ready, scope, shopId]);
  useEffect(() => { setItems([]); setShops([]); setShopId(""); setSelected(undefined); setEditing(undefined); setShowProfile(false); setTitle(""); setContent(""); }, [scope]);
  async function editProfile(asset: CampfireAsset): Promise<void> {
    setBusy(true); setError("");
    try { const latest = await campfireReadProfile(client, asset.id); if (scope !== client.accountScope) return; setEditing(latest); setTitle(latest.title); setContent(latest.content ?? ""); setShowProfile(true); }
    catch (cause) { if (scope === client.accountScope) setError(cause instanceof Error ? cause.message : "店铺资料读取失败。"); }
    finally { if (scope === client.accountScope) setBusy(false); }
  }
  async function saveProfile(event: React.FormEvent): Promise<void> {
    event.preventDefault(); if (!title.trim() || !content.trim() || busy) return; setBusy(true); setError("");
    try {
      const asset = await campfireProfile(client, title.trim(), content.trim(), editing);
      if (scope !== client.accountScope) return;
      setItems(current => mergeCampfireAssets([asset], current.filter(item => item.id !== asset.id))); setShops(current => mergeCampfireAssets([asset], current.filter(item => item.id !== asset.id))); setEditing(undefined); setShopId(asset.id); setTitle(""); setContent(""); setShowProfile(false);
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
  return <section className="campfire-library" aria-label="营火素材库">
    <header className="asset-toolbar"><h2>营火素材</h2><button type="button" disabled={!ready || busy} onClick={() => { setEditing(undefined); setTitle(""); setContent(""); setShowProfile(true); }}>添加店铺资料</button><button type="button" disabled={!ready || busy} onClick={() => { void refresh(); }}>刷新营火素材</button></header>
    <p className="asset-library-note">保存本店资料与实拍素材。参考视频只用于镜头和节奏分析；成片优先使用本店素材，缺镜头时先询问。</p>
    {showProfile && <form className="asset-form" onSubmit={event => { void saveProfile(event); }}>
      <label>店铺名称<input value={title} onChange={event => setTitle(event.target.value)} maxLength={120} required disabled={busy} /></label>
      <label>店铺资料<textarea value={content} onChange={event => setContent(event.target.value)} maxLength={10000} rows={5} required disabled={busy} placeholder="填写真实商品、特色、地址和可用的宣传信息；不确定的信息请留空。" /></label>
      <button type="submit" disabled={busy}>{editing ? "保存资料修改" : "保存店铺资料"}</button><button type="button" disabled={busy} onClick={() => { setShowProfile(false); setEditing(undefined); setTitle(""); setContent(""); }}>取消编辑</button>
    </form>}
    <div className="asset-toolbar">
      <label className="asset-control">店铺<select aria-label="营火素材所属店铺" value={shopId} onChange={event => setShopId(event.target.value)} disabled={busy}><option value="">选择店铺</option>{shops.map(shop => <option key={shop.id} value={shop.id}>{shop.title}</option>)}</select></label>
      {shopCursor && <button type="button" disabled={busy} onClick={() => { void loadMore(true); }}>加载更多店铺</button>}
      {shopId && <button type="button" disabled={busy || !ready} onClick={() => { const shop = shops.find(item => item.id === shopId); if (shop) void editProfile(shop); }}>修改当前店铺资料</button>}
      <label className="asset-control">用途<select aria-label="营火素材用途" value={role} onChange={event => setRole(event.target.value as typeof role)} disabled={busy}>{(["shop_image", "shop_video", "shop_document", "reference_video", "narration_audio", "background_music"] as const).map(key => <option key={key} value={key}>{CAMPFIRE_LABELS[key]}</option>)}</select></label>
      <input ref={fileInput} className="composer-file-input" aria-label="上传营火素材" type="file" multiple disabled={busy || !ready || !shopId && role !== "reference_video"}
        accept={role === "shop_image" ? "image/jpeg,image/png,image/webp" : role === "shop_document" ? ".txt,.md" : role === "narration_audio" || role === "background_music" ? ".mp3,.wav,.m4a" : "video/mp4"}
        onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ""; void upload(files); }} />
      <button type="button" disabled={busy || !ready || !shopId && role !== "reference_video"} onClick={() => fileInput.current?.click()}>{progress === undefined ? "上传素材" : `上传中 ${progress}%`}</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {busy && progress === undefined && <p role="status">正在读取或保存营火素材…</p>}
    {!busy && !items.length && <p role="status">暂无营火素材。先添加店铺资料，再上传实拍图片、视频或参考视频。</p>}
    <div className="asset-grid">{items.filter(item => !shopId || item.id === shopId || item.shopId === shopId || item.role === "reference_video").map(item => <article className="asset-item" key={item.id}>
      <button type="button" className="asset-preview" aria-label={`预览营火素材 ${item.title}`} onClick={() => setSelected(item)}><span className="asset-preview-fallback">{CAMPFIRE_LABELS[item.role]}</span></button>
      <div className="asset-meta"><h2>{item.title}</h2><p>{CAMPFIRE_LABELS[item.role]}{item.size ? ` · ${(item.size / 1024 / 1024).toFixed(1)} MB` : ""}</p>{item.role === "shop_profile" && <button type="button" disabled={busy || !ready} onClick={() => { void editProfile(item); }}>修改店铺资料</button>}</div>
    </article>)}</div>
    {nextCursor && <button type="button" disabled={busy} onClick={() => { void loadMore(); }}>加载更多营火素材</button>}
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
    {error ? <p role="alert">{error}</p> : url ? asset.mediaType === "video/mp4" ? <video src={url} controls playsInline preload="metadata" /> : asset.mediaType.startsWith("audio/") ? <audio src={url} controls preload="metadata" /> : <img src={url} alt={asset.title} /> : text ? <pre className="asset-document">{text}</pre> : <p role="status">正在读取素材…</p>}
    {url && <a href={url} download={asset.title + (asset.mediaType === "video/mp4" && !asset.title.endsWith(".mp4") ? ".mp4" : "")}>下载素材</a>}
  </dialog>;
}
