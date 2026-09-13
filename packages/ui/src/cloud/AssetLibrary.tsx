import { useEffect, useRef, useState } from "react";
import type { WorkbenchClient } from "./client.js";
import "./asset-library.css";

const categories = { all: "全部", character: "角色图", scene: "场景图", storyboard: "分镜图", video: "视频" };
type Category = keyof typeof categories;
type Asset = { id: string; title: string; category: Category; mediaType: "image" | "video"; url?: string; status: string; project: string };
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function safeUrl(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  try { const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password ? u.href : undefined; } catch { return undefined; }
}
function parse(v: unknown): Asset {
  if (!isRecord(v) || typeof v.id !== "string" || typeof v.title !== "string" ||
      typeof v.category !== "string" || !Object.hasOwn(categories,v.category) || !["image","video"].includes(String(v.media_type))) throw new Error("素材数据格式无效，请刷新重试。");
  const u = safeUrl(v.url);
  return { id:v.id,title:v.title,category:v.category as Category,mediaType:v.media_type as Asset["mediaType"],
    ...(u ? {url:u} : {}),status:String(v.status || ""),project:typeof v.project_title === "string" ? v.project_title : "" };
}
const statuses: Record<string,string> = {SUCCEEDED:"生成完成",DRAFT:"草稿",LOCKED:"已锁定",STALE:"已过期",FAILED:"失败",READY:"已就绪",APPROVED:"已确认",GENERATING:"生成中"};

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
      if (!controller.signal.aborted) setData({items:result.items.map(parse),total:result.total});
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
          {item.url && item.mediaType==="image" ? <img src={item.url} alt={item.title} loading="lazy" onError={event=>{event.currentTarget.hidden=true;}} /> : <span>{item.mediaType==="video" ? "▶ 视频" : "预览不可用"}</span>}
        </button>
        <h2>{item.title}</h2><p>{categories[item.category]} · {statuses[item.status] || item.status}</p>{item.project && <p>{item.project}</p>}
      </article>)}</div>
      {data && <footer className="asset-pagination"><span role="status">共 {data.total} 项</span><button type="button" disabled={busy || offset===0} onClick={()=>setOffset(v=>Math.max(0,v-24))}>上一页</button>
        <button type="button" disabled={busy || offset+24>=data.total} onClick={()=>setOffset(v=>v+24)}>下一页</button></footer>}
    </>}
    {selected && <AssetPreview asset={selected} onClose={()=>setSelected(undefined)} />}
  </section>;
}

function AssetPreview({asset,onClose}:{asset:Asset;onClose:()=>void}):React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const [failed,setFailed] = useState(false);
  useEffect(()=>{const previous=document.activeElement;const el=dialog.current;el?.showModal();return()=>{el?.close();if(previous instanceof HTMLElement && previous.isConnected)previous.focus();};},[]);
  return <dialog ref={dialog} className="asset-dialog" aria-label={asset.title} onCancel={event=>{event.preventDefault();onClose();}}>
    <header className="asset-toolbar"><h2>{asset.title}</h2><button type="button" onClick={onClose} aria-label="关闭资产预览">关闭</button></header>
    {!asset.url || failed ? <p role="alert">此素材暂时无法预览，请稍后刷新。</p> : asset.mediaType==="video"
      ? <video src={asset.url} controls preload="metadata" onError={()=>setFailed(true)} />
      : <img src={asset.url} alt={asset.title} onError={()=>setFailed(true)} />}
    {asset.mediaType==="video" && <p>生成状态不代表画面质检结果。</p>}
  </dialog>;
}
