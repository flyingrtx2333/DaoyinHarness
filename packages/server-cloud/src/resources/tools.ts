import { createHash } from "node:crypto";
import type { ExecutionIdentity } from "@daoyin/harness-contracts";
import type { JsonValue, ToolEvidence, TaskEvidenceReference, AgentEventPayloads, WorkspaceVersion } from "@daoyin/harness-protocol";
import type { CloudRun } from "../repository.js";
import type { CloudToolBinding } from "../app.js";
import { CloudError } from "../repository.js";
import { unixJson } from "../projects/wire.js";
import { RESOURCE_TOOL_NAMES, type ResourceControlRequest, type ResourceToolName } from "./contracts.js";
import { CAMPFIRE_DEFINITIONS, CAMPFIRE_UI_ACTIONS, CAMPFIRE_INSTRUCTIONS } from "./campfire-contract.js";
import { validateStoryInput } from "../story-profile.js";

const object = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({ type: "object", additionalProperties: false, properties, required });
const id = { type: "string", pattern: "^(?:res|wsp|snp|art|dep|prc)_[a-f0-9]{24}$" };
const workspaceId = { type: "string", pattern: "^wsp_[a-f0-9]{24}$",
  description: "Use a real workspace ID from this session's attached resources or workspace_create; never invent one. Call resource_list if unknown." };
const WORKSPACE_PATH_PATTERN = "^(?!/)(?!.*\\\\)(?!.*:)(?!.*(?:^|/)\\.{1,2}(?:/|$)).{1,512}$";
const workspacePath = new RegExp(WORKSPACE_PATH_PATTERN, "u");
const path = { type: "string", minLength: 1, maxLength: 512, pattern: WORKSPACE_PATH_PATTERN,
  description: "Workspace-relative path, for example input.csv or src/app.py. No leading slash, dot segments, backslashes or drive letters. To list or search the workspace root, omit path." };
const cwd = { type: "string", pattern: "^(?:\\.|(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).{1,512})$" };
const verification = { type: "string", minLength: 1, maxLength: 160, description: "Name the stable verification scope for a focused check, for example parser regression. Reuse this name for repairs and reruns of the same scope. Select commands from the project and user requirements. Records intent; an installation or version probe is not validation. Observe the same process until actual exit. Success does not establish coverage." };
const processMode = { type: "string", enum: ["foreground", "background", "pty"] };
const workspaceSource = { oneOf: [
  object({ kind: { type: "string", const: "empty" } }, ["kind"]),
  object({ kind: { type: "string", const: "git" }, url: { type: "string", pattern: "^https://", maxLength: 2000 }, revision: { type: "string", minLength: 1, maxLength: 200 } }, ["kind", "url", "revision"]),
  object({ kind: { type: "string", const: "upload" }, artifactId: { type: "string", pattern: "^art_[a-f0-9]{24}$" } }, ["kind", "artifactId"]),
  object({ kind: { type: "string", const: "snapshot" }, snapshotId: { type: "string", pattern: "^snp_[a-f0-9]{24}$" } }, ["kind", "snapshotId"]),
] };
const deploymentSpec = object({
  version: { type: "integer", const: 1 }, kind: { type: "string", const: "web-service" },
  command: object({ executable: { type: "string", minLength: 1, maxLength: 256 }, args: { type: "array", maxItems: 128, items: { type: "string", maxLength: 16000 } }, cwd }, ["executable", "args", "cwd"]),
  transport: { oneOf: [object({ kind: { type: "string", const: "tcp" }, port: { type: "integer", minimum: 1024, maximum: 65535 } }, ["kind", "port"]),
    object({ kind: { type: "string", const: "unix" }, path: { type: "string", const: "/run/app/app.sock" } }, ["kind", "path"])] },
  health: object({ path: { type: "string", pattern: "^/", maxLength: 256 }, timeoutSeconds: { type: "integer", minimum: 1, maximum: 120 } }, ["path", "timeoutSeconds"]),
  environment: { type: "object", additionalProperties: { type: "string", maxLength: 16000 } },
  resourceIds: { type: "array", maxItems: 16, uniqueItems: true, items: id },
}, ["version", "kind", "command", "transport", "health", "environment", "resourceIds"]);

export const RESOURCE_DEFINITIONS: Readonly<Record<ResourceToolName, { description: string; mutating: boolean; inputSchema: Record<string, unknown> }>> = {
  ...CAMPFIRE_DEFINITIONS,
  resource_list: { description: "Discover real resource IDs available to the account and attached to this session. Use the attached workspace IDs for file, Git and process calls; never guess them.", mutating: false, inputSchema: object({ sessionId: { type: "string", maxLength: 160 } }) },
  resource_attach: { description: "Attach an owned resource to the current session.", mutating: true, inputSchema: object({ resourceId: id }, ["resourceId"]) },
  resource_detach: { description: "Detach a resource from the current session without deleting it.", mutating: true, inputSchema: object({ resourceId: id }, ["resourceId"]) },
  workspace_create: { description: "Create a task-neutral cloud workspace from an empty tree, credential-free HTTPS Git source at an explicit revision, upload artifact or snapshot. Select runtimeId from runtime_list; inspect project declarations before preparing a different environment.", mutating: true, inputSchema: object({ title: { type: "string", minLength: 1, maxLength: 120 }, source: workspaceSource, runtimeId: { type: "string", minLength: 1, maxLength: 80 } }, ["title", "source", "runtimeId"]) },
  runtime_list: { description: "List trusted runtime identifiers, image digests, configured versions and capabilities. A missing version is unknown; never invent catalog entries.", mutating: false, inputSchema: object({}) },
  environment_inspect: { description: "Read bounded project declarations as data and probe actual interpreter/package-manager versions in the selected isolated workspace. Does not execute configuration or assume compatibility.", mutating: false, inputSchema: object({ workspaceId }, ["workspaceId"]) },
  environment_prepare: { description: "Prepare a candidate workspace from an immutable snapshot without modifying the original. Select a trusted runtimeId, or a Dockerfile runtime whose FROM images are digest-pinned. Optionally install dependencies from detected project declarations. Returns one tracked operation ID; use environment_read to observe it, never relaunch an uncertain preparation. Success returns a new workspace ID.", mutating: true, inputSchema: object({ workspaceId, retryFromOperationId: { type: "string", pattern: "^op_[a-f0-9]{24}$", description: "Explicit retry of a previously observed failed or cancelled operation. Running or uncertain operations must be observed, not restarted." }, runtimeId: { type: "string", minLength: 1, maxLength: 80 }, runtime: object({ image: object({ kind: { const: "dockerfile", type: "string" }, path, context: cwd }, ["kind", "path", "context"]), environment: { type: "object", additionalProperties: { type: "string" } }, secretRefs: { type: "array", items: { type: "string" }, maxItems: 16 }, network: { type: "string", enum: ["public", "none"] }, limits: object({ cpu: { type: "number" }, memoryMiB: { type: "integer" }, pids: { type: "integer" }, diskMiB: { type: "integer" }, timeoutSeconds: { type: "integer" }, maxOutputBytes: { type: "integer" } }, ["cpu", "memoryMiB", "pids", "diskMiB", "timeoutSeconds", "maxOutputBytes"]) }, ["image", "environment", "secretRefs", "network", "limits"]), installDependencies: { type: "boolean" }, waitMs: { type: "integer", minimum: 0, maximum: 60000 } }, ["workspaceId"]) },
  environment_read: { description: "Observe the existing environment preparation operation with a bounded wait. Does not restart a build or dependency installation. Failed candidates preserve the original workspace.", mutating: false, inputSchema: object({ workspaceId, operationId: { type: "string", pattern: "^op_[a-f0-9]{24}$" }, waitMs: { type: "integer", minimum: 0, maximum: 60000 } }, ["workspaceId", "operationId"]) },
  workspace_inspect: { description: "Inspect one attached workspace, runtime, limits and snapshots.", mutating: false, inputSchema: object({ workspaceId }, ["workspaceId"]) },
  workspace_snapshot: { description: "Create an immutable content-addressed snapshot of the current workspace.", mutating: true, inputSchema: object({ workspaceId }, ["workspaceId"]) },
  workspace_restore: { description: "Restore an attached workspace to one of its immutable snapshots.", mutating: true, inputSchema: object({ workspaceId, snapshotId: { type: "string", pattern: "^snp_[a-f0-9]{24}$" } }, ["workspaceId", "snapshotId"]) },
  file_list: { description: "List files and directories inside an attached workspace. Omit path for the workspace root; never use / or . as path.", mutating: false, inputSchema: object({ workspaceId, path, glob: { type: "string", maxLength: 256 } }, ["workspaceId"]) },
  file_stat: { description: "Read file, directory or safe symlink metadata.", mutating: false, inputSchema: object({ workspaceId, path }, ["workspaceId", "path"]) },
  file_read: { description: "Read a bounded text range with its actual file digest. Locate symbols with file_search first, then read the relevant implementation and callers. Reuse available same-digest read receipts; overlapping reads report prior coverage without blocking a fresh read. Binary files and files over the text budget return size and digest without text; use artifact_create for binary content. Read an existing file before overwriting or patching it.", mutating: false, inputSchema: object({ workspaceId, path, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 }, maximumBytes: { type: "integer", minimum: 1, maximum: 1000000 } }, ["workspaceId", "path"]) },
  file_search: { description: "Search workspace paths or text using literal, regular expression or glob matching. Search named symbols or error text within a known path before scanning unrelated directories. Use regex for alternatives such as name1|name2; literal searches treat punctuation literally. Batch independent searches when their inputs are already known.", mutating: false, inputSchema: object({ workspaceId, query: { type: "string", minLength: 1, maxLength: 4000 }, searchMode: { type: "string", enum: ["literal", "regex", "glob"] }, path, glob: { type: "string", maxLength: 256 } }, ["workspaceId", "query", "searchMode"]) },
  file_write: { description: "Atomically create or replace a text or base64-encoded binary file. Read existing content first; the execution layer rejects unread or stale overwrites. Returns actual changed/no-op and bounded change evidence.", mutating: true, inputSchema: object({ workspaceId, path, content: { type: "string", maxLength: 1000000 }, contentBase64: { type: "string", maxLength: 1400000 } }, ["workspaceId", "path"]) },
  file_patch: { description: "Apply an exact replacement or strict unified text diff with a/path and b/path headers; no Git installation is needed. A unified diff can combine related hunks and files into one call after reading all targets. For renames use file_move; for binary content use file_write. Read each existing target first; reject stale versions, empty or ambiguous exact context. Returns actual changed/no-op and a bounded changed-region preview, not a correctness verdict.", mutating: true, inputSchema: object({ workspaceId, path, expected: { type: "string", maxLength: 1000000 }, replacement: { type: "string", maxLength: 1000000 }, patch: { type: "string", maxLength: 1000000 } }, ["workspaceId"]) },
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
  process_run: { description: "Start one tracked executable inside the gVisor sandbox and wait at most 60 seconds. timeoutMs bounds total process lifetime, waitMs bounds foreground observation. A running receipt returns the original processId; use process_read, never start the same command again. Omit cwd or use . for the workspace root; any other cwd must be workspace-relative.", mutating: true, inputSchema: object({ workspaceId, verification, executable: { type: "string", minLength: 1, maxLength: 256 }, args: { type: "array", maxItems: 128, items: { type: "string", maxLength: 16000 } }, cwd, stdin: { type: "string", maxLength: 1000000 }, timeoutMs: { type: "integer", minimum: 100, maximum: 3600000 }, waitMs: { type: "integer", minimum: 0, maximum: 60000 }, environment: { type: "object" } }, ["workspaceId", "executable", "args"]) },
  process_start: { description: "Start a background or PTY process inside the workspace gVisor sandbox. Use process_read with returned processId, cursor and bounded waitMs to observe new output and eventual exit; starting a process does not prove completion. Omit cwd or use . for the workspace root; any other cwd must be workspace-relative.", mutating: true, inputSchema: object({ workspaceId, verification, executable: { type: "string", minLength: 1, maxLength: 256 }, args: { type: "array", maxItems: 128, items: { type: "string", maxLength: 16000 } }, cwd, processMode, timeoutMs: { type: "integer", minimum: 100, maximum: 3600000 }, environment: { type: "object" } }, ["workspaceId", "executable", "args", "processMode"]) },
  process_read: { description: "Read incremental output from a workspace process using its returned cursor to avoid repeated logs. Agent reads wait up to 10000ms for new output or process exit when waitMs is omitted; set waitMs=0 for an immediate read, or at most 30000ms for a longer bounded wait. A running state is not evidence that the command completed.", mutating: false, inputSchema: object({ workspaceId, processId: { type: "string", pattern: "^prc_[a-f0-9]{24}$" }, cursor: { type: "integer", minimum: 0 }, waitMs: { type: "integer", minimum: 0, maximum: 30000 } }, ["workspaceId", "processId"]) },
  process_write: { description: "Write bounded stdin to a running PTY process.", mutating: true, inputSchema: object({ workspaceId, processId: { type: "string", pattern: "^prc_[a-f0-9]{24}$" }, stdin: { type: "string", maxLength: 1000000 } }, ["workspaceId", "processId", "stdin"]) },
  process_stop: { description: "Stop a running workspace process and its process group.", mutating: true, inputSchema: object({ workspaceId, processId: { type: "string", pattern: "^prc_[a-f0-9]{24}$" }, signal: { type: "string", enum: ["TERM", "KILL", "INT"] } }, ["workspaceId", "processId"]) },
  process_list: { description: "List recent processes in an attached workspace.", mutating: false, inputSchema: object({ workspaceId }, ["workspaceId"]) },
  artifact_create: { description: "Create an immutable artifact from a workspace path. A deployable artifact must follow a workspace snapshot and include metadata.deployment with a structured web-service command, port and health check.", mutating: true, inputSchema: object({ workspaceId, path, title: { type: "string", minLength: 1, maxLength: 120 }, mediaType: { type: "string", minLength: 1, maxLength: 160 }, metadata: { type: "object", additionalProperties: true, properties: { deployment: deploymentSpec } } }, ["workspaceId", "path", "title", "mediaType"]) },
  artifact_read: { description: "Read artifact metadata and exact base64 content in bounded byte ranges. Agent pages are at most 8192 bytes; use a smaller maximumBytes if model context truncates content. Continue from nextOffset until null when complete content is needed.", mutating: false, inputSchema: object({ artifactId: { type: "string", pattern: "^art_[a-f0-9]{24}$" }, offset: { type: "integer", minimum: 0 }, maximumBytes: { type: "integer", minimum: 1, maximum: 1000000 } }, ["artifactId"]) },
  artifact_list: { description: "List artifacts belonging to an attached workspace.", mutating: false, inputSchema: object({ workspaceId }, ["workspaceId"]) },
  deployment_create: { description: "Deploy an immutable snapshot-backed artifact to a managed HTTPS origin after an explicit current-turn request. The old route remains active until the candidate passes its health check.", mutating: true, inputSchema: object({ workspaceId, artifactId: { type: "string", pattern: "^art_[a-f0-9]{24}$" }, endpoint: { type: "string", pattern: "^https://", maxLength: 500 } }, ["workspaceId", "artifactId", "endpoint"]) },
  deployment_status: { description: "Read deployment state and health evidence.", mutating: false, inputSchema: object({ deploymentId: { type: "string", pattern: "^dep_[a-f0-9]{24}$" } }, ["deploymentId"]) },
  deployment_rollback: { description: "Roll back to a previous immutable deployment after an explicit current-turn request.", mutating: true, inputSchema: object({ deploymentId: { type: "string", pattern: "^dep_[a-f0-9]{24}$" } }, ["deploymentId"]) },
};

export const RESOURCE_INSTRUCTIONS = `Use resource and workspace tools for all cloud development and artifact tasks. A session may attach multiple resources; every file, Git and process call must name the intended workspaceId. Use IDs from the current attached-resource context or workspace_create; if unknown, first call resource_list and inspect attached, never invent an ID. File paths are workspace-relative, for example input.csv or src/app.py; omit path when listing or searching the workspace root, never use / or . as a file path. process cwd may be omitted or . for the workspace root. Use runtime_list to discover trusted runtimes. Inspect actual environment and project declarations with environment_inspect; select environment_prepare only when declarations or actual failures justify it, then observe the same operation with environment_read. Preparation returns a new workspace ID and preserves the source workspace. Unknown declarations or versions remain uncertain. Read before editing and use snapshots for durable checkpoints. Commands run only in the workspace gVisor sandbox and accept executable plus argument arrays, never host shell text. Each process_run or process_start creates a new container: the base image is read-only, /tmp is temporary, and /workspace including runtime-managed user dependencies and caches persists across commands. Public network access is available through the audited egress boundary; private, loopback, metadata and platform addresses remain forbidden. Never put credentials in files, arguments or messages. Git push, deployment, payment, external writes and destructive external actions require an explicit current-turn request. A command exit code, artifact digest, deployment health event or official evaluator is the evidence of completion; do not infer success from intent.

Work toward the requested outcome within the shared call and time budgets. Search named symbols or error text in relevant paths, then read bounded implementation, caller and verification ranges. Batch independent read-only observations whose inputs are already known. Reuse available same-digest observations rather than walking overlapping ranges one call at a time; omitted or truncated context is not available evidence, so retrieve only what is missing. Once evidence supports a concrete diagnosis, choose the smallest authorized change or check instead of continuing general exploration. Read-only tasks do not require a mutation. For related edits already understood, prefer one coherent unified patch over a separate model round for each hunk, and reserve capacity to inspect the diff and validate the result.

For code changes, inspect the environment and declared verification configuration before the first install or test. Select a focused check and its required dependencies from those declarations; record unfinished verification in task_plan for complex tasks. Mark that process with a stable verification scope name; reuse the name when repairing and rerunning that same check. Different scopes remain independently unresolved. Install success, file reads and completed plan steps are not validation. If a check fails, distinguish an actual code/test failure from dependency, interpreter, source-version metadata or network failure using its output. Inspect the missing evidence, change the responsible condition, and rerun the focused check; never repeat an identical failed install without new evidence, fabricate a version, weaken a declared minimum or skip the failing test to claim success. Runtime preparation returns a different workspace: confirm the actual candidate interpreter and continue editing and checking there. A later edit makes older checks stale; verify the final change, including affected callers and public data contracts. Preserve a concrete next check when allowance is insufficient.

For code changes, identify the existing callers and public data formats affected by the change. Preserve their compatibility unless the user requested a migration. Choose focused validation that covers the reported behavior and relevant existing behavior, rather than checking only the new path. File change receipts establish execution, not correctness. Follow the repository's declared runtime, dependency and verification configuration before installing packages; do not repeatedly improvise dependency versions or install the whole environment for one check. For lengthy commands use process_start and process_read with the returned cursor and bounded waitMs, observe actual exit and output, and keep time for the requested work and final validation. If a necessary environment condition cannot be established within the allowance, preserve the patch and report that concrete validation blocker.`;

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
  if (name === "resource_campfire_render") return /(?:制作|剪辑|重剪|生成(?:成片|视频|影片)|render)/iu.test(message) && !/(?:只读|先看方案|(?:不要|禁止|暂不|先不)[^，。；;\n]{0,8}(?:制作|剪辑|重剪|render|生成(?:成片|视频|影片)))/iu.test(message);
  if (name === "deployment_create") return /(?:发布|部署|上线|deploy|publish)/iu.test(message) && !/(?:不要|禁止|暂不|先不).{0,12}(?:发布|部署|上线)/u.test(message);
  if (name === "deployment_rollback") return /(?:回滚|恢复到.{0,20}版本|rollback)/iu.test(message) && !/(?:不要|禁止|暂不|先不).{0,12}(?:回滚|恢复)/u.test(message);
  return true;
}

function basicInput(name: ResourceToolName, input: Record<string, unknown>): boolean {
  if (Object.hasOwn(CAMPFIRE_DEFINITIONS, name)) return validateStoryInput(RESOURCE_DEFINITIONS[name].inputSchema, input);
  if (name.startsWith("file_") || name.startsWith("git_") || name.startsWith("process_") || name.startsWith("workspace_")) {
    if (name !== "workspace_create" && typeof input.workspaceId !== "string") return false;
  }
  if ((name === "process_run" || name === "process_start") && input.verification !== undefined && (typeof input.verification !== "string" || !input.verification.trim() || input.verification.length > 160)) return false;
  if (name.startsWith("environment_") && typeof input.workspaceId !== "string") return false;
  if (name === "environment_prepare" && (typeof input.runtimeId === "string") === (typeof input.runtime === "object" && input.runtime !== null)) return false;
  if (name === "file_write" && (typeof input.content === "string") === (typeof input.contentBase64 === "string")) return false;
  if (name === "file_patch" && typeof input.patch !== "string" && !(typeof input.path === "string" && typeof input.expected === "string" && typeof input.replacement === "string")) return false;
  return Object.keys(input).every(key => !["owner", "authorization", "accountId", "actorUserId", "billingAccountId"].includes(key));
}

const NETWORK_FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  EGRESS_UNAVAILABLE: "工作区的受控网络尚不可用，命令未能启动。当前轮次不再尝试启动该工作区的进程；需要先修复云端网络。",
  EGRESS_NETWORK_INSPECTION_FAILED: "无法核验工作区网络，命令未能启动。当前轮次不再尝试启动该工作区的进程。",
  WORKSPACE_SUBNET_POOL_INVALID: "云端工作区地址池配置无效，命令未能启动。需要先修复运行环境。",
  WORKSPACE_SUBNET_POOL_EXHAUSTED: "云端工作区网络地址池已耗尽，命令未能启动。需要先配置可用的工作区地址池。",
  WORKSPACE_NETWORK_CREATE_FAILED: "云端未能创建隔离网络，命令未能启动。需要先修复运行环境。",
  RESOURCE_AUDIT_PERSISTENCE_FAILED: "云端操作已返回，但完整证据未能保存；操作可能已完成。不要自动重复该操作，应先检查已有状态并修复证据存储或确认会话挂载的工作区。",
};

const RESOURCE_FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  FILE_NOT_OBSERVED: "目标文件已存在，但当前轮次没有可用于修改的最新读取回执。未执行本次修改；请先用 file_read 读取目标，再依据当前内容修改。",
  FILE_STALE_VERSION: "目标文件在读取后发生了变化，未执行本次修改。请重新读取目标并基于最新内容修改；不要原样重试旧编辑。",
  FILE_VERSION_INVALID: "修改携带的文件版本无效，未执行本次修改。请重新读取目标。",
  FILE_EDIT_LIMIT: "目标必须是 16 MiB 以内的普通文件，当前工具无法安全观察它；请使用适合该资源的能力。",
  PATCH_CONTEXT_CONFLICT: "目标文本缺失、为空或匹配不唯一，未执行本次替换。请读取正确范围，使用唯一的非空原文作为 expected。",
  PATCH_FORMAT_UNSUPPORTED: "补丁格式不受支持。file_patch 接受 a/ 与 b/ 路径头的统一文本补丁；重命名使用 file_move，二进制内容使用 file_write。",
  PATCH_WRITE_FAILED: "补丁保存失败，部分文件可能已经改变。先读取实际文件和已有回执，确认状态后再恢复；不要自动重放补丁。",
  PATCH_CONFLICT: "补丁未能通过路径检查或应用，未获得成功回执。请检查当前文件和补丁范围后修改，不要原样重复失败请求。",
  WORKSPACE_PATH_INVALID: "文件路径必须是工作区内的相对路径，例如 input.csv 或 src/app.py；不能使用 /、.、..、盘符或反斜杠。列出或搜索工作区根目录时省略 path；进程 cwd 可省略或使用 .。",
  WORKSPACE_PATH_ESCAPE: "路径超出了当前工作区边界，未执行操作。请使用工作区内的相对路径；不能通过父目录或链接访问工作区之外。",
  WORKSPACE_PATH_RESERVED: "该路径由工作区运行环境保护，不能读取或修改。请选择普通任务文件路径。",
  RESOURCE_ID_INVALID: "资源 ID 无效，未执行操作。请先调用 resource_list，使用 attached 中的真实工作区 ID，不要编造 ID。",
  RESOURCE_NOT_ATTACHED: "目标资源未挂载到当前会话，未执行操作。请调用 resource_list 核对当前 attached 资源和真实 ID。",
  RESOURCE_NOT_FOUND: "当前账号无法使用该资源，未执行操作。请调用 resource_list 核对当前账号和会话可用的真实资源 ID。",
  PROCESS_TIMEOUT: "命令超过执行时限，本次未获得成功结果。安装或写入可能已留下部分状态；请先检查工作区和已有结果，确认原因或改变执行条件后再决定下一步，不要原样重复同一长时间命令。",
  ENVIRONMENT_SOURCE_BUSY: "源工作区仍有运行中的进程，未捕获快照。先观察或停止原进程，再准备环境。",
  ENVIRONMENT_RETRY_REQUIRED: "之前的环境准备已失败或取消。先读取原 operationId 的真实结果，再以 retryFromOperationId 明确发起新尝试。",
  ENVIRONMENT_RETRY_DENIED: "原环境操作仍运行或结果不确定，不能重试；使用 environment_read 核对原操作。",
  ENVIRONMENT_OUTCOME_UNCERTAIN: "环境操作结果尚不能安全确定，未重复启动。使用 environment_read 观察已有 operationId。",
  PROCESS_OBSERVATION_FAILED: "暂时无法确认原进程的输出或状态，未重新启动进程。保留 processId 和 cursor，通过只读观察核对原进程；不能把观察失败当作命令失败或重复安装。",
};

function invalidWorkspacePath(name: ResourceToolName, input: Record<string, unknown>): boolean {
  if (!name.startsWith("file_") && name !== "artifact_create") return false;
  const required = RESOURCE_DEFINITIONS[name].inputSchema.required;
  return ["path", "from", "to"].some(key => {
    const value = input[key];
    if (value === undefined) return Array.isArray(required) && required.includes(key);
    return typeof value !== "string" || value.includes("\0") || !workspacePath.test(value);
  });
}

function sourceVersion(value: unknown): WorkspaceVersion | undefined {
  if (!value || typeof value !== "object") return undefined;
  const version = value as Record<string, unknown>;
  if (version.state === "known" && typeof version.digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(version.digest)) return { state: "known", digest: version.digest };
  if (version.state === "unknown" && typeof version.reason === "string") return { state: "unknown", reason: version.reason.slice(0, 160) };
  return undefined;
}

function resourceVerificationHint(name: ResourceToolName, input: Record<string, unknown>, result: Record<string, unknown>): ToolEvidence["verificationHint"] {
  const resourceId = input.workspaceId;
  if (typeof resourceId !== "string" || !/^wsp_[a-f0-9]{24}$/u.test(resourceId)) return undefined;
  if (name === "workspace_restore" || name === "git_checkout" || name === "git_branch") return { resourceId };
  if (!name.startsWith("file_") || !RESOURCE_DEFINITIONS[name].mutating) return undefined;
  const mutation = result.mutation as { changed?: boolean; changes?: Array<{ path?: unknown; changed?: boolean }> } | undefined;
  if (mutation?.changed === false) return undefined;
  // Only successful execution receipts identify changed paths. A unified patch
  // without a path receipt leaves its verification scope at the workspace.
  const paths = [...new Set([...(mutation?.changes ?? []).filter(change => change.changed).map(change => change.path),
    result.path, result.from, result.to].filter((value): value is string =>
    typeof value === "string" && value.length <= 512 && !value.includes("\0") && workspacePath.test(value)))].slice(0, 8);
  return { resourceId, ...(paths.length ? { paths } : {}) };
}

const CAMPFIRE_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  resource_campfire_list: "查询营火素材",
  resource_campfire_inspect: "查看真实素材",
  resource_campfire_music: "选择背景音乐",
  resource_campfire_narrate: "生成并测量旁白",
  resource_campfire_plan: "保存剪辑方案",
  resource_campfire_render: "制作营火成片",
  resource_campfire_status: "查询制作状态",
};

interface ReadRange { startLine: number; endLine: number }
interface FileReadCoverage { digest: string; ranges: ReadRange[] }

function mergedReadRanges(ranges: ReadRange[]): ReadRange[] {
  const merged: ReadRange[] = [];
  for (const range of [...ranges].sort((left, right) => left.startLine - right.startLine)) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.startLine <= previous.endLine + 1) previous.endLine = Math.max(previous.endLine, range.endLine);
    else merged.push({ ...range });
  }
  // Forget excess ranges rather than claiming that an unobserved gap was read.
  return merged.slice(-8);
}

export function createResourceTools(identity: ExecutionIdentity, run: CloudRun, ensureActive: (identity: ExecutionIdentity, signal?: AbortSignal) => Promise<void>,
  executionBudget?: { remainingTimeMs: () => number; closeoutReserveMs: number }): CloudToolBinding[] {
  if (identity.space.kind === "public") return [];
  const blockedProcessWorkspaces = new Map<string, string>();
  // Run-local observations only. Hashes come from receipts, never model input.
  const observedFiles = new Map<string, Map<string, string | null>>();
  const readCoverage = new Map<string, Map<string, FileReadCoverage>>();
  const deploymentMutationsEnabled = process.env.HARNESS_DEPLOYMENT_EXECUTOR_ENABLED === "1";
  return RESOURCE_TOOL_NAMES.filter(name => identity.allowedTools.includes(name) &&
    !CAMPFIRE_UI_ACTIONS.has(name) &&
    (deploymentMutationsEnabled || !["deployment_create", "deployment_rollback"].includes(name))).map(name => {
    const descriptor = RESOURCE_DEFINITIONS[name];
    // The execution adapter owns framing. Do not ask the model to invent a
    // competing value that it can later mistake for an execution discrepancy.
    const schema = name === "resource_campfire_plan" ? {
      ...descriptor.inputSchema,
      properties: Object.fromEntries(Object.entries(descriptor.inputSchema.properties as Record<string, unknown>).filter(([key]) => key !== "aspectRatio")),
      required: (descriptor.inputSchema.required as string[]).filter(key => key !== "aspectRatio"),
    } : descriptor.inputSchema;
    return {
      definition: {
        name, description: descriptor.description + (name === "resource_campfire_list" ? ` ${CAMPFIRE_INSTRUCTIONS}` : ""), category: "extension", mutating: descriptor.mutating,
        inputSchema: schema as JsonValue,
        failureVerificationResource: input => descriptor.mutating && typeof input.workspaceId === "string" && /^wsp_[a-f0-9]{24}$/u.test(input.workspaceId) ? input.workspaceId : undefined,
        ...(name === "environment_prepare" ? { auditInput: (input: Record<string, unknown>) => ({
          ...(typeof input.workspaceId === "string" && /^wsp_[a-f0-9]{24}$/u.test(input.workspaceId) ? { workspaceId: input.workspaceId } : {}),
          ...(typeof input.retryFromOperationId === "string" && /^op_[a-f0-9]{24}$/u.test(input.retryFromOperationId) ? { retryFromOperationId: input.retryFromOperationId } : {}),
          ...(typeof input.installDependencies === "boolean" ? { installDependencies: input.installDependencies } : {}),
          ...(typeof input.waitMs === "number" && Number.isSafeInteger(input.waitMs) && input.waitMs >= 0 && input.waitMs <= 60000 ? { waitMs: input.waitMs } : {}),
        }) } : {}),
        ...(CAMPFIRE_DISPLAY_NAMES[name] ? { displayName: CAMPFIRE_DISPLAY_NAMES[name], auditInput: () => ({}) } : {}),
        async execute(input, signal, context) {
          if (!explicitHighRisk(run.userMessage, name)) throw new CloudError(409, "EXPLICIT_INTENT_REQUIRED", "This operation requires an explicit current-turn request.");
          await ensureActive(identity, signal);
          if (invalidWorkspacePath(name, input)) return { ok: false, code: "WORKSPACE_PATH_INVALID", message: RESOURCE_FAILURE_MESSAGES.WORKSPACE_PATH_INVALID!, retryable: false };
          const startsProcess = name === "process_run" || name === "process_start";
          const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId : undefined;
          const blockedCode = startsProcess && workspaceId ? blockedProcessWorkspaces.get(workspaceId) : undefined;
          if (blockedCode) return { ok: false, code: blockedCode, message: NETWORK_FAILURE_MESSAGES[blockedCode]!, retryable: false };
          let boundedProcessInput = name === "process_read" ? { ...input, waitMs: input.waitMs ?? 10_000 } : input;
          if (executionBudget !== undefined && (startsProcess || name === "process_read")) {
            const remainingMs = executionBudget.remainingTimeMs();
            if (!Number.isFinite(remainingMs) || remainingMs < 0 || !Number.isSafeInteger(executionBudget.closeoutReserveMs) || executionBudget.closeoutReserveMs < 0) {
              throw new CloudError(500, "PROCESS_TIME_BUDGET_INVALID", "Process execution time budget is invalid.");
            }
            // Keep short checks available near the deadline; reserving the
            // maximum model timeout unconditionally would deny useful work.
            const reserveMs = Math.min(executionBudget.closeoutReserveMs, Math.floor(remainingMs / 3));
            const availableMs = Math.floor(remainingMs - reserveMs);
            if (startsProcess && availableMs < 100) return { ok: false, code: "PROCESS_BUDGET_INSUFFICIENT", retryable: false,
              message: "剩余运行时间需要保留给结果核对和收尾，未启动新进程。复用已有结果，明确尚未验证部分。" };
            if (startsProcess) boundedProcessInput = { ...input,
              timeoutMs: Math.min(typeof input.timeoutMs === "number" ? input.timeoutMs : availableMs, availableMs),
              ...(name === "process_run" ? { waitMs: Math.min(typeof input.waitMs === "number" ? input.waitMs : 60_000, 60_000, availableMs) } : {}) };
            else if (typeof boundedProcessInput.waitMs === "number") boundedProcessInput = { ...boundedProcessInput,
              waitMs: Math.min(boundedProcessInput.waitMs, Math.max(0, availableMs)) };
          }
          let result: Record<string, unknown>;
          try {
            // Output framing follows the current user's request, not a model guess
            // based on the source footage. Unspecified output always stays vertical.
            const requestedFraming = run.userMessage.replace(/(?:不要|不用|不做|非)\s*(?:横屏|方屏|正方形|16[:：]9|1[:：]1)/gu, "");
            const aspectRatio = /1[:：]1|方屏|正方形/u.test(requestedFraming) ? "1:1"
              : /16[:：]9|横屏/u.test(requestedFraming) ? "16:9" : "9:16";
            const executionInput = name === "resource_campfire_plan" ? { ...input, aspectRatio } : boundedProcessInput;
            const observed = workspaceId ? observedFiles.get(workspaceId) : undefined;
            const versionGuard = name === "file_write" || (name === "file_patch" && typeof input.patch !== "string")
              ? { expectedDigest: typeof input.path === "string" ? observed?.get(input.path) ?? null : null }
              : name === "file_patch" ? { expectedDigests: Object.fromEntries(observed ?? []) } : {};
            // Verification is adapter-owned intent; never change process execution semantics.
            const resourceInput = { ...executionInput };
            delete resourceInput.verification;
            result = await resourceCall<Record<string, unknown>>(identity, { ...resourceInput, ...versionGuard,
              ...(name === "process_run" ? { agentProcess: true } : {}),
              action: name, sessionId: run.sessionId, sourceRun: run.id, requestId: `${run.requestId}_${name}_${createHash("sha256").update(name === "environment_prepare" ? context.toolCallId ?? context.sourceEventIds.at(-1) ?? JSON.stringify(executionInput) : JSON.stringify(executionInput)).digest("hex").slice(0, 24)}` } as ResourceControlRequest, signal);
          } catch (error) {
            // Preserve only independently specified infrastructure failures. The
            // registry still hides all other remote errors and arbitrary text.
            if (signal?.aborted) throw error;
            if (!(error instanceof CloudError)) throw error;
            if (error.code.startsWith("CAMPFIRE_")) {
              await ensureActive(identity, signal);
              return { ok: false, code: error.code, message: error.message, retryable: false };
            }
            if (Object.hasOwn(RESOURCE_FAILURE_MESSAGES, error.code)) {
              await ensureActive(identity, signal);
              return { ok: false, code: error.code, message: RESOURCE_FAILURE_MESSAGES[error.code]!, retryable: false };
            }
            if (!Object.hasOwn(NETWORK_FAILURE_MESSAGES, error.code)) throw error;
            await ensureActive(identity, signal);
            if (workspaceId && (startsProcess || error.code === "RESOURCE_AUDIT_PERSISTENCE_FAILED")) blockedProcessWorkspaces.set(workspaceId, error.code);
            return { ok: false, code: error.code, message: NETWORK_FAILURE_MESSAGES[error.code]!, retryable: false };
          }
          if (name === "resource_campfire_plan") {
            // Explain the default in the actual tool receipt so normalization
            // cannot be mistaken for a gateway mismatch requiring user approval.
            result = { ...result, framingPolicy: "本轮用户未明确要求横屏或方形时，执行层应用默认9:16竖屏。这是正常默认行为，不是参数错误；无需再次确认画幅，直接继续制作。" };
          }
          await ensureActive(identity, signal);
          if (workspaceId) {
            if (["workspace_restore", "file_move", "file_remove", "git_checkout", "git_branch"].includes(name)) {
              observedFiles.delete(workspaceId);
              readCoverage.delete(workspaceId);
            }
            const observed = observedFiles.get(workspaceId) ?? new Map<string, string | null>();
            if (name === "file_read" && typeof result.path === "string" && typeof result.digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(result.digest)) {
              observed.set(result.path, result.digest);
              // Record actual complete text receipts, never requested ranges or
              // metadata-only/binary/truncated responses. Every read still runs.
              const { startLine, endLine } = result;
              if (typeof result.content === "string" && result.truncated !== true &&
                  typeof startLine === "number" && Number.isSafeInteger(startLine) && startLine >= 1 &&
                  typeof endLine === "number" && Number.isSafeInteger(endLine) && endLine >= startLine) {
                const filePath = result.path;
                const digest = result.digest;
                const files = readCoverage.get(workspaceId) ?? new Map<string, FileReadCoverage>();
                const earlier = files.get(filePath);
                const previousRanges = earlier?.digest === digest ? earlier.ranges : [];
                const coveredByPrevious = previousRanges.some(range => range.startLine <= startLine && range.endLine >= endLine);
                result = { ...result, readCoverage: { digest, previousRanges, coveredByPrevious,
                  notice: coveredByPrevious
                    ? "Earlier successful text receipts already cover this range at the same digest. Reuse their content when available; if current context omitted it, use this fresh result. Coverage is not correctness evidence."
                    : "Coverage lists bounded earlier successful text receipts at this digest, not a content cache or proof of correctness. Reuse available observations and read only missing context." } };
                files.set(filePath, { digest, ranges: mergedReadRanges([...previousRanges, { startLine, endLine }]) });
                if (files.size > 64) {
                  const oldestPath = files.keys().next().value;
                  if (oldestPath !== undefined) files.delete(oldestPath);
                }
                readCoverage.set(workspaceId, files);
              }
            }
            const mutation = result.mutation as { changes?: Array<{ path?: unknown; afterDigest?: unknown }> } | undefined;
            for (const change of mutation?.changes ?? []) {
              if (typeof change.path === "string" && (change.afterDigest === null ||
                (typeof change.afterDigest === "string" && /^sha256:[a-f0-9]{64}$/u.test(change.afterDigest)))) observed.set(change.path, change.afterDigest);
            }
            if (observed.size) observedFiles.set(workspaceId, observed);
          }
          const verificationHint = resourceVerificationHint(name, input, result);
          const operation = result.operation as { status?: unknown; result?: { originalWorkspaceId?: unknown; workspace?: { id?: unknown } } } | undefined;
          const targetId = operation?.result?.workspace?.id;
          const verificationWorkspace: ToolEvidence["verificationWorkspace"] =
            (name === "environment_prepare" || name === "environment_read") && operation?.status === "completed" &&
            workspaceId && operation.result?.originalWorkspaceId === workspaceId && typeof targetId === "string" && /^wsp_[a-f0-9]{24}$/u.test(targetId)
              ? { sourceResourceId: workspaceId, targetResourceId: targetId } : undefined;
          const processId = typeof result.processId === "string" ? result.processId : input.processId;
          const processObservation: ToolEvidence["processObservation"] = name.startsWith("process_") && workspaceId &&
            typeof processId === "string" && /^prc_[a-f0-9]{24}$/u.test(processId) && typeof (result.state ?? result.status) === "string"
            ? { resourceId: workspaceId, processId, state: String(result.state ?? result.status).slice(0, 40),
              exitCode: typeof result.exitCode === "number" && Number.isSafeInteger(result.exitCode) ? result.exitCode : null,
              verification: startsProcess && typeof input.verification === "string" ? input.verification.trim() : null,
              ...(sourceVersion(result.sourceVersionBefore) ? { sourceVersionBefore: sourceVersion(result.sourceVersionBefore)! } : {}),
              ...(sourceVersion(result.sourceVersionAfter) ? { sourceVersionAfter: sourceVersion(result.sourceVersionAfter)! } : {}) } : undefined;
          const version = sourceVersion(result.sourceVersionAfter);
          const workspaceVersion: ToolEvidence["workspaceVersion"] = workspaceId && version ? { resourceId: workspaceId, version } : undefined;
          const reference = result.fullResultArtifact;
          const artifactId = reference && typeof reference === "object" && !Array.isArray(reference)
            ? (reference as Record<string, unknown>).artifactId : undefined;
          const artifacts = typeof artifactId === "string" && /^art_[a-f0-9]{24}$/u.test(artifactId) ? [artifactId] : [];
          return { ok: true, summary: typeof result.summary === "string" ? result.summary : `${name} completed.`, evidence: { schemaVersion: 1, toolName: name, result: result as JsonValue, artifacts, diagnostics: [],
            ...(verificationHint === undefined ? {} : { verificationHint }),
            ...(verificationWorkspace === undefined ? {} : { verificationWorkspace }),
            ...(workspaceVersion === undefined ? {} : { workspaceVersion }),
            ...(processObservation === undefined ? {} : { processObservation }) } };
        },
      },
      requiredPermissions: ["agent.use"],
      validateInput: input => basicInput(name, input),
      authorizeResource: async request => basicInput(name, request.input),
    } satisfies CloudToolBinding;
  });
}

/** Read persisted facts only; notification delivery never launches a model request. */
export async function resourceRunEvidence(identity: ExecutionIdentity, run: CloudRun): Promise<{ evidenceText: string; pendingOperationIds: string[]; completions: AgentEventPayloads["process.completed"][] }> {
  const result = await resourceCall<{ processes: Array<{ processId: string; workspaceId: string; status: string; exitCode: number | null; finishedAt: string | null;
    receipt?: { digest?: string; cursor?: number; truncated?: boolean; sourceVersionBefore?: WorkspaceVersion; sourceVersionAfter?: WorkspaceVersion } }>; environments: Array<{ id: string; status: string }> }>(identity,
    { action: "run_evidence", sessionId: run.sessionId, sourceRun: run.id });
  const pendingOperationIds = [...result.processes.filter(item => ["starting", "running"].includes(item.status)).map(item => item.processId),
    ...result.environments.filter(item => ["queued", "running"].includes(item.status)).map(item => item.id)].slice(0, 96);
  const completions = result.processes.flatMap(item => {
    const status = item.status;
    if (!item.receipt?.digest || !["exited", "failed", "cancelled", "timed_out", "interrupted"].includes(status) || !item.finishedAt) return [];
    const finishedAt = Date.parse(item.finishedAt);
    if (!Number.isFinite(finishedAt)) return [];
    return [{ processId: item.processId, workspaceId: item.workspaceId,
      status: status as AgentEventPayloads["process.completed"]["status"], exitCode: item.exitCode,
      receiptDigest: item.receipt.digest, finishedAt, cursor: item.receipt.cursor ?? 0, truncated: item.receipt.truncated === true,
      ...(sourceVersion(item.receipt.sourceVersionBefore) ? { sourceVersionBefore: sourceVersion(item.receipt.sourceVersionBefore)! } : {}),
      ...(sourceVersion(item.receipt.sourceVersionAfter) ? { sourceVersionAfter: sourceVersion(item.receipt.sourceVersionAfter)! } : {}) }];
  });
  return { evidenceText: JSON.stringify(result).slice(0, 12_000), pendingOperationIds, completions };
}

export async function validateResourceEvidence(identity: ExecutionIdentity, run: CloudRun, reference: TaskEvidenceReference, signal?: AbortSignal): Promise<boolean> {
  if (reference.type !== "process" && reference.type !== "artifact") return false;
  try {
    const result = await resourceCall<{ valid: boolean }>(identity, { action: "evidence_validate", sessionId: run.sessionId,
      sourceRun: run.id, referenceId: reference.id, metadata: { type: reference.type } }, signal);
    return result.valid === true;
  } catch (error) {
    if (error instanceof CloudError && ["RESOURCE_NOT_ATTACHED", "ARTIFACT_NOT_FOUND", "PROCESS_NOT_FOUND", "RESOURCE_ID_INVALID", "RESOURCE_NOT_FOUND"].includes(error.code)) return false;
    throw error;
  }
}
