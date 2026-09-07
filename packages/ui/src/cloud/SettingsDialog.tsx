import { useEffect, useRef } from "react";
import { buildChannelLabel, buildInfo, buildUpdatedAt, buildVersion } from "./build-info.js";
import type { WorkbenchPreferences } from "./preferences.js";

export function SettingsDialog({ preferences, onChange, onClose, saveError }: {
  preferences: WorkbenchPreferences; onChange: (value: WorkbenchPreferences) => void; onClose: () => void; saveError: string;
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} className="workbench-settings" aria-labelledby="settings-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onKeyDown={(event) => {
    if (event.key !== "Tab") return;
    const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled), select:not(:disabled), input:not(:disabled)") ?? []);
    const first = controls[0]; const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}>
    <header><h2 id="settings-title">设置</h2><button type="button" className="plugin-close" aria-label="关闭设置" onClick={onClose}>×</button></header>
    <div className="settings-field"><label htmlFor="send-shortcut">发送消息</label><select id="send-shortcut" value={preferences.sendShortcut} onChange={(event) => onChange({ ...preferences, sendShortcut: event.target.value === "modifier-enter" ? "modifier-enter" : "enter" })}>
      <option value="enter">Enter 发送，Shift + Enter 换行</option><option value="modifier-enter">Ctrl / ⌘ + Enter 发送，Enter 换行</option>
    </select></div>
    <label className="settings-toggle"><span>回复时自动滚动</span><input type="checkbox" checked={preferences.autoScroll} onChange={(event) => onChange({ ...preferences, autoScroll: event.target.checked })} /></label>
    {saveError && <p role="alert" className="settings-error">{saveError}</p>}
    <section className="settings-about" aria-labelledby="settings-about-title">
      <h3 id="settings-about-title">关于道引 Harness</h3>
      <dl className="settings-version">
        <dt>当前版本</dt>
        <dd><span title={buildInfo.revision ? `代码提交：${buildInfo.revision}` : undefined}>{buildVersion}</span>{buildChannelLabel && <span className="settings-build-channel">{buildChannelLabel}</span>}</dd>
        <dt>更新时间</dt>
        <dd>{buildUpdatedAt && buildInfo.builtAt
          ? <><time dateTime={buildInfo.builtAt}>{buildUpdatedAt}</time> UTC+8</>
          : buildInfo.channel === "development" ? "开发环境未构建" : "未提供"}</dd>
      </dl>
      <p className="settings-version-note">更新时间为当前前端版本的构建时间。</p>
    </section>
    <footer><button type="button" className="primary" onClick={onClose}>完成</button></footer>
  </dialog>;
}
