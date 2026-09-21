import { useEffect, useState } from "react";
import type { WorkbenchClient } from "./client.js";
import "./conversation-preview.css";

interface Resource { id: string; kind: string; title: string }
interface Deployment { id: string; status: string; endpoint: string | null }

export function ConversationResourcePreview({ client, sessionId }: { client: WorkbenchClient; sessionId: string }): React.JSX.Element | null {
  const [state, setState] = useState<{ workspace: Resource; deployment: Deployment }>();
  useEffect(() => {
    let disposed = false;
    void client.resource<{ attached: Resource[] }>({ action: "resource_list", sessionId }).then(async ({ attached }) => {
      const workspace = attached.find((item) => item.kind === "workspace"); if (!workspace) return undefined;
      const inspected = await client.resource<{ deployments: Deployment[] }>({ action: "workspace_inspect", sessionId, workspaceId: workspace.id });
      const deployment = inspected.deployments.find((item) => item.status === "healthy" && item.endpoint);
      return deployment ? { workspace, deployment } : undefined;
    }).then((value) => { if (!disposed) setState(value); }).catch(() => undefined);
    return () => { disposed = true; };
  }, [client, sessionId]);
  if (!state?.deployment.endpoint) return null;
  return <section className="conversation-preview" aria-label="运行预览"><header><div><strong>运行预览</strong><span>{state.workspace.title}</span></div>
    <a href={state.deployment.endpoint} target="_blank" rel="noreferrer">打开 ↗</a></header>
    <iframe title={`${state.workspace.title} 运行预览`} src={state.deployment.endpoint} sandbox="allow-scripts allow-forms allow-same-origin allow-downloads" referrerPolicy="no-referrer" />
  </section>;
}
