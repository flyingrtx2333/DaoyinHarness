import { useEffect, useState } from "react";
import type { ActivityView } from "./projection.js";

export function ToolActivity({ activities }: { activities: ActivityView[] }): React.JSX.Element {
  const [now, setNow] = useState(Date.now);
  const running = activities.some(activity => activity.status === "running");
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  return <div className="tools activity-timeline" role="log" aria-label="任务实时进度" aria-live="polite">{activities.map(activity => {
    const elapsed = Math.max(0, Math.floor(((activity.finishedAt ? Date.parse(activity.finishedAt) : now) - Date.parse(activity.startedAt)) / 1000));
    return <div className="tool-line" data-kind={activity.kind} data-status={activity.status} key={activity.id}>
      <span className="tool-status-icon" data-status={activity.status} aria-hidden="true" />
      <span>{activity.text}</span>{Number.isFinite(elapsed) && <span className="tool-elapsed" aria-hidden="true">{elapsed < 1 ? "<1 秒" : `${elapsed} 秒`}</span>}
    </div>;
  })}</div>;
}
