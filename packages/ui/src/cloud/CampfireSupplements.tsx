import { useEffect, useRef, useState } from "react";
import type { AgentEvent } from "@daoyin/harness-protocol";
import type { WorkbenchClient } from "./client.js";
import { campfireAsset, type CampfireAsset } from "./campfire-client.js";
import { CampfirePreview } from "./CampfireLibrary.js";

interface SupplementQuote {
  id: string; planId: string; shopId: string; title: string; missingShot: string; prompt: string;
  model: string; resolution: string; aspectRatio: string; durationSeconds: number; estimatedCredits: number; expiresAt: string;
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function parseQuote(value: unknown): SupplementQuote | undefined {
  if (!record(value) || ![value.id, value.planId, value.shopId].every(id => typeof id === "string" && /^res_[a-f0-9]{24}$/u.test(id)) ||
      ![value.title, value.missingShot, value.prompt, value.model, value.expiresAt].every(text => typeof text === "string" && text.length > 0 && text.length <= 1200) ||
      !["480p", "720p", "1080p"].includes(String(value.resolution)) || !["9:16", "16:9"].includes(String(value.aspectRatio)) ||
      typeof value.durationSeconds !== "number" || !Number.isInteger(value.durationSeconds) || value.durationSeconds < 4 || value.durationSeconds > 15 ||
      typeof value.estimatedCredits !== "number" || !Number.isFinite(value.estimatedCredits) || value.estimatedCredits < 0 ||
      !Number.isFinite(Date.parse(String(value.expiresAt)))) return undefined;
  return value as unknown as SupplementQuote;
}
const pending = new Set(["processing", "queued", "running"]);
const labels: Record<string, string> = { checking: "正在读取报价状态…", awaiting_confirmation: "等待你确认，尚未提交生成", approved: "已确认报价，尚未提交生成", processing: "AI 补镜头制作中…", queued: "AI 补镜头排队中…", running: "AI 补镜头制作中…", succeeded: "AI 演绎素材已保存", failed: "原补镜头任务失败，未补齐镜头", cancelled: "原补镜头任务已取消", expired: "原补镜头任务已过期" };

function SupplementCard({ client, quote, onContinue }: { client: WorkbenchClient; quote: SupplementQuote; onContinue: (message: string) => void }): React.JSX.Element {
  const [status, setStatus] = useState("checking"); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [asset, setAsset] = useState<CampfireAsset>(); const [preview, setPreview] = useState(false);
  const alive = useRef(true); const operation = useRef(false); const controller = useRef(new AbortController());
  const scope = client.accountScope; const pollDeadline = useRef(Date.now() + 15 * 60_000);
  const current = (): boolean => alive.current && client.accountScope === scope;
  function receipt(value: unknown): void {
    if (!record(value) || typeof value.status !== "string" || !(value.status in labels)) throw new Error("补镜头状态回执无效，请查询原任务。");
    if (value.status === "succeeded") {
      const saved = campfireAsset(value.asset);
      if (saved.id !== quote.id || saved.shopId !== quote.shopId || saved.origin !== "ai" || saved.mediaType !== "video/mp4") throw new Error("AI 素材回执不完整，请查询原任务。");
      setAsset(saved);
    }
    setStatus(value.status);
  }
  async function refresh(): Promise<void> {
    if (operation.current || !current()) return;
    operation.current = true; setBusy(true); setError("");
    try {
      const result = await client.resource({ action: "resource_campfire_supplement_status", resourceId: quote.id }, controller.current.signal);
      if (current()) receipt(result);
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : "状态查询未完成，请继续查询原任务。"); }
    finally { operation.current = false; if (current()) setBusy(false); }
  }
  useEffect(() => {
    alive.current = true; controller.current = new AbortController(); void refresh();
    return () => { alive.current = false; controller.current.abort(); };
  }, [client, scope, quote.id]);
  useEffect(() => {
    if (!pending.has(status) || busy || error || Date.now() >= pollDeadline.current) return;
    const timer = setTimeout(() => { void refresh(); }, 10_000);
    return () => clearTimeout(timer);
  }, [status, busy, error]);
  async function confirm(): Promise<void> {
    if (operation.current || !current()) return;
    operation.current = true; setBusy(true); setError("");
    try {
      const approval = await client.resource({ action: "resource_media_supplement_approve", resourceId: quote.id }, controller.current.signal);
      if (!current()) return;
      receipt(approval);
      // An already submitted quote returns its original task, never a fresh request.
      if (record(approval) && approval.status === "approved") {
        const submitted = await client.resource({ action: "resource_campfire_supplement", resourceId: quote.id }, controller.current.signal);
        if (current()) {
          if (record(submitted) && submitted.status === "succeeded" && !submitted.asset) {
            const saved = await client.resource({ action: "resource_campfire_supplement_status", resourceId: quote.id }, controller.current.signal);
            if (current()) receipt(saved);
          } else receipt(submitted);
        }
      }
    } catch (cause) {
      if (current()) { setStatus("checking"); setError(cause instanceof Error ? cause.message : "提交结果尚未确认，请查询原任务，不要重新生成。"); }
    } finally { operation.current = false; if (current()) setBusy(false); }
  }
  const expired = Date.parse(quote.expiresAt) <= Date.now();
  return <section className="asset-form campfire-supplement" aria-label="AI 补镜头报价">
    <h3>AI 演绎补镜头</h3><p>缺失镜头：{quote.missingShot}</p><p className="asset-document">{quote.prompt}</p>
    <p className="asset-library-note">{quote.durationSeconds} 秒 · {quote.aspectRatio} · {quote.resolution} · {quote.model}</p>
    <p>预估 {quote.estimatedCredits.toLocaleString("zh-CN", { maximumFractionDigits: 6 })} 积分，按实际用量结算。</p>
    <p className="asset-library-note">画面会标记“AI 演绎”，不代表店铺真实现场。确认前不会提交生成。</p>
    <p role="status">{labels[status]}{expired && ["awaiting_confirmation", "approved"].includes(status) ? "；报价已过期，请在聊天中重新报价。" : ""}</p>
    {error && <p role="alert">{error}</p>}
    <div className="asset-control">
      {["awaiting_confirmation", "approved"].includes(status) && <button type="button" className="primary" disabled={busy || expired} onClick={() => { void confirm(); }}>确认并生成 AI 补镜头</button>}
      {status !== "succeeded" && <button type="button" disabled={busy} onClick={() => { void refresh(); }}>{busy ? "正在处理…" : "查询原任务状态"}</button>}
      {asset && <><button type="button" onClick={() => setPreview(true)}>预览 AI 素材</button><button type="button" onClick={() => onContinue(`使用已完成的 AI 演绎素材 ${asset.id} 补充店铺资料 ${quote.shopId} 的缺失镜头。先 inspect 真实生成画面和原计划 ${quote.planId}，按实际内容与时长保存新的完整剪辑计划；保留 AI 演绎来源标记，不把画面当成本店真实现场，不覆盖旧计划，不生成其他 AI 镜头。`)}>继续编排成片</button></>}
    </div>
    {asset && preview && <CampfirePreview client={client} asset={asset} onClose={() => setPreview(false)} />}
  </section>;
}

export function CampfireSupplements({ client, events, runId, onContinue }: { client: WorkbenchClient; events: AgentEvent[]; runId: string; onContinue: (message: string) => void }): React.JSX.Element | null {
  const quotes = new Map<string, SupplementQuote>();
  for (const event of events) {
    if (event.turnId !== runId || event.type !== "tool.completed" || event.payload.toolName !== "resource_campfire_supplement_quote") continue;
    const result = event.payload.evidence.result;
    const quote = record(result) ? parseQuote(result.quote) : undefined;
    if (quote) quotes.set(quote.id, quote);
  }
  return quotes.size ? <>{[...quotes.values()].map(quote => <SupplementCard key={`${client.accountScope}:${quote.id}`} client={client} quote={quote} onContinue={onContinue} />)}</> : null;
}
