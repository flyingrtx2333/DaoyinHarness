import { useEffect, useState } from "react";
import { PluginCatalog } from "./PluginBrowser.js";
import { EvaluationClient } from "./evaluation-client.js";
import { EvaluationWorkbench } from "./EvaluationWorkbench.js";
import "./evaluation.css";

export function PluginWorkspace(props: React.ComponentProps<typeof PluginCatalog>): React.JSX.Element {
  const [client] = useState(() => new EvaluationClient());
  const [scope, setScope] = useState("");
  const [checking, setChecking] = useState(true);
  const [tab, setTab] = useState<"catalog" | "evaluation">(() => window.location.hash === "#plugins-evaluation" ? "evaluation" : "catalog");
  useEffect(() => {
    let stopped = false; let controller: AbortController | undefined;
    async function check(): Promise<void> {
      controller?.abort(); controller = new AbortController(); const current = controller;
      setChecking(true);
      try { await client.bootstrap(current.signal); if (!stopped && !current.signal.aborted) setScope(client.scope); }
      catch { if (!stopped && !current.signal.aborted) { client.reset(); setScope(""); } }
      finally { if (!stopped && !current.signal.aborted) setChecking(false); }
    }
    const focus = (): void => { if (document.visibilityState === "visible") void check(); };
    void check();
    const timer = window.setInterval(focus, 30_000);
    window.addEventListener("focus", focus); document.addEventListener("visibilitychange", focus);
    return () => { stopped = true; controller?.abort(); window.clearInterval(timer); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", focus); client.reset(); };
  }, [client]);
  function select(next: "catalog" | "evaluation"): void { setTab(next); window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#plugins${next === "evaluation" ? "-evaluation" : ""}`); }
  return <div className="plugin-workspace">
    {scope && <nav className="evaluation-tabs" aria-label="插件页面标签">
      <button type="button" aria-current={tab === "catalog" ? "page" : undefined} onClick={() => select("catalog")}>插件目录</button>
      <button type="button" aria-current={tab === "evaluation" ? "page" : undefined} onClick={() => select("evaluation")}>测试评估</button>
    </nav>}
    {tab === "catalog" && <PluginCatalog {...props} />}
    {tab === "evaluation" && checking && <p role="status">正在验证管理员身份…</p>}
    {tab === "evaluation" && scope && <div hidden={checking}><EvaluationWorkbench key={scope} client={client} onDenied={() => { client.reset(); setScope(""); }} /></div>}
    {tab === "evaluation" && !checking && !scope && <div className="evaluation-denied" role="alert"><p>测试评估仅向已验证的超级管理员开放。</p><p><a href="/login?redirect=%2Fharness%2F%23plugins-evaluation">登录道引账号</a></p><button type="button" onClick={() => select("catalog")}>返回插件目录</button></div>}
  </div>;
}
