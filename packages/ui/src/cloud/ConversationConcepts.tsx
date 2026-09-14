import { useEffect, useState } from "react";
import type { WorkbenchClient } from "./client.js";
import "./conversation-concepts.css";

interface Project { id: string; title: string }
interface Concept { id: string; direction: "A" | "B" | "C"; title: string; strength: string; tradeoff: string }
interface ConceptSet {
  id: string;
  status: "generating" | "awaiting_selection" | "selected" | "superseded";
  selectedDirection: "A" | "B" | "C" | null;
  concepts: Concept[];
}
export function ConversationConcepts({ client, sessionId, refreshKey, busy, onChoose }: {
  client: WorkbenchClient;
  sessionId: string;
  refreshKey: string;
  busy: boolean;
  onChoose: (direction: "A" | "B" | "C") => void;
}): React.JSX.Element | null {
  const [result, setResult] = useState<{ project: Project; conceptSet: ConceptSet } | null>(null);
  const [poll, setPoll] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    if (!sessionId) { setResult(null); return () => controller.abort(); }
    void client.project<{ project: Project | null }>({ action: "bound", sessionId }).then(async bound => {
      if (!bound.project) return null;
      const response = await client.project<{ conceptSet: ConceptSet | null }>({ action: "concepts", projectId: bound.project.id });
      return response.conceptSet ? { project: bound.project, conceptSet: response.conceptSet } : null;
    }).then(value => { if (!controller.signal.aborted) setResult(value); }).catch(() => {
      if (!controller.signal.aborted) setResult(null);
    });
    return () => controller.abort();
  }, [client, sessionId, refreshKey, poll]);
  useEffect(() => {
    if (result?.conceptSet.status !== "generating") return;
    const timer = window.setTimeout(() => setPoll(value => value + 1), 2500);
    return () => window.clearTimeout(timer);
  }, [result?.conceptSet.status, poll]);
  if (!result || result.conceptSet.status === "superseded" || result.conceptSet.concepts.length === 0) return null;
  const { project, conceptSet } = result;
  return <section className="conversation-concepts" aria-label="界面方案图片">
    <div className="conversation-concept-heading">
      <strong>{conceptSet.status === "generating" ? `界面方案正在生成（${conceptSet.concepts.length}/3）` : "请选择界面方案"}</strong>
      <span>{project.title}</span>
    </div>
    <div className="conversation-concept-grid">{conceptSet.concepts.map(concept => <article key={concept.id}
      className={conceptSet.selectedDirection === concept.direction ? "selected" : ""}>
      <img src={client.projectConceptImage(project.id, concept.id)} alt={`方案 ${concept.direction}：${concept.title}`} loading="lazy" />
      <div><strong>{concept.direction} · {concept.title}</strong><p>{concept.strength}</p><small>取舍：{concept.tradeoff}</small>
        {conceptSet.status === "awaiting_selection" && <button type="button" className="primary" disabled={busy}
          onClick={() => onChoose(concept.direction)}>选择 {concept.direction}</button>}
      </div>
    </article>)}</div>
  </section>;
}
