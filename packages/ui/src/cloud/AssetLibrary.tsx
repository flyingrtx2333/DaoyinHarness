import { useEffect, useRef, useState } from "react";
import type { WorkbenchClient } from "./client.js";
import "./asset-library.css";

const categories = { all: "全部", website: "网站", character: "角色图", scene: "场景图", storyboard: "分镜图", video: "视频" };
type Category = keyof typeof categories;
type StoryCategory = Exclude<Category, "website">;
export type AssetGeneration = { model?: string; generatedAt?: string; user?: string; platform?: string; consumption?: string };
export type Asset = { id: string; title: string; category: StoryCategory; mediaType: "image" | "video"; url?: string; previewUrl?: string; status: string; project: string; error: string; generation: AssetGeneration; variants: Asset[] };
export interface PublishedProject { id: string; title: string; slug: string; activeVersion: string | null }

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
function boundedText(value: unknown, max = 160): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > max || [...text].some(character => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  })) return undefined;
  return text;
}
function firstText(records: Record<string, unknown>[], keys: string[], max = 160): string | undefined {
  for (const record of records) for (const key of keys) {
    const text = boundedText(record[key], max);
    if (text) return text;
  }
  return undefined;
}
function parseGeneration(value: Record<string, unknown>): AssetGeneration {
  const records = [value.generation, value.generation_info, value.audit].filter(isRecord);
  records.push(value);
  const model = firstText(records, ["model_name", "modelName", "model"], 120);
  const generatedAt = firstText(records, ["generated_at", "generatedAt", "created_at", "createdAt"], 64);
  const user = firstText(records, ["created_by_name", "createdByName", "creator_name", "creatorName", "user_name", "userName"], 80);
  const platform = firstText(records, ["platform_name", "platformName", "platform", "provider_name", "providerName"], 80);
  const consumption = firstText(records, ["consumption_display", "consumptionDisplay", "actual_consumption", "actualConsumption", "actual_cost_display", "actualCostDisplay", "usage_display", "usageDisplay"], 120);
  return {
    ...(model ? { model } : {}),
    ...(generatedAt && Number.isFinite(Date.parse(generatedAt)) ? { generatedAt } : {}),
    ...(user ? { user } : {}),
    ...(platform ? { platform } : {}),
    ...(consumption ? { consumption } : {}),
  };
}
export function publishedProjectUrl(project: PublishedProject): string | undefined {
  if (!project.activeVersion || !/^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/u.test(project.slug)) return undefined;
  return `https://${project.slug}.demo.daoyintech.com/`;
}
export function parseAsset(v: unknown, nested = false): Asset {
  if (!isRecord(v) || typeof v.id !== "string" || typeof v.title !== "string" ||
      typeof v.category !== "string" || v.category === "website" || !Object.hasOwn(categories, v.category) ||
      !["image", "video"].includes(String(v.media_type))) throw new Error("素材数据无效。");
  const u = safeUrl(v.url);
  const previewUrl = firstSafeUrl(v.thumbnail_url, v.poster_url, v.preview_url, v.thumbnailUrl, v.posterUrl, v.previewUrl);
  return { id: v.id, title: v.title, category: v.category as StoryCategory, mediaType: v.media_type as Asset["mediaType"],
    ...(u ? { url: u } : {}), ...(previewUrl ? { previewUrl } : {}), status: String(v.status || ""),
    project: typeof v.project_title === "string" ? v.project_title : "", error: typeof v.error_message === "string" ? v.error_message : "",
    generation: parseGeneration(v),
    variants: !nested && Array.isArray(v.variants) ? v.variants.map(item => parseAsset(item, true)) : [] };
}
export function videoPreviewSource(url: string): string {
  const parsed = new URL(url);
  if (!parsed.hash) parsed.hash = "t=0.1";
  return parsed.href;
}
const statuses: Record<string, string> = { SUCCEEDED: "生成完成", DRAFT: "草稿", LOCKED: "已锁定", STALE: "已过期", FAILED: "失败", READY: "已就绪" };

export function AssetLibrary({ client, ready, onConnect }: { client: WorkbenchClient; ready: boolean; onConnect: () => void }): React.JSX.Element {
  const [category, setCategory] = useState<Category>("all");
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<{ items: Asset[]; total: number }>();
  const [websites, setWebsites] = useState<Array<{ project: PublishedProject; url: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [selected, setSelected] = useState<Asset>();

  useEffect(() => {
    const controller = new AbortController();
    if (!ready) return () => controller.abort();
    setBusy(true); setErrors([]); setData(undefined); setWebsites([]);
    const storyRequest = category === "website"
      ? Promise.resolve({ items: [] as Asset[], total: 0 })
      : client.storyAssets(category, offset, controller.signal).then(response => {
        const result = isRecord(response.result) ? response.result : response;
        if (!Array.isArray(result.items) || typeof result.total !== "number") throw new Error("素材列表暂不可用，请刷新重试。");
        return { items: result.items.map(item => parseAsset(item)), total: result.total };
      });
    const websiteRequest = category === "all" || category === "website"
      ? client.project<{ projects: PublishedProject[] }>({ action: "list" }).then(result => result.projects.flatMap(project => {
        const url = publishedProjectUrl(project);
        return url ? [{ project, url }] : [];
      }))
      : Promise.resolve([]);
    void Promise.allSettled([storyRequest, websiteRequest]).then(([storyResult, websiteResult]) => {
      if (controller.signal.aborted) return;
      const failures: string[] = [];
      if (storyResult.status === "fulfilled") setData(storyResult.value);
      else failures.push(storyResult.reason instanceof Error ? storyResult.reason.message : "素材加载失败，请重试。");
      if (websiteResult.status === "fulfilled") setWebsites(websiteResult.value);
      else failures.push(websiteResult.reason instanceof Error ? websiteResult.reason.message : "网站加载失败，请重试。");
      setErrors([...new Set(failures)]);
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [client, ready, category, offset, refresh]);

  const empty = !busy && websites.length === 0 && (data?.items.length ?? 0) === 0;
  return <section className="asset-library" aria-label="资产库">
    <header className="asset-toolbar"><h1>资产</h1><button type="button" disabled={!ready || busy} onClick={() => setRefresh(v => v + 1)}>刷新</button></header>
    <div className="asset-filters" aria-label="资产分类">{(Object.keys(categories) as Category[]).map(key => <button key={key} type="button" aria-pressed={category === key}
      onClick={() => { setCategory(key); setOffset(0); }}>{categories[key]}</button>)}</div>
    {!ready ? <div role="status"><p>请连接道引账号后查看资产。</p><button type="button" onClick={onConnect}>连接账号</button></div> : <>
      {busy && <p role="status">正在加载资产…</p>}
      {errors.map(message => <p role="alert" key={message}>{message} <button type="button" onClick={() => setRefresh(v => v + 1)}>重试加载</button></p>)}
      {empty && <p role="status">暂无{category === "all" ? "资产" : categories[category]}。</p>}
      {websites.length > 0 && <div className="asset-grid website-grid" aria-label="已发布网站">
        {websites.map(({ project, url }) => <article className="asset-item website-item" key={project.id}>
          <a className="asset-preview website-preview" href={url} target="_blank" rel="noreferrer" aria-label={`进入网站 ${project.title}`}>
            <iframe src={url} title={`${project.title} 网站缩略图`} sandbox="allow-scripts allow-same-origin" loading="lazy" tabIndex={-1} aria-hidden="true" />
            <span className="website-open">进入网站</span>
          </a>
          <div className="asset-meta"><h2 title={project.title}>{project.title}</h2><p>网站 · 已发布</p><p className="asset-project" title={url}>{project.slug}.demo.daoyintech.com</p></div>
        </article>)}
      </div>}
      <div className="asset-grid">{data?.items.map(item => <article className="asset-item" key={item.id}>
        <button type="button" className="asset-preview" onClick={() => setSelected(item)} aria-label={`预览 ${item.title}`}>
          <AssetThumbnail asset={item} />
        </button>
        <div className="asset-meta"><h2 title={item.title}>{item.title}</h2><p>{categories[item.category]} · {statuses[item.status] || item.status || "处理中"}</p>
          {item.project && <p className="asset-project" title={item.project}>{item.project}</p>}</div>
      </article>)}</div>
      {category !== "website" && data && data.total > 0 && <footer className="asset-pagination"><span role="status">共 {data.total} 项素材</span><button type="button"
        disabled={busy || offset === 0} onClick={() => setOffset(v => Math.max(0, v - 24))}>上一页</button>
        <button type="button" disabled={busy || offset + 24 >= data.total} onClick={() => setOffset(v => v + 24)}>下一页</button></footer>}
    </>}
    {selected && <AssetPreview asset={selected} onClose={() => setSelected(undefined)} />}
  </section>;
}

function AssetThumbnail({ asset }: { asset: Asset }): React.JSX.Element {
  const [imageFailed, setImageFailed] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  if (asset.mediaType === "image") {
    return asset.url && !imageFailed ? <img src={asset.url} alt="" loading="lazy" onError={() => setImageFailed(true)} />
      : <span className="asset-preview-fallback">预览不可用</span>;
  }
  return <>
    {asset.previewUrl && !imageFailed ? <img src={asset.previewUrl} alt="" loading="lazy" onError={() => setImageFailed(true)} />
      : asset.url && !videoFailed ? <video src={videoPreviewSource(asset.url)} muted playsInline preload="metadata" aria-hidden="true" onError={() => setVideoFailed(true)} />
        : <span className="asset-preview-fallback">视频预览不可用</span>}
    <span className="asset-play" aria-hidden="true"><span /></span>
  </>;
}
function AssetPreview({ asset, onClose }: { asset: Asset; onClose: () => void }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const [failed, setFailed] = useState(false);
  const [current, setCurrent] = useState(asset.variants[0] ?? asset);
  useEffect(() => { const previous = document.activeElement; const el = dialog.current; el?.showModal(); return () => { el?.close(); if (previous instanceof HTMLElement) previous.focus(); }; }, []);
  return <dialog ref={dialog} className="asset-dialog" aria-label={asset.title} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="asset-toolbar"><h2>{asset.title}</h2><button type="button" onClick={onClose} aria-label="关闭资产预览">关闭</button></header>
    {asset.variants.length > 0 && <div className="asset-filters" aria-label="角色图片版本">{asset.variants.map((variant, index) => <button key={variant.id} type="button"
      aria-pressed={current.id === variant.id} onClick={() => { setCurrent(variant); setFailed(false); }}>{variant.title} · {statuses[variant.status] || variant.status || `版本 ${index + 1}`}</button>)}</div>}
    {!current.url || failed ? <p role="alert">此素材暂时无法预览，请稍后刷新。</p> : current.mediaType === "video"
      ? <video src={current.url} controls preload="metadata" onError={() => setFailed(true)} />
      : <img key={current.id} src={current.url} alt={`${asset.title} · ${current.title}`} onError={() => setFailed(true)} />}
    <AssetGenerationMeta generation={current.id === asset.id ? asset.generation : current.generation} />
    {current.error && <p role="status">未用于分镜：{current.error}</p>}
    {asset.mediaType === "video" && <p>生成状态不代表画面质检结果。</p>}
  </dialog>;
}

function AssetGenerationMeta({ generation }: { generation: AssetGeneration }): React.JSX.Element {
  const entries = [
    generation.model ? ["生成模型", generation.model] : undefined,
    generation.generatedAt ? ["生成时间", new Date(generation.generatedAt).toLocaleString("zh-CN")] : undefined,
    generation.user ? ["创建用户", generation.user] : undefined,
    generation.platform ? ["来源平台", generation.platform] : undefined,
    generation.consumption ? ["实际消耗", generation.consumption] : undefined,
  ].filter((entry): entry is [string, string] => entry !== undefined);
  if (entries.length === 0) return <p className="asset-generation-empty">暂无生成记录</p>;
  return <dl className="asset-generation-meta">{entries.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}
