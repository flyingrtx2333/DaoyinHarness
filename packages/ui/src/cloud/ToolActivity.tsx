import { useEffect, useState } from "react";
import type { ToolView } from "./projection.js";

export function ToolActivity({ tools }: { tools: ToolView[] }): React.JSX.Element {
  const [now, setNow] = useState(Date.now);
  const running = tools.some(tool => tool.status === "running");
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  return <div className="tools" role="log" aria-label="工具执行进度" aria-live="polite">{tools.map(tool => {
    const elapsed = Math.max(0, Math.floor(((tool.finishedAt ? Date.parse(tool.finishedAt) : now) - Date.parse(tool.startedAt)) / 1000));
    return <div className="tool-line" data-status={tool.status} key={tool.id}>
      {tool.status === "running" ? <span className="spinner" aria-hidden="true" /> : <span aria-hidden="true">{tool.status === "completed" ? "✓" : "!"}</span>}
      <span>{tool.text}</span>{Number.isFinite(elapsed) && <span className="tool-elapsed" aria-hidden="true">{elapsed} 秒</span>}
    </div>;
  })}</div>;
}
