import { useEffect, useRef, useState } from "react";
import { buildVideoCreationMessage, type VideoCreationRequest } from "./video-creation-intent.js";

export function VideoCreationDialog({ initialRequest, onClose, onConfirm }: {
  initialRequest: string;
  onClose: () => void;
  onConfirm: (message: string) => void;
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const content = useRef<HTMLTextAreaElement>(null);
  const [request, setRequest] = useState<VideoCreationRequest>({
    mode: "quick",
    title: "",
    content: initialRequest,
    aspectRatio: "16:9",
    duration: "10",
    resolution: "720p",
    voiceover: "",
    music: "",
    notes: "",
  });
  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current;
    element?.showModal(); content.current?.focus(); content.current?.select();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  function update<K extends keyof VideoCreationRequest>(key: K, value: VideoCreationRequest[K]): void {
    setRequest(current => ({ ...current, [key]: value }));
  }
  return <dialog ref={dialog} className="video-creation-dialog" aria-labelledby="video-creation-title"
    aria-describedby="video-creation-note" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <form onSubmit={(event) => { event.preventDefault(); if (request.content.trim()) onConfirm(buildVideoCreationMessage(request)); }}>
      <header><div><span className="dialog-kicker">Story 制作</span><h2 id="video-creation-title">创建视频</h2></div>
        <button type="button" className="plugin-close" aria-label="关闭视频制作表单" onClick={onClose}>×</button></header>
      <div className="video-field-grid">
        <label className="video-field"><span>制作类型</span><select value={request.mode}
          onChange={(event) => { const mode = event.target.value as VideoCreationRequest["mode"];
            setRequest(current => ({ ...current, mode, aspectRatio: mode === "drama" ? "9:16" : "16:9",
              duration: mode === "drama" ? "60" : "10", resolution: mode === "drama" ? "768p" : "720p" })); }}>
          <option value="quick">快速视频片段</option><option value="drama">完整短剧成片</option>
        </select></label>
        {request.mode === "drama" && <label className="video-field"><span>项目名称 <small>选填</small></span>
          <input value={request.title} maxLength={120} placeholder="例如：逆风翻盘"
            onChange={(event) => update("title", event.target.value)} /></label>}
      </div>
      <label className="video-field video-content"><span>画面内容 <b>必填</b></span>
        <textarea ref={content} required maxLength={3000} rows={4} value={request.content}
          onChange={(event) => update("content", event.target.value)} /></label>
      <div className="video-field-grid">
        <label className="video-field"><span>画幅</span><select value={request.aspectRatio}
          onChange={(event) => update("aspectRatio", event.target.value as VideoCreationRequest["aspectRatio"])}>
          <option value="16:9">横屏 16:9</option><option value="9:16">竖屏 9:16</option>
          {request.mode === "quick" && <option value="1:1">方形 1:1</option>}
        </select></label>
        <label className="video-field"><span>时长</span><select value={request.duration}
          onChange={(event) => update("duration", event.target.value as VideoCreationRequest["duration"])}>
          {request.mode === "quick" ? <><option value="4">4 秒</option><option value="5">5 秒</option><option value="10">10 秒</option><option value="15">15 秒</option></>
            : <><option value="30">30 秒</option><option value="60">60 秒</option><option value="90">90 秒</option></>}
        </select></label>
        <label className="video-field"><span>清晰度</span><select value={request.resolution}
          onChange={(event) => update("resolution", event.target.value as VideoCreationRequest["resolution"])}>
          <option value="auto">按模型推荐</option><option value="480p">480p</option>
          {request.mode === "quick" && <option value="720p">720p</option>}
          {request.mode === "drama" && <option value="768p">768p</option>}
          <option value="1080p">1080p</option>
        </select></label>
      </div>
      <div className="video-field-grid video-field-grid-wide">
        <label className="video-field"><span>配音或旁白 <small>选填</small></span><input value={request.voiceover}
          placeholder="例如：激昂男声，结尾品牌口播" maxLength={500} onChange={(event) => update("voiceover", event.target.value)} /></label>
        <label className="video-field"><span>背景音乐 <small>选填</small></span><input value={request.music}
          placeholder="例如：高燃电子鼓点" maxLength={300} onChange={(event) => update("music", event.target.value)} /></label>
      </div>
      <label className="video-field"><span>其他要求 <small>选填</small></span><input value={request.notes}
        placeholder="项目、镜头、字幕、品牌露出等" maxLength={800} onChange={(event) => update("notes", event.target.value)} /></label>
      <p id="video-creation-note" className="video-creation-note">{request.mode === "drama"
        ? "提交即确认启动完整短剧任务；系统会在后台持续生成并保留可恢复进度，费用使用当前账号额度。"
        : "提交后将查询当前账号可用模型，并按当前账号额度生成。"}</p>
      <footer><button type="button" onClick={onClose}>返回修改</button><button type="submit" className="primary">提交生成请求</button></footer>
    </form>
  </dialog>;
}
