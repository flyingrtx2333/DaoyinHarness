import { useEffect, useRef, useState } from "react";
import type { WorkbenchClient } from "./client.js";
import { WorkbenchIcon } from "./WorkbenchIcon.js";
import { campfireUpload } from "./campfire-client.js";

export type StoryReference = { id: string; mimeType: string; name: string; size: number };

export function StoryUpload({ client, disabled, remaining, onUploaded, onBusy, onCampfire, campfireShopId }: {
  client: WorkbenchClient;
  disabled: boolean;
  remaining: number;
  onUploaded: (reference: StoryReference) => void;
  onBusy: (value: boolean) => void;
  onCampfire?: () => void;
  campfireShopId?: string;
}): React.JSX.Element {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent): void => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent): void => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [open]);

  async function upload(files: File[]): Promise<void> {
    if (!files.length || remaining <= 0) return;
    const epoch = client.accountScope;
    setBusy(true); onBusy(true); setError(""); setOpen(false);
    try {
      for (const file of files.slice(0, remaining)) {
        const asset = campfireShopId ? await campfireUpload(client, file, file.type === "video/mp4" ? "shop_video" : "shop_image", campfireShopId).then(value => ({ id: value.id, mime_type: value.mediaType })) : await client.uploadStory(file);
        if (epoch !== client.accountScope) throw new Error("账号已变化，请在当前账号重新上传。");
        onUploaded({ id: asset.id, mimeType: asset.mime_type, name: file.name, size: file.size });
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "上传未完成"); }
    finally { setBusy(false); onBusy(false); }
  }

  return <div className="composer-add" ref={root}>
    <input ref={imageInput} className="composer-file-input" tabIndex={-1} type="file" multiple accept="image/png,image/jpeg,image/webp" disabled={disabled || busy || remaining <= 0}
      aria-label="添加参考图片" onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ""; void upload(files); }} />
    <input ref={videoInput} className="composer-file-input" tabIndex={-1} type="file" multiple accept="video/mp4" disabled={disabled || busy || remaining <= 0}
      aria-label="添加参考视频" onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ""; void upload(files); }} />
    <button type="button" className="composer-add-button" disabled={disabled || busy || remaining <= 0} aria-label={busy ? "正在上传参考素材" : remaining <= 0 ? "最多添加 5 个参考素材" : "添加内容"}
      aria-expanded={open} aria-controls="composer-add-menu" onClick={() => { setError(""); setOpen(value => !value); }}>
      {busy ? <span className="spinner" /> : <WorkbenchIcon name="plus" />}
    </button>
    {open && <div id="composer-add-menu" className="composer-add-menu" role="menu" aria-label="添加内容">
      {onCampfire && <button type="button" role="menuitem" onClick={() => { setOpen(false); onCampfire(); }}><WorkbenchIcon name="story" /><span><b>营火能力</b><small>选择店铺素材与参考视频，实拍重剪</small></span></button>}
      <button type="button" role="menuitem" onClick={() => imageInput.current?.click()}><WorkbenchIcon name="image" /><span><b>{campfireShopId ? "本店实拍图片" : "图片"}</b><small>JPG、PNG、WebP，单张不超过 {campfireShopId ? 128 : 10}MB</small></span></button>
      <button type="button" role="menuitem" onClick={() => videoInput.current?.click()}><WorkbenchIcon name="story" /><span><b>{campfireShopId ? "本店实拍视频" : "视频"}</b><small>MP4，单个不超过 {campfireShopId ? 128 : 250}MB</small></span></button>
    </div>}
    {error && <p className="composer-upload-error" role="alert">{error}</p>}
  </div>;
}
