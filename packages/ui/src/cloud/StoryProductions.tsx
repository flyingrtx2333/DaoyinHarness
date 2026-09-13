import { useEffect, useRef, useState } from "react";
import type { AgentEvent } from "@daoyin/harness-protocol";
import type { WorkbenchClient } from "./client.js";

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const unwrap = (value: Record<string, unknown>): Record<string, unknown> => record(value.result) ? value.result : value;
const rows = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter(record) : [];
const url = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  try { const parsed = new URL(value); return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed.href : undefined; } catch { return undefined; }
};
const labels: Record<string, string> = { PREPARE: "准备项目", SCRIPT: "创作剧本", ASSETS: "角色与场景", STORYBOARD: "制作分镜", REVIEW: "审核素材", VIDEO: "逐镜生成", EXPORT: "剪辑合成", SUBTITLE: "制作字幕", FINISH: "检查成片", PAUSED: "已暂停", BLOCKED: "需要处理", AWAITING_REVIEW: "等待审核", CANCELLED: "已取消后续制作", DONE: "成片已完成" };
const viewLabels: Record<string, string> = { face: "正面", side: "侧面", back: "背面", three_quarter: "四分之三" };

export function storyProductionIds(events: AgentEvent[], runId: string): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.turnId !== runId || event.type !== "tool.completed" || !["story_create_production", "story_get_production"].includes(event.payload.toolName)) continue;
    const result = event.payload.evidence.result;
    if (record(result) && record(result.data)) {
      const data = unwrap(result.data);
      if (typeof data.id === "string") ids.add(data.id);
    }
  }
  return [...ids];
}

export function StoryProductions({ events, runId, client }: { events: AgentEvent[]; runId: string; client: WorkbenchClient }): React.JSX.Element | null {
  const ids = storyProductionIds(events, runId);
  return ids.length ? <div>{ids.map(id => <ProductionCard key={id} id={id} client={client} />)}</div> : null;
}

function ProductionCard({ id, client }: { id: string; client: WorkbenchClient }): React.JSX.Element {
  const [data, setData] = useState<Record<string, unknown>>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll(): Promise<void> {
      try {
        const result = unwrap(await client.storyProduction(id, controller.signal));
        if (controller.signal.aborted) return;
        setData(result); setError("");
        if (!["DONE", "CANCELLED"].includes(String(result.state))) timer = setTimeout(() => { void poll(); }, 8000);
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "无法更新制作状态，原任务已保留。"); }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [client, id, refresh]);
  const state = String(data?.state || data?.status || "RUNNING");
  const status = labels[state] ?? labels[String(data?.stage)] ?? "正在制作";
  const budget = record(data?.budget) ? data.budget : undefined;
  const result = record(data?.result_json) ? data.result_json : undefined;
  const exported = result && record(result.export) ? result.export : undefined;
  const videoUrl = state === "DONE" ? url(exported?.output_url) : undefined;
  async function control(action: "pause" | "resume" | "approve" | "cancel"): Promise<void> {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await client.controlStoryProduction(id, action, typeof data?.revision === "string" ? data.revision : undefined);
      setRefresh(value => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "操作未完成，请查询原任务状态。"); }
    finally { setBusy(false); }
  }
  return <section className="story-video-card" aria-label="短剧制作任务">
    <p className="story-video-status" role="status">{status} · {Number(data?.progress || 0)}%</p>
    {videoUrl && <video className="story-video-player" controls preload="metadata" src={videoUrl} />}
    {budget && <p>已用 {Number(budget.spentCredits).toFixed(2)} · 预留 {Number(budget.reservedCredits).toFixed(2)} · 上限 {Number(budget.maxCredits).toFixed(2)} 积分</p>}
    {typeof data?.error_message === "string" && data.error_message && <p className="story-video-error">{data.error_message}</p>}
    {error && <p role="alert" className="story-video-error">{error}</p>}
    <button type="button" onClick={() => setOpen(true)}>查看制作详情</button>
    <button type="button" disabled={busy} onClick={() => setRefresh(value => value + 1)}>刷新状态</button>
    {open && data && <ProductionDetails data={data} busy={busy} error={error} onClose={() => setOpen(false)} onControl={control} />}
  </section>;
}

function ProductionDetails({ data, busy, error, onClose, onControl }: {
  data: Record<string, unknown>; busy: boolean; error: string; onClose: () => void;
  onControl: (action: "pause" | "resume" | "approve" | "cancel") => Promise<void>;
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [cancelRequested, setCancelRequested] = useState(false);
  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current;
    element?.showModal(); close.current?.focus();
    return () => { element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const assets = record(data.assets) ? data.assets : {};
  const state = String(data.state || "");
  const terminal = ["CANCELLED", "DONE"].includes(state);
  return <dialog ref={dialog} className="video-creation-dialog" aria-label="短剧制作详情" aria-busy={busy}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={event => event.preventDefault()}>
    <header><h2>短剧制作</h2><button ref={close} type="button" className="plugin-close" aria-label="关闭制作详情" disabled={busy} onClick={onClose}>×</button></header>
    <details open><summary>角色参考</summary><div className="video-field-grid">{rows(assets.characters).map(character => <section key={String(character.id)}>
      <h3>{String(character.extracted_name)}</h3>
      {record(character.references) && Object.entries(character.references).map(([view, image]) => record(image) && url(image.output_url)
        ? <figure key={view}><img style={{ width: "100%", maxHeight: 200, objectFit: "contain" }} src={url(image.output_url)} alt={`${String(character.extracted_name)} · ${viewLabels[view] || view}`} />
          <figcaption>{viewLabels[view] || view}</figcaption></figure> : null)}
    </section>)}</div></details>
    <details open><summary>环境参考</summary><div className="video-field-grid">{rows(assets.scenes).map(scene => <figure key={String(scene.id)}>
      {url(scene.reference_url) && <img style={{ width: "100%", maxHeight: 200, objectFit: "contain" }} src={url(scene.reference_url)} alt={String(scene.name)} />}<figcaption>{String(scene.name)}</figcaption>
      {rows(scene.camera_references).map(camera => <div key={String(camera.request_id || camera.angle)}>{url(camera.output_url) && <img style={{ width: "100%", maxHeight: 160, objectFit: "contain" }} src={url(camera.output_url)} alt={`${String(scene.name)} · ${String(camera.angle)}`} />}<p>{String(camera.angle)}</p></div>)}
    </figure>)}</div></details>
    <details open><summary>分镜</summary>{rows(assets.segments).map(segment => <section key={String(segment.id)}>
      <h3>镜头 {String(segment.segment_index)} · {String(segment.duration_seconds)} 秒</h3>
      {url(segment.frame_url) && <img style={{ maxWidth: "100%", maxHeight: 180, objectFit: "contain" }} src={url(segment.frame_url)} alt={`镜头 ${String(segment.segment_index)} 首帧`} />}
      <p>{String(segment.video_prompt || "")}</p><p>{String(segment.dialogue || "")}</p>
      {record(segment.video) && <p>{String(segment.video.status)}{typeof segment.video.error_message === "string" && ` · ${segment.video.error_message}`}</p>}
      {record(segment.video) && url(segment.video.output_url) && <video className="story-video-player" controls preload="metadata" src={url(segment.video.output_url)} />}
    </section>)}</details>
    {error && <p className="video-creation-error" role="alert">{error}</p>}
    {cancelRequested && !terminal && <p role="alert">取消只停止后续提交，已经提交供应商的任务仍可能完成并结算。
      <button type="button" disabled={busy} onClick={() => { void onControl("cancel"); setCancelRequested(false); }}>确认取消后续制作</button>
      <button type="button" onClick={() => setCancelRequested(false)}>返回</button></p>}
    <footer>
      {data.workflowVersion === 2 && !terminal && <>
        {(state === "AWAITING_REVIEW" || (state === "BLOCKED" && data.stage === "REVIEW")) && <button type="button" className="primary" disabled={busy} onClick={() => { void onControl("approve"); }}>确认资产与分镜，开始生成视频</button>}
        {state === "PAUSED" && <button type="button" disabled={busy} onClick={() => { void onControl("resume"); }}>继续制作</button>}
        {state === "BLOCKED" && data.stage === "REVIEW" && <button type="button" disabled={busy} onClick={() => { void onControl("resume"); }}>重试失败角色参考（最多一次）</button>}
        {state === "RUNNING" && <button type="button" disabled={busy} onClick={() => { void onControl("pause"); }}>暂停</button>}
        <button type="button" disabled={busy} onClick={() => setCancelRequested(true)}>取消后续制作</button>
      </>}
      <button type="button" disabled={busy} onClick={onClose}>关闭</button>
    </footer>
    </form>
  </dialog>;
}
