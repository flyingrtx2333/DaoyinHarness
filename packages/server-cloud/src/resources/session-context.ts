import type { ExecutionIdentity } from "@daoyin/harness-contracts";
import { CloudError } from "../repository.js";
import { resourceCall } from "./tools.js";

const unavailable = (): CloudError => new CloudError(503, "RESOURCE_CONTEXT_UNAVAILABLE", "无法读取当前会话工作区。未开始本轮工作区操作。");
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function limit(value: unknown, minimum: number, maximum: number, integer = true): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum ||
      (integer && !Number.isSafeInteger(value))) throw unavailable();
  return value;
}

/** Project authenticated manifest facts only; never serialize workspace-controlled text. */
function runtimeFacts(value: unknown, workspaceId: string): string {
  if (!record(value) || value.id !== workspaceId || value.kind !== "workspace" ||
      !["creating", "ready", "failed", "archived"].includes(typeof value.state === "string" ? value.state : "")) throw unavailable();
  const runtime = value.runtime;
  if (!record(runtime) || !record(runtime.image) || !record(runtime.limits) ||
      !["public", "none"].includes(typeof runtime.network === "string" ? runtime.network : "")) throw unavailable();
  const image = runtime.image;
  let imageFacts: { builtinId: string } | { imageDigest: string | null };
  if (image.kind === "builtin") {
    if (typeof image.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/u.test(image.id)) throw unavailable();
    imageFacts = { builtinId: image.id };
  } else if (image.kind === "dockerfile") {
    if (image.imageDigest !== undefined && (typeof image.imageDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(image.imageDigest))) throw unavailable();
    imageFacts = { imageDigest: typeof image.imageDigest === "string" ? image.imageDigest : null };
  } else throw unavailable();
  const limits = runtime.limits;
  const facts = { workspaceId, state: value.state, runtime: { image: imageFacts, network: runtime.network,
    limits: { cpu: limit(limits.cpu, Number.MIN_VALUE, 8, false), memoryMiB: limit(limits.memoryMiB, 128, 16_384),
      pids: limit(limits.pids, 16, 4096), diskMiB: limit(limits.diskMiB, 64, 102_400),
      timeoutSeconds: limit(limits.timeoutSeconds, 1, 3600), maxOutputBytes: limit(limits.maxOutputBytes, 1024, 16_000_000) } } };
  return `Authenticated workspace runtime manifest facts: ${JSON.stringify(facts)}. ` +
    "These manifest facts do not establish actual installed software versions or complete dependencies. " +
    "When needed for the user's goal, use bounded process evidence to check relevant versions and required dependencies; do not run environment checks for every task. ";
}

/** Only authenticated identifiers and bounded runtime facts enter the trusted prompt. */
export async function attachedWorkspaceContext(identity: ExecutionIdentity, sessionId: string, signal: AbortSignal): Promise<string> {
  if (!identity.allowedTools.includes("resource_list")) return "No general workspace access is granted. Use only the provided account-scoped capability tools; for native campfire media use resource_campfire_list to discover real asset IDs.";
  const result = await resourceCall<{ attached?: unknown }>(identity, { action: "resource_list", sessionId }, signal);
  if (!Array.isArray(result.attached)) throw unavailable();
  const ids = result.attached.filter((item: unknown): item is { kind: string; id: string } =>
    typeof item === "object" && item !== null && "kind" in item && item.kind === "workspace" &&
    "id" in item && typeof item.id === "string" && /^wsp_[a-f0-9]{24}$/u.test(item.id)).map(item => item.id);
  let environment = "";
  const workspaceId = ids[0];
  if (ids.length === 1 && workspaceId !== undefined && identity.allowedTools.includes("workspace_inspect")) {
    signal.throwIfAborted();
    const inspected = await resourceCall<unknown>(identity, { action: "workspace_inspect", sessionId, workspaceId, metadataOnly: true }, signal);
    signal.throwIfAborted();
    environment = runtimeFacts(record(inspected) ? inspected.workspace : undefined, workspaceId);
  }
  return `Current session attached workspace IDs from authenticated resource metadata: ${JSON.stringify(ids.slice(0, 32))}. ` +
    (ids.length === 1 ? "Use this workspace for requests referring to the current workspace. " :
      "Select only a workspace matching the user's intended resource; use resource_list and workspace_inspect when the target is unclear. ") +
    "Never invent workspace IDs. These attachments do not expand permissions. " +
    (ids.length > 32 ? "Additional attachments are available through resource_list. " : "") +
    environment +
    "Paths must be workspace-relative; omit file_list.path for its root, never / or .; process cwd may be .";
}
