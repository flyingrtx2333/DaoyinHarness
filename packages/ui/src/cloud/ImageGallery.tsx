import { useEffect, useRef, useState } from "react";
import type { EventImage } from "./projection.js";
import "./image-gallery.css";

export function imagePath(image: EventImage, accountScope: string): string | null {
  if (!/^[a-f0-9]{64}$/u.test(accountScope) || !Number.isSafeInteger(image.id) || image.id < 1 || !Number.isSafeInteger(image.eventId) || image.eventId < 1 || !["material", "highlight", "video_preview"].includes(image.kind)) return null;
  return `/api/agent-apps/saishi/workbench/images/${accountScope}/${image.eventId}/${image.kind}/${image.id}`;
}

function Picture({ src, title }: { src: string; title: string }): React.JSX.Element {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  return <div className="event-picture" aria-busy={state === "loading"}>
    {state === "loading" && <span className="image-loading" role="status"><span className="spinner" />加载图片…</span>}
    {state === "error" ? <span className="image-error">图片暂不可用<button type="button" onClick={() => { setState("loading"); setAttempt(value => value + 1); }}>重新加载图片</button></span> :
      <img src={`${src}?attempt=${attempt}`} alt={title || "赛事图片"} loading="lazy" referrerPolicy="no-referrer" onLoad={() => setState("ready")} onError={() => setState("error")} />}
  </div>;
}

export function ImageGallery({ images, accountScope }: { images: readonly EventImage[]; accountScope: string }): React.JSX.Element {
  const [selected, setSelected] = useState<EventImage | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (selected) dialog.current?.showModal(); }, [selected]);
  const selectedPath = selected ? imagePath(selected, accountScope) : null;
  return <section className="event-gallery" aria-label="赛事图片">
    <div className="event-image-grid">{images.map(image => {
      const src = imagePath(image, accountScope);
      return src && <figure key={`${image.eventId}:${image.kind}:${image.id}`}>
        <Picture src={src} title={image.title} />
        <figcaption><span>{image.title || "赛事图片"}</span><button type="button" onClick={() => setSelected(image)} aria-label={`放大查看${image.title || "赛事图片"}`}>查看大图</button></figcaption>
      </figure>;
    })}</div>
    <dialog className="event-image-dialog" ref={dialog} aria-label="查看赛事图片" onClose={() => setSelected(null)} onClick={event => { if (event.target === dialog.current) dialog.current?.close(); }}>
      <div className="image-dialog-header"><span>{selected?.title || "赛事图片"}</span><button type="button" autoFocus onClick={() => dialog.current?.close()} aria-label="关闭图片">×</button></div>
      {selectedPath && selected && <Picture key={selectedPath} src={selectedPath} title={selected.title} />}
    </dialog>
  </section>;
}
