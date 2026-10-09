import type { AgentEvent } from "@daoyin/harness-protocol";

/** Preserve historical quote evidence without offering retired generation actions. */
export function CampfireSupplements({ events, runId }: { events: AgentEvent[]; runId: string }): React.JSX.Element | null {
  const hasQuote = events.some(event => event.turnId === runId && event.type === "tool.completed" && event.payload.toolName === "resource_campfire_supplement_quote");
  return hasQuote ? <section className="asset-form campfire-supplement" aria-label="历史补镜头报价已停用">
    <h3>只用已有素材剪辑</h3>
    <p>这条历史 AI 补镜头报价已停用，不能确认或提交生成。请使用已有店铺素材调整剪辑方案；缺失画面需上传实拍。</p>
  </section> : null;
}
