import { useEffect, useRef, useState } from "react";
import type { WorkbenchClient } from "./client.js";
import { campfireList, campfireProfile, campfireReadProfile, mergeCampfireAssets, type CampfireAsset } from "./campfire-client.js";

export function CampfireShopManager({ client, initialShopId = "", onChanged, onUse, useLabel, onClose }: { client: WorkbenchClient; initialShopId?: string; onChanged: (asset: CampfireAsset) => void; onUse: (asset: CampfireAsset) => void; useLabel: string; onClose: () => void }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null); const alive = useRef(true); const readGeneration = useRef(0);
  const [shops, setShops] = useState<CampfireAsset[]>([]); const [cursor, setCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState(initialShopId); const [editing, setEditing] = useState<CampfireAsset>();
  const [title, setTitle] = useState(""); const [content, setContent] = useState(""); const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true); const [reading, setReading] = useState(false); const [saving, setSaving] = useState(false); const [saved, setSaved] = useState(false);
  const scope = client.accountScope; const active = (): boolean => alive.current && scope === client.accountScope;
  useEffect(() => {
    alive.current = true; const previous = document.activeElement; dialog.current?.showModal();
    return () => { alive.current = false; dialog.current?.close(); if (previous instanceof HTMLElement) previous.focus(); };
  }, []);
  async function load(pageCursor?: string): Promise<void> {
    setLoading(true); setError("");
    try { const page = await campfireList(client, { filterRole: "shop_profile", ...(pageCursor ? { pageCursor } : {}) }); if (active()) { setShops(current => pageCursor ? mergeCampfireAssets(current, page.items) : page.items); setCursor(page.nextCursor); } }
    catch (cause) { if (active()) setError(cause instanceof Error ? cause.message : "店铺加载失败。"); }
    finally { if (active()) setLoading(false); }
  }
  useEffect(() => { void load(); }, [client, scope]);
  useEffect(() => {
    if (selectedId && editing?.id === selectedId && saved) return;
    const generation = ++readGeneration.current; setEditing(undefined); setTitle(""); setContent(""); setSaved(false); setError("");
    if (!selectedId) { setReading(false); return; }
    setReading(true);
    void campfireReadProfile(client, selectedId).then(asset => { if (active() && generation === readGeneration.current) { setEditing(asset); setTitle(asset.title); setContent(asset.content ?? ""); } }).catch(cause => { if (active() && generation === readGeneration.current) setError(cause instanceof Error ? cause.message : "店铺资料读取失败。"); }).finally(() => { if (active() && generation === readGeneration.current) setReading(false); });
  }, [client, scope, selectedId, retry]);
  const dirty = title.trim() !== (editing?.title ?? "") || content.trim() !== (editing?.content ?? "").trim();
  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault(); if (saving || reading || !title.trim() || !content.trim() || selectedId && !editing) return;
    setSaving(true); setError(""); setSaved(false);
    try { const asset = await campfireProfile(client, title.trim(), content.trim(), editing); if (!active()) return; setShops(current => mergeCampfireAssets([asset], current.filter(item => item.id !== asset.id))); setSelectedId(asset.id); setEditing(asset); setTitle(asset.title); setContent(asset.content ?? ""); setSaved(true); onChanged(asset); }
    catch (cause) { if (active()) setError(cause instanceof Error ? cause.message : "店铺资料未保存。"); }
    finally { if (active()) setSaving(false); }
  }
  return <dialog ref={dialog} className="asset-dialog campfire-shop-manager" aria-label="店铺管理" onCancel={event => { event.preventDefault(); if (!saving) onClose(); }}>
    <header className="asset-toolbar"><h2>店铺管理</h2><button type="button" disabled={saving} onClick={onClose}>关闭店铺管理</button></header>
    <div className="campfire-shop-layout">
      <nav className="campfire-shop-list" aria-label="店铺列表">
        <button type="button" className="primary" disabled={saving} onClick={() => { setSelectedId(""); setEditing(undefined); setTitle(""); setContent(""); setSaved(false); }}>＋ 新增店铺</button>
        {shops.map(shop => <button type="button" key={shop.id} aria-pressed={selectedId === shop.id} disabled={saving} onClick={() => setSelectedId(shop.id)}>{shop.title}</button>)}
        {loading && <p role="status">正在读取店铺…</p>}
        {!loading && !shops.length && <p>暂无店铺，先添加店铺资料。</p>}
        {cursor && <button type="button" disabled={loading || saving} onClick={() => { void load(cursor); }}>加载更多店铺</button>}
      </nav>
      <form className="asset-form campfire-shop-form" onSubmit={event => { void save(event); }}>
        <h3>{selectedId ? "店铺资料" : "新增店铺"}</h3>
        {reading && <p role="status">正在读取店铺资料…</p>}
        <label>店铺名称<input aria-label="店铺名称" value={title} onChange={event => { setTitle(event.target.value); setSaved(false); }} maxLength={120} required disabled={saving || reading || !!selectedId && !editing} placeholder="填写店铺名称" /></label>
        <label>店铺资料<textarea aria-label="店铺资料" value={content} onChange={event => { setContent(event.target.value); setSaved(false); }} maxLength={10000} rows={8} required disabled={saving || reading || !!selectedId && !editing} placeholder="地址、特色、商品与宣传信息" /></label>
        {error && <div role="alert"><p>{error}</p><button type="button" disabled={loading || saving} onClick={() => { void load(); setSaved(false); setRetry(current => current + 1); }}>重新加载</button></div>}
        {saved && <p role="status">店铺资料已保存</p>}
        <div className="campfire-shop-actions"><button type="submit" className="primary" disabled={saving || reading || !title.trim() || !content.trim() || !dirty || !!selectedId && !editing}>{saving ? "正在保存…" : selectedId ? "保存修改" : "保存店铺"}</button><button type="button" disabled={saving || reading || !editing || dirty} onClick={() => { if (editing) onUse(editing); }}>{useLabel}</button></div>
      </form>
    </div>
  </dialog>;
}
