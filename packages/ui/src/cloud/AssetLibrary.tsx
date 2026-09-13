import { useEffect, useRef, useState } from "react";
import type { WorkbenchClient } from "./client.js";
import "./asset-library.css";

const categories = { all: "全部", character: "角色图", scene: "场景图", storyboard: "分镜图", video: "视频" };
type Category = keyof typeof categories;
export type Asset = { id: string; title: string; category: Category; mediaType: "image" | "video"; url?: string; previewUrl?: string; status: string; project: string; error: string; variants: Asset[] };
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function safeUrl(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  try { const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password ? u.href : undefined; } catch { return undefined; }
}
function firstSafeUrl(...values: unknown[]): string | undefined {
  for (const value of values) {
    const url = safeUrl(value);
    if (url) return url;
  }
  return undefined;
}
export function parseAsset(v: unknown, nested = false): Asset {
  if (!isRecord(v) || typeof v.id !== "string" || typeof v.title !== "string" ||
      typeof v.category !== "string" || !Object.hasOwn(categories,v.category) || !["image","video"].includes(String(v.media_type))) throw new Error("素材数据格式无效，请刷新重试。");
  const u = safeUrl(v.url);
  const previewUrl = firstSafeUrl(v.thumbnail_url, v.poster_url, v.preview_url, v.thumbnailUrl, v.posterUrl, v.previewUrl);
  return { id:v.id,title:v.title,category:v.category as Category,mediaType:v.media_type as Asset["mediaType"],
    ...(u ? {url:u} : {}),...(previewUrl ? {previewUrl} : {}),status:String(v.status || ""),project:typeof v.project_title === "string" ? v.project_title : "",
    error:typeof v.error_message === "string" ? v.error_message : "",
    variants:!nested && Array.isArray(v.variants) ? v.variants.map(item=>parseAsset(item,true)) : [] };
}
export function videoPreviewSource(url: string): string {
  const parsed = new URL(url);
  if (!parsed.hash) parsed.hash = "t=0.1";
  return parsed.href;
}
const statuses: Record<string,string> = {SUCCEEDED:"生成完成",DRAFT:"草稿",LOCKED:"已锁定",STALE:"已过期",FAILED:"失败",READY:"已就绪",APPROVED:"已确认",GENERATING:"生成中",REJECTED:"质检未通过",CHECKED:"质检通过",RUNNING:"处理中",PENDING:"等待处理",DONE:"已生成"};

export function AssetLibrary({client,ready,onConnect}:{client:WorkbenchClient;ready:boolean;onConnect:()=>void}):React.JSX.Element {
  const [category,setCategory] = useState<Category>("all");
  const [offset,setOffset] = useState(0);
  const [refresh,setRefresh] = useState(0);
  const [data,setData] = useState<{items:Asset[];total:number}>();
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const [selected,setSelected] = useState<Asset>();
  useEffect(()=>{
    const controller = new AbortController();
    if (!ready) return () => controller.abort();
    setBusy(true);setError("");setData(undefined);
    void client.storyAssets(category,offset,controller.signal).then(response=>{
      const result = isRecord(response.result) ? response.result : response;
      if (!Array.isArray(result.items) || typeof result.total !== "number") throw new Error("素材列表暂不可用，请刷新重试。");
      if (!controller.signal.aborted) setData({items:result.items.map(item=>parseAsset(item)),total:result.total});
    }).catch((cause:unknown)=>{if(!controller.signal.aborted)setError(cause instanceof Error ? cause.message : "素材加载失败。");})
      .finally(()=>{if(!controller.signal.aborted)setBusy(false);});
    return ()=>controller.abort();
  },[client,ready,category,offset,refresh]);
  return <section className="asset-library" aria-label="资产库">
    <header className="asset-toolbar"><h1>资产</h1><button type="button" disabled={!ready || busy} onClick={()=>setRefresh(v=>v+1)}>刷新</button></header>
    <div className="asset-filters" aria-label="资产分类">{(Object.keys(categories) as Category[]).map(key=><button key={key} type="button" aria-pressed={category===key}
      onClick={()=>{setCategory(key);setOffset(0);}}>{categories[key]}</button>)}</div>
    {!ready ? <div role="status"><p>请连接道引账号后查看资产。</p><button type="button" onClick={onConnect}>连接账号</button></div> : <>
      {busy && <p role="status">正在加载资产…</p>}
      {error && <p role="alert">{error} <button type="button" onClick={()=>setRefresh(v=>v+1)}>重试加载</button></p>}
      {!busy && data?.items.length===0 && <p role="status">暂无{category==="all" ? "资产" : categories[category]}。</p>}
      <div className="asset-grid">{data?.items.map(item=><article className="asset-item" key={item.id}>
        <button type="button" className="asset-preview" onClick={()=>setSelected(item)} aria-label={`预览 ${item.title}`}>
          <AssetThumbnail asset={item} />
        </button>
        <div className="asset-meta"><h2 title={item.title}>{item.title}</h2><p>{categories[item.category]} · {statuses[item.status] || item.status}</p>{item.variants.length>0 && <p>{item.variants.length} 个版本</p>}{item.project && <p className="asset-project">{item.project}</p>}</div>
      </article>)}</div>
      {data && <footer className="asset-pagination"><span role="status">共 {data.total} 项</span><button type="button" disabled={busy || offset===0} onClick={()=>setOffset(v=>Math.max(0,v-24))}>上一页</button>
        <button type="button" disabled={busy || offset+24>=data.total} onClick={()=>setOffset(v=>v+24)}>下一页</button></footer>}
    </>}
    {selected && <AssetPreview asset={selected} onClose={()=>setSelected(undefined)} />}
  </section>;
}

function AssetThumbnail({asset}:{asset:Asset}):React.JSX.Element {
  const [imageFailed,setImageFailed] = useState(false);
  const [videoFailed,setVideoFailed] = useState(false);
  if (asset.mediaType === "image") {
    return asset.url && !imageFailed
      ? <img src={asset.url} alt="" loading="lazy" onError={()=>setImageFailed(true)} />
      : <span className="asset-preview-fallback">预览不可用</span>;
  }
  return <>
    {asset.previewUrl && !imageFailed
      ? <img src={asset.previewUrl} alt="" loading="lazy" onError={()=>setImageFailed(true)} />
      : asset.url && !videoFailed
        ? <video src={videoPreviewSource(asset.url)} muted playsInline preload="metadata" aria-hidden="true" onError={()=>setVideoFailed(true)} />
        : <span className="asset-preview-fallback">视频预览不可用</span>}
    <span className="asset-play" aria-hidden="true"><span /></span>
  </>;
}

function AssetPreview({asset,onClose}:{asset:Asset;onClose:()=>void}):React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const [failed,setFailed] = useState(false);
  const [current,setCurrent] = useState(asset.variants[0] ?? asset);
  useEffect(()=>{const previous=document.activeElement;const el=dialog.current;el?.showModal();return()=>{el?.close();if(previous instanceof HTMLElement && previous.isConnected)previous.focus();};},[]);
  return <dialog ref={dialog} className="asset-dialog" aria-label={asset.title} onCancel={event=>{event.preventDefault();onClose();}}>
    <header className="asset-toolbar"><h2>{asset.title}</h2><button type="button" onClick={onClose} aria-label="关闭资产预览">关闭</button></header>
    {asset.variants.length>0 && <div className="asset-filters" aria-label="角色图片版本">{asset.variants.map((variant,index)=><button type="button" key={variant.id} aria-pressed={current.id===variant.id}
      onClick={()=>{setCurrent(variant);setFailed(false);}}>{variant.title} · {statuses[variant.status] || variant.status} · {index+1}</button>)}</div>}
    {!current.url || failed ? <p role="alert">此素材暂时无法预览，请稍后刷新。</p> : current.mediaType==="video"
      ? <video src={current.url} controls preload="metadata" onError={()=>setFailed(true)} />
      : <img key={current.id} src={current.url} alt={`${asset.title} · ${current.title}`} onError={()=>setFailed(true)} />}
    {current.error && <p role="status">未用于分镜：{current.error}</p>}
    {asset.mediaType==="video" && <p>生成状态不代表画面质检结果。</p>}
  </dialog>;
}
