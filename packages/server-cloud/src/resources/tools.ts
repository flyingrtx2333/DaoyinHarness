import type { ExecutionIdentity } from "@daoyin/harness-contracts";
import type { JsonValue } from "@daoyin/harness-protocol";
import type { CloudRun } from "../repository.js";
import type { CloudToolBinding } from "../app.js";
import { CloudError } from "../repository.js";
import { unixJson } from "../projects/wire.js";
import { RESOURCE_TOOL_NAMES, type ResourceControlRequest, type ResourceToolName } from "./contracts.js";

const object = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({ type: "object", additionalProperties: false, properties, required });
const id = { type: "string", pattern: "^(?:res|wsp|snp|art|dep|prc)_[a-f0-9]{24}$" };
const workspaceId = { type: "string", pattern: "^wsp_[a-f0-9]{24}$" };
const path = { type: "string", minLength: 1, maxLength: 512 };
const processMode = { type: "string", enum: ["foreground", "background", "pty"] };
const deploymentSpec = object({
  version: { type: "integer", const: 1 }, kind: { type: "string", const: "web-service" },
  command: object({ executable: { type: "string", minLength: 1, maxLength: 256 }, args: { type: "array", maxItems: 128, items: { type: "string", maxLength: 16000 } }, cwd: path }, ["executable", "args", "cwd"]),
  transport: { oneOf: [object({ kind: { type: "string", const: "tcp" }, port: { type: "integer", minimum: 1024, maximum: 65535 } }, ["kind", "port"]),
    object({ kind: { type: "string", const: "unix" }, path: { type: "string", const: "/run/app/app.sock" } }, ["kind", "path"])] },
  health: object({ path: { type: "string", pattern: "^/", maxLength: 256 }, timeoutSeconds: { type: "integer", minimum: 1, maximum: 120 } }, ["path", "timeoutSeconds"]),
  environment: { type: "object", additionalProperties: { type: "string", maxLength: 16000 } },
  resourceIds: { type: "array", maxItems: 16, uniqueItems: true, items: id },
}, ["version", "kind", "command", "transport", "health", "environment", "resourceIds"]);

export const RESOURCE_DEFINITIONS: Readonly<Record<ResourceToolName, { description: string; mutating: boolean; inputSchema: Record<string, unknown> }>> = {
  resource_list: { description: "List resources available to the account and resources attached to this session.", mutating: false, inputSchema: object({ sessionId: { type: "string", maxLength: 160 } }) },
  resource_attach: { description: "Attach an owned resource to the current session.", mutating: true, inputSchema: object({ resourceId: id }, ["resourceId"]) },
  resource_detach: { description: "Detach a resource from the current session without deleting it.", mutating: true, inputSchema: object({ resourceId: id }, ["resourceId"]) },
  workspace_create: { description: "Create a language- and task-neutral cloud workspace from an empty tree, Git source, upload or snapshot. Select node22, python313, go125 or rust190 with runtimeId; omit it to use the signed default image.", mutating: true, inputSchema: object({ title: { type: "string", minLength: 1, maxLength: 120 }, source: { type: "object" }, runtimeId: { type: "string", enum: ["node22", "python313", "go125", "rust190"] }, runtime: { type: "object" } }, ["title"]) },
  workspace_inspect: { description: "Inspect one attached workspace, runtime, limits and snapshots.", mutating: false, inputSchema: object({ workspaceId }, ["workspaceId"]) },
  workspace_snapshot: { description: "Create an immutable content-addressed snapshot of the current workspace.", mutating: true, inputSchema: object({ workspaceId }, ["workspaceId"]) },
  workspace_restore: { description: "Restore an attached workspace to one of its immutable snapshots.", mutating: true, inputSchema: object({ workspaceId, snapshotId: { type: "string", pattern: "^snp_[a-f0-9]{24}$" } }, ["workspaceId", "snapshotId"]) },
  file_list: { description: "List files and directories inside an attached workspace.", mutating: false, inputSchema: object({ workspaceId, path, glob: { type: "string", maxLength: 256 } }, ["workspaceId"]) },
  file_stat: { description: "Read file, directory or safe symlink metadata.", mutating: false, inputSchema: object({ workspaceId, path }, ["workspaceId", "path"]) },
  file_read: { description: "Read a bounded text range or return an artifact reference for binary content.", mutating: false, inputSchema: object({ workspaceId, path, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 }, maximumBytes: { type: "integer", minimum: 1, maximum: 1000000 } }, ["workspaceId", "path"]) },
  file_search: { description: "Search workspace paths or text using literal, regular expression or glob matching.", mutating: false, inputSchema: object({ workspaceId, query: { type: "string", minLength: 1, maxLength: 4000 }, searchMode: { type: "string", enum: ["literal", "regex", "glob"] }, path, glob: { type: "string", maxLength: 256 } }, ["workspaceId", "query", "searchMode"]) },
  file_write: { description: "Atomically create or replace a text or base64-encoded binary file.", mutating: true, inputSchema: object({ workspaceId, path, content: { type: "string", maxLength: 1000000 }, contentBase64: { type: "string", maxLength: 1400000 } }, ["workspaceId", "path"]) },
  file_patch: { description: "Apply an exact replacement or unified diff, rejecting stale or ambiguous context.", mutating: true, inputSchema: object({ workspaceId, path, expected: { type: "string", maxLength: 1000000 }, replacement: { type: "string", maxLength: 1000000 }, patch: { type: "string", maxLength: 1000000 } }, ["workspaceId"]) },
  file_mkdir: { description: "Create a directory inside an attached workspace.", mutating: true, inputSchema: object({ workspaceId, path }, ["workspaceId", "path"]) },
  file_move: { description: "Move a file or directory within one attached workspace.", mutating: true, inputSchema: object({ workspaceId, from: path, to: path }, ["workspaceId", "from", "to"]) },
  file_remove: { description: "Remove a workspace path. This never deletes snapshots or external resources.", mutating: true, inputSchema: object({ workspaceId, path }, ["workspaceId", "path"]) },
  git_status: { description: "Read Git working tree status.", mutating: false, inputSchema: object({ workspaceId }, ["workspaceId"]) },
  git_diff: { description: "Read a bounded Git diff.", mutating: false, inputSchema: object({ workspaceId, revision: { type: "string", maxLength: 200 } }, ["workspaceId"]) },
  git_log: { description: "Read bounded Git history.", mutating: false, inputSchema: object({ workspaceId, maximumBytes: { type: "integer", minimum: 1, maximum: 1000000 } }, ["workspaceId"]) },
  git_branch: { description: "Create or switch a local branch in an attached workspace.", mutating: true, inputSchema: object({ workspaceId, revision: { type: "string", minLength: 1, maxLength: 200 } }, ["workspaceId", "revision"]) },
  git_checkout: { description: "Checkout an existing revision in an attached workspace without accessing the host repository.", mutating: true, inputSchema: object({ workspaceId, revision: { type: "string", minLength: 1, maxLength: 200 } }, ["workspaceId", "revision"]) },
  git_commit: { description: "Create a local workspace commit. It does not push to a remote.", mutating: true, inputSchema: object({ workspaceId, message: { type: "string", minLength: 1, maxLength: 500 } }, ["workspaceId", "message"]) },
  git_export_patch: { description: "Export the current Git changes as an immutable patch artifact.", mutating: true, inputSchema: object({ workspaceId }, ["workspaceId"]) },
  process_run: { description: "Run a bounded foreground executable with an argument array inside the workspace gVisor sandbox.", mutating: true, inputSchema: object({ workspaceId, executable: { type: "string", minLength: 1, maxLength: 256 }, args: { type: "array", maxItems: 128, items: { type: "string", maxLength: 16000 } }, cwd: path, stdin: { type: "string", maxLength: 1000000 }, timeoutMs: { type: "integer", minimum: 100, maximum: 3600000 }, environment: { type: "object" } }, ["workspaceId", "executable", "args"]) },
  process_start: { description: "Start a background or PTY process inside the workspace gVisor sandbox.", mutating: true, inputSchema: object({ workspaceId, executable: { type: "string", minLength: 1, maxLength: 256 }, args: { type: "array", maxItems: 128, items: { type: "string", maxLength: 16000 } }, cwd: path, processMode, timeoutMs: { type: "integer", minimum: 100, maximum: 3600000 }, environment: { type: "object" } }, ["workspaceId", "executable", "args", "processMode"]) },
  process_read: { description: "Read incremental output from a workspace process by cursor.", mutating: false, inputSchema: object({ workspaceId, processId: { type: "string", pattern: "^prc_[a-f0-9]{24}$" }, cursor: { type: "integer", minimum: 0 } }, ["workspaceId", "processId"]) },
  process_write: { description: "Write bounded stdin to a running PTY process.", mutating: true, inputSchema: object({ workspaceId, processId: { type: "string", pattern: "^prc_[a-f0-9]{24}$" }, stdin: { type: "string", maxLength: 1000000 } }, ["workspaceId", "processId", "stdin"]) },
  process_stop: { description: "Stop a running workspace process and its process group.", mutating: true, inputSchema: object({ workspaceId, processId: { type: "string", pattern: "^prc_[a-f0-9]{24}$" }, signal: { type: "string", enum: ["TERM", "KILL", "INT"] } }, ["workspaceId", "processId"]) },
  process_list: { description: "List recent processes in an attached workspace.", mutating: false, inputSchema: object({ workspaceId }, ["workspaceId"]) },
  artifact_create: { description: "Create an immutable artifact from a workspace path. A deployable artifact must follow a workspace snapshot and include metadata.deployment with a structured web-service command, port and health check.", mutating: true, inputSchema: object({ workspaceId, path, title: { type: "string", minLength: 1, maxLength: 120 }, mediaType: { type: "string", minLength: 1, maxLength: 160 }, metadata: { type: "object", additionalProperties: true, properties: { deployment: deploymentSpec } } }, ["workspaceId", "path", "title", "mediaType"]) },
  artifact_read: { description: "Read artifact metadata and a bounded content reference.", mutating: false, inputSchema: object({ artifactId: { type: "string", pattern: "^art_[a-f0-9]{24}$" }, maximumBytes: { type: "integer", minimum: 1, maximum: 1000000 } }, ["artifactId"]) },
  artifact_list: { description: "List artifacts belonging to an attached workspace.", mutating: false, inputSchema: object({ workspaceId }, ["workspaceId"]) },
  deployment_create: { description: "Deploy an immutable snapshot-backed artifact to a managed HTTPS origin after an explicit current-turn request. The old route remains active until the candidate passes its health check.", mutating: true, inputSchema: object({ workspaceId, artifactId: { type: "string", pattern: "^art_[a-f0-9]{24}$" }, endpoint: { type: "string", pattern: "^https://", maxLength: 500 } }, ["workspaceId", "artifactId", "endpoint"]) },
  deployment_status: { description: "Read deployment state and health evidence.", mutating: false, inputSchema: object({ deploymentId: { type: "string", pattern: "^dep_[a-f0-9]{24}$" } }, ["deploymentId"]) },
  deployment_rollback: { description: "Roll back to a previous immutable deployment after an explicit current-turn request.", mutating: true, inputSchema: object({ deploymentId: { type: "string", pattern: "^dep_[a-f0-9]{24}$" } }, ["deploymentId"]) },
};

export const RESOURCE_INSTRUCTIONS = `Use resource and workspace tools for all cloud development and artifact tasks. A session may attach multiple resources; every file, Git and process call must name the intended workspaceId. Read before editing and use snapshots for durable checkpoints. Commands run only in the workspace gVisor sandbox and accept executable plus argument arrays, never host shell text. Public network access is available through the audited egress boundary; private, loopback, metadata and platform addresses remain forbidden. Never put credentials in files, arguments or messages. Git push, deployment, payment, external writes and destructive external actions require an explicit current-turn request. A command exit code, artifact digest, deployment health event or official evaluator is the evidence of completion; do not infer success from intent.`;

function owner(identity: ExecutionIdentity): { actor: string; space: string } {
  if (identity.space.kind === "public") throw new CloudError(403, "RESOURCE_ACCOUNT_REQUIRED", "Please sign in before using cloud resources.");
  return { actor: identity.actorUserId, space: JSON.stringify(identity.space) };
}

export async function resourceCall<T>(identity: ExecutionIdentity, input: ResourceControlRequest, signal?: AbortSignal): Promise<T> {
  if (!identity.permissions.includes("agent.use")) throw new CloudError(403, "RESOURCE_NOT_ENABLED", "Cloud resources are not enabled for this account.");
  try { return await unixJson("/run/daoyin-resources/control.sock", "/control", { ...input, owner: owner(identity), authorization: identity }, signal, 650_000); }
  catch (error) {
    const value = error as { code?: unknown; status?: unknown; message?: unknown };
    if (typeof value.code === "string" && typeof value.status === "number") throw new CloudError(value.status, value.code, typeof value.message === "string" ? value.message : "Resource operation failed.");
    throw error;
  }
}

export async function cancelResourceRun(identity: ExecutionIdentity, runId: string): Promise<void> {
  await resourceCall(identity, { action: "cancel_run", sourceRun: runId });
}

function explicitHighRisk(message: string, name: ResourceToolName): boolean {
  if (name === "deployment_create") return /(?:发布|部署|上线|deploy|publish)/iu.test(message) && !/(?:不要|禁止|暂不|先不).{0,12}(?:发布|部署|上线)/u.test(message);
  if (name === "deployment_rollback") return /(?:回滚|恢复到.{0,20}版本|rollback)/iu.test(message) && !/(?:不要|禁止|暂不|先不).{0,12}(?:回滚|恢复)/u.test(message);
  return true;
}

function basicInput(name: ResourceToolName, input: Record<string, unknown>): boolean {
  if (name.startsWith("file_") || name.startsWith("git_") || name.startsWith("process_") || name.startsWith("workspace_")) {
    if (name !== "workspace_create" && typeof input.workspaceId !== "string") return false;
  }
  if (name === "file_write" && (typeof input.content === "string") === (typeof input.contentBase64 === "string")) return false;
  if (name === "file_patch" && typeof input.patch !== "string" && !(typeof input.path === "string" && typeof input.expected === "string" && typeof input.replacement === "string")) return false;
  return Object.keys(input).every(key => !["owner", "authorization", "accountId", "actorUserId", "billingAccountId"].includes(key));
}

export function createResourceTools(identity: ExecutionIdentity, run: CloudRun, ensureActive: (identity: ExecutionIdentity, signal?: AbortSignal) => Promise<void>): CloudToolBinding[] {
  if (identity.space.kind === "public") return [];
  const deploymentMutationsEnabled = process.env.HARNESS_DEPLOYMENT_EXECUTOR_ENABLED === "1";
  return RESOURCE_TOOL_NAMES.filter(name => identity.allowedTools.includes(name) &&
    (deploymentMutationsEnabled || !["deployment_create", "deployment_rollback"].includes(name))).map(name => {
    const descriptor = RESOURCE_DEFINITIONS[name];
    return {
      definition: {
        name, description: descriptor.description, category: "extension", mutating: descriptor.mutating,
        inputSchema: descriptor.inputSchema as JsonValue,
        async execute(input, signal) {
          if (!explicitHighRisk(run.userMessage, name)) throw new CloudError(409, "EXPLICIT_INTENT_REQUIRED", "This operation requires an explicit current-turn request.");
          await ensureActive(identity, signal);
          const result = await resourceCall<Record<string, unknown>>(identity, { ...input, action: name, sessionId: run.sessionId, sourceRun: run.id, requestId: `${run.requestId}_${name}` } as ResourceControlRequest, signal);
          await ensureActive(identity, signal);
          return { ok: true, summary: typeof result.summary === "string" ? result.summary : `${name} completed.`, evidence: { schemaVersion: 1, toolName: name, result: result as JsonValue, artifacts: [], diagnostics: [] } };
        },
      },
      requiredPermissions: ["agent.use"],
      validateInput: input => basicInput(name, input),
      authorizeResource: async request => basicInput(name, request.input),
    } satisfies CloudToolBinding;
  });
}
