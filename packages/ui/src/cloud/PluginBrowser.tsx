import { useEffect, useRef, useState } from "react";
import { filterPlugins } from "./plugins.js";
import { PluginIcon, WorkbenchIcon } from "./WorkbenchIcon.js";

interface PluginActions { selectedId: string; onSelect: (id: string) => void; busy: boolean; authorizedProfiles?: readonly string[] }

export function PluginCatalog({ onSelect, busy, authorizedProfiles = [] }: PluginActions): React.JSX.Element {
  const [query, setQuery] = useState("");
  const matches = filterPlugins(query, authorizedProfiles);
  return <section className="plugin-catalog" aria-label="业务插件">
    <div className="plugin-catalog-toolbar"><label><span className="sr-only">搜索插件</span><WorkbenchIcon name="search" /><input type="search" placeholder="搜索插件" value={query} onChange={(event) => setQuery(event.target.value)} /></label></div>
    <div className="plugin-grid">{matches.map((plugin) => <article className={`plugin-card ${plugin.status}`} key={plugin.id} aria-labelledby={`catalog-${plugin.id}`}>
      <span className={`plugin-mark plugin-mark-${plugin.id}`}><PluginIcon id={plugin.id} /></span>
      <div className="plugin-card-copy"><h2 id={`catalog-${plugin.id}`}>{plugin.name}</h2><p className="plugin-description">{plugin.description}</p></div>
      {plugin.status !== "pending" ? <button className="plugin-use" aria-label={`${plugin.status === "authorization_required" ? "连接授权" : "使用"}${plugin.name}`} disabled={busy} onClick={() => onSelect(plugin.id)}>{plugin.status === "authorization_required" ? "授权" : "使用"}</button> : <span className="plugin-state">待接入</span>}
    </article>)}</div>
    {matches.length === 0 && <p className="plugin-no-results" role="status">没有找到匹配的插件</p>}
  </section>;
}

export function PluginPicker({ selectedId, onSelect, onBrowse, busy, authorizedProfiles = [] }: PluginActions & { onBrowse: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  function close(restoreFocus: boolean): void { setOpen(false); if (restoreFocus) trigger.current?.focus(); }
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    function outside(event: PointerEvent): void {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return <div className="plugin-control" ref={container} onKeyDown={(event) => { if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(true); } }} onBlur={(event) => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button type="button" className="plugin-add" ref={trigger} aria-label="选择插件" aria-haspopup="dialog" aria-expanded={open} aria-controls="plugin-picker" onClick={() => setOpen(!open)}><span aria-hidden="true">＋</span></button>
    {open && <div className="plugin-picker" id="plugin-picker" role="dialog" aria-label="选择会话插件" ref={panel}>
      <div className="plugin-picker-heading">选择插件<button type="button" className="plugin-close" aria-label="关闭插件选择" onClick={() => close(true)}>×</button></div>
      <div className="plugin-options">{filterPlugins("", authorizedProfiles).map((plugin) => plugin.status !== "pending" ?
        <button type="button" className="plugin-option" key={plugin.id} aria-pressed={selectedId === plugin.id} disabled={busy} onClick={() => { onSelect(plugin.id); close(true); }}><span className={`plugin-mark plugin-mark-${plugin.id}`}><PluginIcon id={plugin.id} /></span><span>{plugin.name}</span><span className="plugin-option-state">{plugin.status === "authorization_required" ? "连接授权" : selectedId === plugin.id ? "已选" : "选择"}</span></button> :
        <div className="plugin-option pending" key={plugin.id}><span className={`plugin-mark plugin-mark-${plugin.id}`}><PluginIcon id={plugin.id} /></span><span>{plugin.name}</span><span className="plugin-option-state">待接入</span></div>)}</div>
      <button type="button" className="plugin-browse" onClick={() => { close(false); onBrowse(); }}>浏览全部插件 <span aria-hidden="true">↗</span></button>
    </div>}
  </div>;
}
