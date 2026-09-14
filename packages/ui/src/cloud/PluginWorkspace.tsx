import { PluginCatalog } from "./PluginBrowser.js";
import "./evaluation.css";
export function PluginWorkspace(props: React.ComponentProps<typeof PluginCatalog>): React.JSX.Element {
  return <div className="plugin-workspace"><PluginCatalog {...props} /></div>;
}
