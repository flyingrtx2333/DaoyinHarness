import { useEffect, useRef, useState } from "react";
import { filterPlugins, PLUGINS, type WorkbenchPlugin } from "./plugins.js";

interface PluginActions { selectedId: string; onSelect: (id: string) => void; busy: boolean }

export function PluginCatalog({ selectedId, onSelect, busy }: PluginActions): React.JSX.Element {
  const [query, setQuery] = useState("");
  const matches = filterPlugins(query);
  return <section className="plugin-catalog" aria-label="业务插件">
    <div className="plugin-catalog-toolbar"><p>选择可用插件，在会话中使用。</p><label><span className="sr-only">搜索插件</span><input type="search" placeholder="搜索插件" value={query} onChange={(event) => setQuery(event.target.value)} /></label></div>
    <div className="plugin-grid">{matches.map((plugin) => <article className="plugin-card" key={plugin.id}>
      <div className="plugin-card-heading"><span className={`plugin-mark plugin-mark-${plugin.id}`} aria-hidden="true">{plugin.mark}</span><h2>{plugin.name}</h2><span className={`plugin-state ${plugin.status}`}>{plugin.status === "available" ? "可用" : "待接入"}</span></div>
      <p className="plugin-description">{plugin.description}</p>
      <ul className="plugin-capabilities">{plugin.capabilities.map((capability) => <li key={capability}>{capability}</li>)}</ul>
      <div className="plugin-card-bottom"><p>{plugin.note}</p>{plugin.status === "available" ? <button className="primary" disabled={busy} onClick={() => onSelect(plugin.id)}>{selectedId === plugin.id ? "返回会话使用" : "使用插件"}</button> : <span className="plugin-unavailable">暂不可选</span>}</div>
    </article>)}</div>
    {matches.length === 0 && <p className="plugin-no-results" role="status">没有找到匹配的插件</p>}
  </section>;
}

export function PluginPicker({ selectedId, onSelect, onBrowse, busy }: PluginActions & { onBrowse: () => void }): React.JSX.Element {
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
      <div className="plugin-picker-heading">会话插件<button type="button" className="plugin-close" aria-label="关闭插件选择" onClick={() => close(true)}>×</button></div>
      <div className="plugin-options">{PLUGINS.map((plugin: WorkbenchPlugin) => plugin.status === "available" ?
        <button type="button" className="plugin-option" key={plugin.id} aria-pressed={selectedId === plugin.id} disabled={busy} onClick={() => { onSelect(plugin.id); close(true); }}><span className={`plugin-mark plugin-mark-${plugin.id}`} aria-hidden="true">{plugin.mark}</span><span>{plugin.name}<small>{plugin.capabilities.join(" · ")}</small></span><span className="plugin-option-state">{selectedId === plugin.id ? "已选" : "选择"}</span></button> :
        <div className="plugin-option pending" key={plugin.id}><span className={`plugin-mark plugin-mark-${plugin.id}`} aria-hidden="true">{plugin.mark}</span><span>{plugin.name}</span><span className="plugin-option-state">待接入</span></div>)}</div>
      <button type="button" className="plugin-browse" onClick={() => { close(false); onBrowse(); }}>浏览全部插件 <span aria-hidden="true">↗</span></button>
    </div>}
  </div>;
}
