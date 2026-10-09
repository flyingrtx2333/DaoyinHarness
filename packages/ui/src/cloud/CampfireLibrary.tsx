import { Children, useEffect, useRef, useState } from "react";
import type { WorkbenchClient } from "./client.js";
import { CAMPFIRE_LABELS, campfireAssetLabel, campfireBlob, campfireList, campfireProfile, campfireReadProfile, mergeCampfireAssets, campfireUpload, type CampfireAsset, type CampfireRole } from "./campfire-client.js";

export function CampfireLibrary({ client, ready, refreshKey = 0, collection, mediaFilter, query, view, uploadRequest, onCountChange, children }: { client: WorkbenchClient; ready: boolean; refreshKey?: number; collection: "shop" | "generated"; mediaFilter: "all" | "image" | "video"; query: string; view: "masonry" | "list"; uploadRequest: number; onCountChange: (count: number, more: boolean) => void; children?: React.ReactNode }): React.JSX.Element {
  const [showUpload, setShowUpload] = useState(false);
  const lastUploadRequest = useRef(uploadRequest);
  useEffect(() => { if (uploadRequest !== lastUploadRequest.current) { lastUploadRequest.current = uploadRequest; setShowUpload(true); } }, [uploadRequest]);
  const [items, setItems] = useState<CampfireAsset[]>([]);
  const [shopId, setShopId] = useState("");
  const [role, setRole] = useState<Exclude<CampfireRole, "shop_profile" | "output_video">>("shop_video");
  const [title, setTitle] = useState(""); const [content, setContent] = useState("");
  const [showProfile, setShowProfile] = useState(false); const [editing, setEditing] = useState<CampfireAsset>();
  const [shops, setShops] = useState<CampfireAsset[]>([]); const [shopCursor, setShopCursor] = useState<string | null>(null); const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [progress, setProgress] = useState<number>(); const [error, setError] = useState("");
  const [selected, setSelected] = useState<CampfireAsset>(); const fileInput = useRef<HTMLInputElement>(null);
  const scope = client.accountScope; const loadGeneration = useRef(0);
  const visibleItems = items.filter(item => (collection === "generated" ? item.role === "output_video" : item.role !== "output_video") && (mediaFilter === "all" || mediaFilter === "image" && item.mediaType.startsWith("image/") || mediaFilter === "video" && item.mediaType === "video/mp4") && item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a, b) => Number(!(a.mediaType.startsWith("image/") || a.mediaType === "video/mp4")) - Number(!(b.mediaType.startsWith("image/") || b.mediaType === "video/mp4")));
  useEffect(() => { onCountChange(visibleItems.length, !!nextCursor); }, [visibleItems.length, nextCursor, onCountChange]);
  async function refresh(): Promise<void> {
    const generation = ++loadGeneration.current; setBusy(true); setError("");
    try {
      const [data, profiles] = await Promise.all([campfireList(client, { limit: 100 }), campfireList(client, { filterRole: "shop_profile" })]);
      if (client.accountScope === scope && generation === loadGeneration.current) { setItems(data.items); setNextCursor(data.nextCursor); setShops(mergeCampfireAssets(profiles.items, data.items.filter(item => item.role === "shop_profile"))); setShopCursor(profiles.nextCursor); }
    } catch (cause) { if (scope === client.accountScope && generation === loadGeneration.current) setError(cause instanceof Error ? cause.message : "素材加载失败。"); }
    finally { if (scope === client.accountScope && generation === loadGeneration.current) setBusy(false); }
  }
  async function loadMore(profiles = false): Promise<void> {
    const cursor = profiles ? shopCursor : nextCursor; if (!cursor || busy) return;
    setBusy(true); setError("");
    try {
      const data = await campfireList(client, { limit: 100, pageCursor: cursor, ...(profiles ? { filterRole: "shop_profile" as const } : {}) });
      if (scope !== client.accountScope) return;
      if (profiles) { setShops(current => mergeCampfireAssets(current, data.items)); setShopCursor(data.nextCursor); }
      else { setItems(current => mergeCampfireAssets(current, data.items)); setNextCursor(data.nextCursor); }
    } catch (cause) { if (scope === client.accountScope) setError(cause instanceof Error ? cause.message : "更多素材未能加载。"); }
    finally { if (scope === client.accountScope) setBusy(false); }
  }
  useEffect(() => { if (ready) void refresh(); }, [client, ready, scope, refreshKey]);
  useEffect(() => { setItems([]); setShops([]); setShopId(""); setSelected(undefined); setEditing(undefined); setShowProfile(false); setTitle(""); setContent(""); }, [scope]);
  async function editProfile(asset: CampfireAsset): Promise<void> {
    setBusy(true); setError("");
    try { const latest = await campfireReadProfile(client, asset.id); if (scope !== client.accountScope) return; setEditing(latest); setTitle(latest.title); setContent(latest.content ?? ""); setShowProfile(true); setShowUpload(true); }
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
    {showUpload && <UploadDialog busy={busy} onClose={() => { setShowUpload(false); setShowProfile(false); }}>
    {showProfile && <form className="asset-form" onSubmit={event => { void saveProfile(event); }}>
      <label>店铺名称<input value={title} onChange={event => setTitle(event.target.value)} maxLength={120} required disabled={busy} /></label>
      <label>店铺资料<textarea value={content} onChange={event => setContent(event.target.value)} maxLength={10000} rows={5} required disabled={busy} placeholder="地址、特色、商品与宣传信息" /></label>
      <button type="submit" disabled={busy}>{editing ? "保存资料修改" : "保存店铺资料"}</button><button type="button" disabled={busy} onClick={() => { setShowProfile(false); setEditing(undefined); setTitle(""); setContent(""); }}>取消编辑</button>
    </form>}
    <div className="asset-upload-controls">
      <label className="asset-control">店铺<select aria-label="营火素材所属店铺" value={shopId} onChange={event => setShopId(event.target.value)} disabled={busy}><option value="">全部店铺</option>{shops.map(shop => <option key={shop.id} value={shop.id}>{shop.title}</option>)}</select></label>
      <button type="button" disabled={!ready || busy} onClick={() => { setEditing(undefined); setTitle(""); setContent(""); setShowProfile(true); }}>添加店铺资料</button>
      {shopCursor && <button type="button" disabled={busy} onClick={() => { void loadMore(true); }}>加载更多店铺</button>}
      {shopId && <button type="button" disabled={busy || !ready} onClick={() => { const shop = shops.find(item => item.id === shopId); if (shop) void editProfile(shop); }}>修改当前店铺资料</button>}
      <label className="asset-control">上传类型<select aria-label="营火素材用途" value={role} onChange={event => setRole(event.target.value as typeof role)} disabled={busy}>{(["shop_image", "shop_video", "shop_document", "reference_video", "narration_audio", "background_music"] as const).map(key => <option key={key} value={key}>{CAMPFIRE_LABELS[key]}</option>)}</select></label>
      <input ref={fileInput} className="composer-file-input" aria-label="上传营火素材" type="file" multiple disabled={busy || !ready || !shopId && role !== "reference_video"}
        accept={role === "shop_image" ? "image/jpeg,image/png,image/webp" : role === "shop_document" ? ".txt,.md" : role === "narration_audio" || role === "background_music" ? ".mp3,.wav,.m4a" : "video/mp4"}
        onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ""; void upload(files); }} />
      <button type="button" disabled={busy || !ready || !shopId && role !== "reference_video"} onClick={() => fileInput.current?.click()}>{progress === undefined ? "选择文件" : `上传中 ${progress}%`}</button>
    </div>
    {error && <p role="alert">{error}</p>}
    </UploadDialog>}
    {error && !showUpload && <p role="alert">{error}</p>}
    {busy && progress === undefined && <p role="status">正在加载素材…</p>}
    {!busy && !visibleItems.length && !Children.toArray(children).length && <p role="status">暂无素材</p>}
    <div className={`asset-${view}`} aria-label={view === "masonry" ? "全部素材瀑布流" : "全部素材列表"}>{visibleItems.map(item => <article className={`asset-item${item.mediaType.startsWith("image/") || item.mediaType === "video/mp4" ? "" : " asset-text-item"}`} key={item.id}>
      <button type="button" className="asset-preview" aria-label={`预览营火素材 ${item.title}`} onClick={() => setSelected(item)}><CampfireThumbnail client={client} asset={item} /></button>
      <div className="asset-meta"><h2 title={item.title}>{item.title}</h2><p>{campfireAssetLabel(item)}{item.durationSeconds ? ` · ${Math.round(item.durationSeconds)}秒` : ""}</p>{item.role === "shop_profile" && <button type="button" disabled={busy || !ready} onClick={() => { void editProfile(item); }}>修改资料</button>}</div>
    </article>)}{children}</div>
    {nextCursor && <button type="button" disabled={busy} onClick={() => { void loadMore(); }}>加载更多素材</button>}
    {selected && <CampfirePreview client={client} asset={selected} onClose={() => setSelected(undefined)} />}
  </section>;
}

function UploadDialog({ busy, onClose, children }: { busy: boolean; onClose: () => void; children: React.ReactNode }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const previous = document.activeElement; const node = dialog.current; node?.showModal(); return () => { node?.close(); if (previous instanceof HTMLElement) previous.focus(); }; }, []);
  return <dialog ref={dialog} className="asset-dialog asset-upload-dialog" aria-label="上传素材" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}><header className="asset-toolbar"><h2>上传素材</h2><button type="button" disabled={busy} onClick={onClose}>关闭</button></header>{children}</dialog>;
}

function CampfireThumbnail({ client, asset }: { client: WorkbenchClient; asset: CampfireAsset }): React.JSX.Element {
  const element = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false); const [failed, setFailed] = useState(false);
  const [ratio, setRatio] = useState<number | undefined>(() => typeof asset.width === "number" && typeof asset.height === "number" && Number.isFinite(asset.width) && Number.isFinite(asset.height) && asset.width > 0 && asset.height > 0 ? asset.width / asset.height : undefined);
  useEffect(() => {
    const node = element.current; if (!node) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: "200px" });
    observer.observe(node); return () => observer.disconnect();
  }, []);
  const video = asset.mediaType === "video/mp4", image = asset.mediaType.startsWith("image/");
  return <div ref={element} className="asset-thumbnail" style={{ aspectRatio: ratio ?? 16 / 10 }}>
    {visible && !failed && (video || image) ? <img src={client.mediaUrl(asset.id, false, true)} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} onLoad={event => { const el = event.currentTarget; if (el.naturalWidth && el.naturalHeight) setRatio(el.naturalWidth / el.naturalHeight); }} />
      : <span className="asset-preview-fallback">{failed ? "预览暂不可用" : video || image ? CAMPFIRE_LABELS[asset.role] : asset.title}</span>}
    {video && <span className="asset-play" aria-hidden="true"><span /></span>}
  </div>;
}

export function CampfirePreview({ client, asset, onClose }: { client: WorkbenchClient; asset: CampfireAsset; onClose: () => void }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null); const [url, setUrl] = useState(""); const [text, setText] = useState(""); const [error, setError] = useState("");
  useEffect(() => {
    const previous = document.activeElement; const controller = new AbortController();
    dialog.current?.showModal();
    void (async () => {
      if (asset.role === "shop_profile") {
        const result = await client.resource<{ asset: CampfireAsset }>({ action: "resource_campfire_inspect", resourceId: asset.id });
        if (!controller.signal.aborted) setText(result.asset.content ?? "");
      } else {
        if (asset.mediaType !== "text/plain") { if (!controller.signal.aborted) setUrl(client.mediaUrl(asset.id)); return; }
        const blob = await campfireBlob(client, asset, controller.signal);
        const content = await blob.text(); if (!controller.signal.aborted) setText(content);
      }
    })().catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "素材无法预览。"); });
    return () => { controller.abort(); dialog.current?.close(); if (previous instanceof HTMLElement) previous.focus(); };
  }, [client, asset]);
  return <dialog ref={dialog} className="asset-dialog" aria-label={asset.title} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="asset-toolbar"><h2>{asset.title}</h2><button type="button" onClick={onClose}>关闭</button></header>
    {asset.origin === "ai" && <p>AI 演绎画面，不代表店铺真实现场。</p>}
    {!!asset.generatedSegments?.length && <p>此成片包含 AI 演绎片段，画面内已标记来源。</p>}
    {error ? <p role="alert">{error}</p> : url ? asset.mediaType === "video/mp4" ? <video src={url} controls playsInline preload="metadata" /> : asset.mediaType.startsWith("audio/") ? <audio src={url} controls preload="metadata" /> : <img src={url} alt={asset.title} /> : text ? <pre className="asset-document">{text}</pre> : <p role="status">正在读取素材…</p>}
    {url && <a href={client.mediaUrl(asset.id, true)} download={asset.title + (asset.mediaType === "video/mp4" && !asset.title.endsWith(".mp4") ? ".mp4" : "")}>下载素材</a>}
  </dialog>;
}
