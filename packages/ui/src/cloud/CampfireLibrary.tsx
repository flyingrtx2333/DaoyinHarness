import { Children, useEffect, useRef, useState } from "react";
import { CampfireShopManager } from "./CampfireShopManager.js";
import { AssetLoading } from "./AssetLoading.js";
import type { WorkbenchClient } from "./client.js";
import { CAMPFIRE_LABELS, campfireAssetLabel, campfireBlob, campfireMediaUrl, campfireList, mergeCampfireAssets, campfireUpload, type CampfireAsset, type CampfireRole } from "./campfire-client.js";

export function CampfireLibrary({ client, ready, externalLoading = false, refreshKey = 0, collection, mediaFilter, query, view, uploadRequest, manageRequest, onCountChange, children }: { client: WorkbenchClient; ready: boolean; externalLoading?: boolean; refreshKey?: number; collection: "shop" | "generated"; mediaFilter: "all" | "image" | "video"; query: string; view: "masonry" | "list"; uploadRequest: number; manageRequest: number; onCountChange: (count: number, more: boolean) => void; children?: React.ReactNode }): React.JSX.Element {
  const [showUpload, setShowUpload] = useState(false);
  const lastUploadRequest = useRef(uploadRequest);
  useEffect(() => { if (uploadRequest !== lastUploadRequest.current) { lastUploadRequest.current = uploadRequest; setShowUpload(true); } }, [uploadRequest]);
  const [items, setItems] = useState<CampfireAsset[]>([]);
  const [shopId, setShopId] = useState("");
  const [role, setRole] = useState<Exclude<CampfireRole, "shop_profile" | "output_video">>("shop_video");
  const [manager, setManager] = useState<string>();
  const lastManageRequest = useRef(manageRequest);
  useEffect(() => { if (manageRequest !== lastManageRequest.current) { lastManageRequest.current = manageRequest; setManager(shopId); } }, [manageRequest, shopId]);
  const [shops, setShops] = useState<CampfireAsset[]>([]); const [shopCursor, setShopCursor] = useState<string | null>(null); const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [progress, setProgress] = useState<number>(); const [error, setError] = useState("");
  const [selected, setSelected] = useState<CampfireAsset>(); const fileInput = useRef<HTMLInputElement>(null);
  const scope = client.accountScope; const loadGeneration = useRef(0);
  const loading = externalLoading || busy && progress === undefined;
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
  useEffect(() => { setItems([]); setShops([]); setShopId(""); setSelected(undefined); setManager(undefined); }, [scope]);
  useEffect(() => {
    if (!ready || !items.some(item=>item.analysisStatus === "queued" || item.analysisStatus === "running")) return;
    const controller = new AbortController(); let pending = false;
    const timer = setInterval(() => {
      if (pending) return; pending = true;
      void campfireList(client,{limit:100},controller.signal).then(data=>{
        if (!controller.signal.aborted && scope === client.accountScope) setItems(current=>mergeCampfireAssets(current,data.items));
      }).catch(()=>{ /* Keep the last known state; explicit refresh reports connection failures. */ }).finally(()=>{pending=false;});
    },3000);
    return ()=>{clearInterval(timer);controller.abort();};
  },[client,ready,scope,items.some(item=>item.analysisStatus === "queued" || item.analysisStatus === "running")]);
  async function analyze(asset: CampfireAsset): Promise<void> {
    try {
      const result = await client.resource<{asset:CampfireAsset}>({action:"resource_media_analyze",resourceId:asset.id});
      if(scope === client.accountScope) setItems(current=>mergeCampfireAssets(current,[result.asset]));
    } catch(cause) {if(scope === client.accountScope) setError(cause instanceof Error?cause.message:"解析未能开始。");}
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
    {showUpload && <UploadDialog busy={busy} onClose={() => { setShowUpload(false); }}>
    <div className="asset-upload-controls">
      <label className="asset-control">店铺<select aria-label="营火素材所属店铺" value={shopId} onChange={event => setShopId(event.target.value)} disabled={busy}><option value="">选择店铺</option>{shops.map(shop => <option key={shop.id} value={shop.id}>{shop.title}</option>)}</select></label>
      <button type="button" disabled={!ready || busy} onClick={() => setManager(shopId)}>管理店铺</button>
      {shopCursor && <button type="button" disabled={busy} onClick={() => { void loadMore(true); }}>加载更多店铺</button>}
      <label className="asset-control">上传类型<select aria-label="营火素材用途" value={role} onChange={event => setRole(event.target.value as typeof role)} disabled={busy}>{(["shop_image", "shop_video", "shop_document", "reference_video", "narration_audio", "background_music"] as const).map(key => <option key={key} value={key}>{CAMPFIRE_LABELS[key]}</option>)}</select></label>
      <input ref={fileInput} className="composer-file-input" aria-label="上传营火素材" type="file" multiple disabled={busy || !ready || !shopId && role !== "reference_video"}
        accept={role === "shop_image" ? "image/jpeg,image/png,image/webp" : role === "shop_document" ? ".txt,.md" : role === "narration_audio" || role === "background_music" ? ".mp3,.wav,.m4a" : "video/mp4"}
        onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ""; void upload(files); }} />
      <button type="button" disabled={busy || !ready || !shopId && role !== "reference_video"} onClick={() => fileInput.current?.click()}>{progress === undefined ? "选择文件" : `上传中 ${progress}%`}</button>
    </div>
    {error && <p role="alert">{error}</p>}
    </UploadDialog>}
    {error && !showUpload && <p role="alert">{error}</p>}
    <div aria-busy={loading}>
    {loading && <AssetLoading />}
    {!loading && !error && !visibleItems.length && !Children.toArray(children).length && <p role="status">暂无素材</p>}
    <div className={`asset-${view}`} hidden={loading} aria-label={view === "masonry" ? "全部素材瀑布流" : "全部素材列表"}>{visibleItems.map(item => <article className={`asset-item${item.mediaType.startsWith("image/") || item.mediaType === "video/mp4" ? "" : " asset-text-item"}`} key={item.id}>
      <button type="button" className="asset-preview" aria-label={`预览营火素材 ${item.title}`} onClick={() => setSelected(item)}><CampfireThumbnail client={client} asset={item} /></button>
      {["shop_image","shop_video","reference_video"].includes(item.role) && <div className={`asset-analysis asset-analysis-${item.analysisStatus ?? "pending"}`}>
        {!item.analysisStatus ? <button type="button" onClick={()=>{void analyze(item);}}>解析素材</button> : item.analysisStatus === "completed" ? `已识别 · ${item.analysis?.actions.length ?? 0} 个动作` : item.analysisStatus === "failed"
          ? <button type="button" title={item.message} onClick={()=>{void analyze(item);}}>解析失败 · 重试</button>
          : <><span className="spinner" aria-hidden="true" />{item.analysisStatus === "queued" ? "等待解析" : `解析中${item.analysisProgress ? ` ${item.analysisProgress}%` : ""}`}</>}
      </div>}
      <div className="asset-meta"><h2 title={item.title}>{item.title}</h2><p>{campfireAssetLabel(item)}{item.durationSeconds ? ` · ${Math.round(item.durationSeconds)}秒` : ""}</p>{item.role === "shop_profile" && <button type="button" disabled={busy || !ready} onClick={() => { setManager(item.id); }}>修改资料</button>}</div>
    </article>)}{children}</div>
    </div>
    {nextCursor && <button type="button" disabled={busy} onClick={() => { void loadMore(); }}>加载更多素材</button>}
    {manager !== undefined && <CampfireShopManager key={scope} client={client} initialShopId={manager} onClose={() => setManager(undefined)} useLabel="上传本店素材" onChanged={asset => { setItems(current => mergeCampfireAssets([asset], current.filter(item => item.id !== asset.id))); setShops(current => mergeCampfireAssets([asset], current.filter(item => item.id !== asset.id))); setShopId(asset.id); }} onUse={asset => { setShopId(asset.id); setShowUpload(true); setManager(undefined); }} />}
    {selected && <CampfirePreview client={client} asset={selected} onClose={() => setSelected(undefined)} />}
  </section>;
}

function UploadDialog({ busy, onClose, children }: { busy: boolean; onClose: () => void; children: React.ReactNode }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const previous = document.activeElement; const node = dialog.current; node?.showModal(); return () => { node?.close(); if (previous instanceof HTMLElement) previous.focus(); }; }, []);
  return <dialog ref={dialog} className="asset-dialog asset-upload-dialog" aria-label="上传素材" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}><header className="asset-toolbar"><h2>上传素材</h2><button type="button" disabled={busy} onClick={onClose}>关闭</button></header>{children}</dialog>;
}

export function CampfireThumbnail({ client, asset }: { client: WorkbenchClient; asset: CampfireAsset }): React.JSX.Element {
  const element = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false); const [failed, setFailed] = useState(false); const [directFailed, setDirectFailed] = useState(false);
  const [ratio, setRatio] = useState<number | undefined>(() => typeof asset.width === "number" && typeof asset.height === "number" && Number.isFinite(asset.width) && Number.isFinite(asset.height) && asset.width > 0 && asset.height > 0 ? asset.width / asset.height : undefined);
  useEffect(() => {
    const node = element.current; if (!node) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: "200px" });
    observer.observe(node); return () => observer.disconnect();
  }, []);
  const video = asset.mediaType === "video/mp4", image = asset.mediaType.startsWith("image/");
  const nativePoster = client.mediaUrl(asset.id,false,true);
  const posterUrl = directFailed ? nativePoster : campfireMediaUrl(client,asset,true);
  return <div ref={element} className="asset-thumbnail" style={{ aspectRatio: ratio ?? 16 / 10 }}>
    {visible && !failed && (video || image) ? <img src={posterUrl} alt="" referrerPolicy="no-referrer" loading="lazy" decoding="async" onError={() => { if (posterUrl !== nativePoster) setDirectFailed(true); else setFailed(true); }} onLoad={event => { const el = event.currentTarget; if (el.naturalWidth && el.naturalHeight) setRatio(el.naturalWidth / el.naturalHeight); }} />
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
        if (asset.mediaType !== "text/plain") { if (!controller.signal.aborted) setUrl(campfireMediaUrl(client,asset)); return; }
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
    {error ? <p role="alert">{error}</p> : url ? asset.mediaType === "video/mp4" ? <video src={url} controls playsInline preload="metadata" poster={campfireMediaUrl(client,asset,true)} onError={() => { const native=client.mediaUrl(asset.id); if(url!==native)setUrl(native); else setError("视频暂不可用，请稍后重试。"); }} /> : asset.mediaType.startsWith("audio/") ? <audio src={url} controls preload="metadata" /> : <img src={url} alt={asset.title} /> : text ? <pre className="asset-document">{text}</pre> : <p role="status">正在读取素材…</p>}
    {url && <a href={client.mediaUrl(asset.id, true)} download={asset.title + (asset.mediaType === "video/mp4" && !asset.title.endsWith(".mp4") ? ".mp4" : "")}>下载素材</a>}
  </dialog>;
}
