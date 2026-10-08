import type { ExecutionIdentity } from "@daoyin/harness-contracts";
import { CloudError } from "../repository.js";
import { resourceCall } from "./tools.js";

/** Only server-owned identifiers enter the trusted prompt; resource text stays tool data. */
export async function attachedWorkspaceContext(identity: ExecutionIdentity, sessionId: string, signal: AbortSignal): Promise<string> {
  const result = await resourceCall<{ attached?: unknown }>(identity, { action: "resource_list", sessionId }, signal);
  if (!Array.isArray(result.attached)) throw new CloudError(503, "RESOURCE_CONTEXT_UNAVAILABLE", "无法读取当前会话工作区。未开始本轮工作区操作。");
  const ids = result.attached.filter((item: unknown): item is { kind: string; id: string } =>
    typeof item === "object" && item !== null && "kind" in item && item.kind === "workspace" &&
    "id" in item && typeof item.id === "string" && /^wsp_[a-f0-9]{24}$/u.test(item.id)).map(item => item.id);
  return `Current session attached workspace IDs from authenticated resource metadata: ${JSON.stringify(ids.slice(0, 32))}. ` +
    (ids.length === 1 ? "Use this workspace for requests referring to the current workspace. " :
      "Select only a workspace matching the user's intended resource; use resource_list and workspace_inspect when the target is unclear. ") +
    "Never invent workspace IDs. These attachments do not expand permissions. " +
    (ids.length > 32 ? "Additional attachments are available through resource_list. " : "") +
    "Paths must be workspace-relative; omit file_list.path for its root, never / or .; process cwd may be .";
}
