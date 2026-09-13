import { useEffect, useRef, useState } from "react";
import type { PendingVideoInteraction } from "./projection.js";

const text = (input: Record<string, unknown>, key: string): string => typeof input[key] === "string" ? input[key] : "";
const number = (input: Record<string, unknown>, key: string, fallback: number): number =>
  typeof input[key] === "number" && Number.isFinite(input[key]) ? input[key] : fallback;
const bool = (input: Record<string, unknown>, key: string, fallback: boolean): boolean =>
  typeof input[key] === "boolean" ? input[key] : fallback;
const modelLabel = (value: string): string => ({
  "doubao-seedance-2-0-mini-260615": "豆包 Seedance 2.0 Mini",
  "AutoDL-MiniMax-H3": "AutoDL MiniMax H3",
}[value] ?? value) || "系统推荐模型";

function findCredit(value: unknown, key: string, depth = 0): string | undefined {
  if (depth > 4 || value === null || typeof value !== "object") return undefined;
  if (!Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const current = record[key];
    if (typeof current === "string" || typeof current === "number") return String(current);
    for (const item of Object.values(record)) { const found = findCredit(item, key, depth + 1); if (found !== undefined) return found; }
  }
  return undefined;
}

export function VideoCreationDialog({ interaction, busy, error, onCancel, onConfirm }: {
  interaction: PendingVideoInteraction;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: (input: Record<string, unknown>) => void;
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const firstField = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const [input, setInput] = useState<Record<string, unknown>>(() => structuredClone(interaction.input));
  const production = interaction.operation === "story_create_production";
  const estimated = findCredit(interaction.estimate, "estimated_balance_consumption_credits");
  const reserved = findCredit(interaction.estimate, "reserve_amount_credits");
  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current;
    element?.showModal(); firstField.current?.focus(); firstField.current?.select();
    return () => { element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  function update(key: string, value: unknown): void { setInput(current => ({ ...current, [key]: value })); }
  const content = production ? text(input, "brief") : text(input, "prompt");
  return <dialog ref={dialog} className="video-creation-dialog" aria-labelledby="video-creation-title"
    aria-describedby="video-creation-note" aria-busy={busy}
    onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }}>
    <form onSubmit={(event) => { event.preventDefault(); if (!busy && content.trim()) onConfirm(input); }}>
      <header><div><span className="dialog-kicker">Story 制作确认</span><h2 id="video-creation-title">{production ? "确认一键生成短剧" : "确认生成视频"}</h2></div>
        <button type="button" className="plugin-close" aria-label="取消本次视频生成" disabled={busy} onClick={onCancel}>×</button></header>
      {production && <label className="video-field"><span>项目名称 <b>必填</b></span><input ref={firstField as React.RefObject<HTMLInputElement>}
        required maxLength={120} value={text(input, "title")} onChange={(event) => update("title", event.target.value)} /></label>}
      <label className="video-field video-content"><span>{production ? "故事创意与内容要求" : "画面内容"} <b>必填</b></span>
        <textarea ref={production ? undefined : firstField as React.RefObject<HTMLTextAreaElement>} required maxLength={production ? 20000 : 5000}
          rows={5} value={content} onChange={(event) => update(production ? "brief" : "prompt", event.target.value)} /></label>
      <div className="video-field-grid">
        <label className="video-field"><span>画幅</span><select value={text(input, "aspectRatio")} onChange={(event) => update("aspectRatio", event.target.value)}>
          <option value="16:9">横屏 16:9</option><option value="9:16">竖屏 9:16</option></select></label>
        <label className="video-field"><span>{production ? "目标总时长" : "时长"}</span><input type="number"
          min={production ? 8 : 1} max={production ? 900 : 15} step="1"
          value={number(input, production ? "targetDurationSeconds" : "durationSeconds", production ? 60 : 10)}
          onChange={(event) => update(production ? "targetDurationSeconds" : "durationSeconds", event.target.valueAsNumber)} /></label>
        <label className="video-field"><span>清晰度</span><select value={text(input, "resolution")} onChange={(event) => update("resolution", event.target.value)}>
          {["480p", "720p", "768p", "1080p", "2k", "4k"].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      </div>
      <p className="video-creation-meta">视频模型：{modelLabel(text(input, "modelName"))}（系统自动选择）</p>
      {production && <div className="video-field-grid"><label className="video-field"><span>单段时长</span><input type="number" min="4" max="15" step="1"
        value={number(input, "segmentDurationSeconds", 8)} onChange={(event) => update("segmentDurationSeconds", event.target.valueAsNumber)} /></label></div>}
      {production && <div className="video-confirm-checks">
        <label><input type="checkbox" checked={bool(input, "generateAudio", true)} onChange={(event) => update("generateAudio", event.target.checked)} />生成配音</label>
        <label><input type="checkbox" checked={bool(input, "generateSubtitles", true)} onChange={(event) => update("generateSubtitles", event.target.checked)} />生成字幕</label>
      </div>}
      {!production && <p className="video-creation-meta">生成方式：{({ new: "新生成", existing: "参考已有视频生成新版本", upload: "参考上传视频生成新版本" } as Record<string, string>)[text(input, "target")] ?? "新生成"}</p>}
      <p id="video-creation-note" className="video-creation-note">{estimated !== undefined
        ? <>预计消耗 <strong>{estimated} 积分</strong>{reserved !== undefined ? `，提交时可能临时冻结 ${reserved} 积分` : ""}。确认后才会提交真实生成任务。</>
        : "费用将按当前账号和所选模型的实时规则结算；确认后才会提交真实生成任务。"}</p>
      {error && <p className="video-creation-error" role="alert">{error}</p>}
      <footer><button type="button" disabled={busy} onClick={onCancel}>取消生成</button>
        <button type="submit" className="primary" disabled={busy || !content.trim()}>{busy ? "正在确认…" : "确认并开始生成"}</button></footer>
    </form>
  </dialog>;
}
