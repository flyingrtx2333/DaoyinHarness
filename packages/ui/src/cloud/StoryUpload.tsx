import { useState } from "react";
import type { WorkbenchClient } from "./client.js";
export function StoryUpload({ client, disabled, onUploaded, onBusy }: { client: WorkbenchClient; disabled: boolean; onUploaded: (text: string) => void; onBusy: (value: boolean) => void }): React.JSX.Element {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function upload(file: File): Promise<void> {
    const epoch = client.accountScope;
    setBusy(true); onBusy(true); setError("");
    try {
      const asset = await client.uploadStory(file);
      if (epoch !== client.accountScope) throw new Error("账号已变化，请在当前账号重新上传。");
      onUploaded(`\n[已上传参考${asset.mime_type === "video/mp4" ? "视频" : "图片"}，素材 ID：${asset.id}]`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "上传未完成"); }
    finally { setBusy(false); onBusy(false); }
  }
  return <div><label>{busy ? "正在上传…" : "上传参考图片或视频"}<input type="file" accept="image/png,image/jpeg,image/webp,video/mp4" disabled={disabled || busy}
    onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file); }} /></label>
    {error && <p role="alert">{error}</p>}</div>;
}
