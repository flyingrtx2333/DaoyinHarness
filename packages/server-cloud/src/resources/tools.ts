import type { ExecutionIdentity } from "@daoyin/harness-contracts";
import type { JsonValue, ToolEvidence } from "@daoyin/harness-protocol";
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
  workspace_create: { description: "Create a language- and task-neutral cloud workspace from an empty tree, credential-free HTTPS Git source at an explicit revision, upload artifact or existing snapshot. runtimeId is required: choose node22, python313, go125 or rust190; use node22 only when no language was requested.", mutating: true, inputSchema: object({ title: { type: "string", minLength: 1, maxLength: 120 }, source: workspaceSource, runtimeId: { type: "string", enum: ["node22", "python313", "go125", "rust190"] } }, ["title", "source", "runtimeId"]) },
  workspace_inspect: { description: "Inspect one attached workspace, runtime, limits and snapshots.", mutating: false, inputSchema: object({ workspaceId }, ["workspaceId"]) },
  workspace_snapshot: { description: "Create an immutable content-addressed snapshot of the current workspace.", mutating: true, inputSchema: object({ workspaceId }, ["workspaceId"]) },
  workspace_restore: { description: "Restore an attached workspace to one of its immutable snapshots.", mutating: true, inputSchema: object({ workspaceId, snapshotId: { type: "string", pattern: "^snp_[a-f0-9]{24}$" } }, ["workspaceId", "snapshotId"]) },
  file_list: { description: "List files and directories inside an attached workspace. Omit path for the workspace root; never use / or . as path.", mutating: false, inputSchema: object({ workspaceId, path, glob: { type: "string", maxLength: 256 } }, ["workspaceId"]) },
  file_stat: { description: "Read file, directory or safe symlink metadata.", mutating: false, inputSchema: object({ workspaceId, path }, ["workspaceId", "path"]) },
  file_read: { description: "Read a bounded text range with its actual file digest, or return an artifact reference for binary content. Read an existing file before overwriting or patching it.", mutating: false, inputSchema: object({ workspaceId, path, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 }, maximumBytes: { type: "integer", minimum: 1, maximum: 1000000 } }, ["workspaceId", "path"]) },
  file_search: { description: "Search workspace paths or text using literal, regular expression or glob matching.", mutating: false, inputSchema: object({ workspaceId, query: { type: "string", minLength: 1, maxLength: 4000 }, searchMode: { type: "string", enum: ["literal", "regex", "glob"] }, path, glob: { type: "string", maxLength: 256 } }, ["workspaceId", "query", "searchMode"]) },
  file_write: { description: "Atomically create or replace a text or base64-encoded binary file. Read existing content first; the execution layer rejects unread or stale overwrites. Returns actual changed/no-op and bounded change evidence.", mutating: true, inputSchema: object({ workspaceId, path, content: { type: "string", maxLength: 1000000 }, contentBase64: { type: "string", maxLength: 1400000 } }, ["workspaceId", "path"]) },
  file_patch: { description: "Apply an exact replacement or unified diff. Read each existing target first; reject stale versions, empty or ambiguous exact context. Returns actual changed/no-op and a bounded changed-region preview, not a correctness verdict.", mutating: true, inputSchema: object({ workspaceId, path, expected: { type: "string", maxLength: 1000000 }, replacement: { type: "string", maxLength: 1000000 }, patch: { type: "string", maxLength: 1000000 } }, ["workspaceId"]) },
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
  process_run: { description: "Run a bounded foreground executable with an argument array inside the workspace gVisor sandbox. Omit cwd or use . for the workspace root; any other cwd must be workspace-relative.", mutating: true, inputSchema: object({ workspaceId, executable: { type: "string", minLength: 1, maxLength: 256 }, args: { type: "array", maxItems: 128, items: { type: "string", maxLength: 16000 } }, cwd, stdin: { type: "string", maxLength: 1000000 }, timeoutMs: { type: "integer", minimum: 100, maximum: 3600000 }, environment: { type: "object" } }, ["workspaceId", "executable", "args"]) },
  process_start: { description: "Start a background or PTY process inside the workspace gVisor sandbox. Omit cwd or use . for the workspace root; any other cwd must be workspace-relative.", mutating: true, inputSchema: object({ workspaceId, executable: { type: "string", minLength: 1, maxLength: 256 }, args: { type: "array", maxItems: 128, items: { type: "string", maxLength: 16000 } }, cwd, processMode, timeoutMs: { type: "integer", minimum: 100, maximum: 3600000 }, environment: { type: "object" } }, ["workspaceId", "executable", "args", "processMode"]) },
  process_read: { description: "Read incremental output from a workspace process by cursor.", mutating: false, inputSchema: object({ workspaceId, processId: { type: "string", pattern: "^prc_[a-f0-9]{24}$" }, cursor: { type: "integer", minimum: 0 } }, ["workspaceId", "processId"]) },
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

export const RESOURCE_INSTRUCTIONS = `Use resource and workspace tools for all cloud development and artifact tasks. A session may attach multiple resources; every file, Git and process call must name the intended workspaceId. Use IDs from the current attached-resource context or workspace_create; if unknown, first call resource_list and inspect attached, never invent an ID. File paths are workspace-relative, for example input.csv or src/app.py; omit path when listing or searching the workspace root, never use / or . as a file path. process cwd may be omitted or . for the workspace root. workspace_create always requires runtimeId: Node.js uses node22, Python uses python313, Go uses go125 and Rust uses rust190; choose node22 only when the user did not specify a language. Read before editing and use snapshots for durable checkpoints. Commands run only in the workspace gVisor sandbox and accept executable plus argument arrays, never host shell text. Each process_run or process_start creates a new container: the base image is read-only, /tmp is temporary, and /workspace including runtime-managed user dependencies and caches persists across commands. Public network access is available through the audited egress boundary; private, loopback, metadata and platform addresses remain forbidden. Never put credentials in files, arguments or messages. Git push, deployment, payment, external writes and destructive external actions require an explicit current-turn request. A command exit code, artifact digest, deployment health event or official evaluator is the evidence of completion; do not infer success from intent.`;

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
  PATCH_CONFLICT: "补丁未能通过路径检查或应用，未获得成功回执。请检查当前文件和补丁范围后修改，不要原样重复失败请求。",
  WORKSPACE_PATH_INVALID: "文件路径必须是工作区内的相对路径，例如 input.csv 或 src/app.py；不能使用 /、.、..、盘符或反斜杠。列出或搜索工作区根目录时省略 path；进程 cwd 可省略或使用 .。",
  WORKSPACE_PATH_ESCAPE: "路径超出了当前工作区边界，未执行操作。请使用工作区内的相对路径；不能通过父目录或链接访问工作区之外。",
  WORKSPACE_PATH_RESERVED: "该路径由工作区运行环境保护，不能读取或修改。请选择普通任务文件路径。",
  RESOURCE_ID_INVALID: "资源 ID 无效，未执行操作。请先调用 resource_list，使用 attached 中的真实工作区 ID，不要编造 ID。",
  RESOURCE_NOT_ATTACHED: "目标资源未挂载到当前会话，未执行操作。请调用 resource_list 核对当前 attached 资源和真实 ID。",
  RESOURCE_NOT_FOUND: "当前账号无法使用该资源，未执行操作。请调用 resource_list 核对当前账号和会话可用的真实资源 ID。",
  PROCESS_TIMEOUT: "命令超过执行时限，本次未获得成功结果。安装或写入可能已留下部分状态；请先检查工作区和已有结果，确认原因或改变执行条件后再决定下一步，不要原样重复同一长时间命令。",
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

function resourceVerificationHint(name: ResourceToolName, input: Record<string, unknown>, result: Record<string, unknown>): ToolEvidence["verificationHint"] {
  const resourceId = input.workspaceId;
  if (typeof resourceId !== "string" || !/^wsp_[a-f0-9]{24}$/u.test(resourceId)) return undefined;
  if (name === "workspace_restore") return { resourceId };
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

export function createResourceTools(identity: ExecutionIdentity, run: CloudRun, ensureActive: (identity: ExecutionIdentity, signal?: AbortSignal) => Promise<void>): CloudToolBinding[] {
  if (identity.space.kind === "public") return [];
  const blockedProcessWorkspaces = new Map<string, string>();
  // Run-local observations only. Hashes come from receipts, never model input.
  const observedFiles = new Map<string, Map<string, string | null>>();
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
        ...(CAMPFIRE_DISPLAY_NAMES[name] ? { displayName: CAMPFIRE_DISPLAY_NAMES[name], auditInput: () => ({}) } : {}),
        async execute(input, signal) {
          if (!explicitHighRisk(run.userMessage, name)) throw new CloudError(409, "EXPLICIT_INTENT_REQUIRED", "This operation requires an explicit current-turn request.");
          await ensureActive(identity, signal);
          if (invalidWorkspacePath(name, input)) return { ok: false, code: "WORKSPACE_PATH_INVALID", message: RESOURCE_FAILURE_MESSAGES.WORKSPACE_PATH_INVALID!, retryable: false };
          const startsProcess = name === "process_run" || name === "process_start";
          const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId : undefined;
          const blockedCode = startsProcess && workspaceId ? blockedProcessWorkspaces.get(workspaceId) : undefined;
          if (blockedCode) return { ok: false, code: blockedCode, message: NETWORK_FAILURE_MESSAGES[blockedCode]!, retryable: false };
          let result: Record<string, unknown>;
          try {
            // Output framing follows the current user's request, not a model guess
            // based on the source footage. Unspecified output always stays vertical.
            const requestedFraming = run.userMessage.replace(/(?:不要|不用|不做|非)\s*(?:横屏|方屏|正方形|16[:：]9|1[:：]1)/gu, "");
            const aspectRatio = /1[:：]1|方屏|正方形/u.test(requestedFraming) ? "1:1"
              : /16[:：]9|横屏/u.test(requestedFraming) ? "16:9" : "9:16";
            const executionInput = name === "resource_campfire_plan" ? { ...input, aspectRatio } : input;
            const observed = workspaceId ? observedFiles.get(workspaceId) : undefined;
            const versionGuard = name === "file_write" || (name === "file_patch" && typeof input.patch !== "string")
              ? { expectedDigest: typeof input.path === "string" ? observed?.get(input.path) ?? null : null }
              : name === "file_patch" ? { expectedDigests: Object.fromEntries(observed ?? []) } : {};
            result = await resourceCall<Record<string, unknown>>(identity, { ...executionInput, ...versionGuard,
              action: name, sessionId: run.sessionId, sourceRun: run.id, requestId: `${run.requestId}_${name}` } as ResourceControlRequest, signal);
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
            if (["workspace_restore", "file_move", "file_remove", "git_checkout", "git_branch"].includes(name)) observedFiles.delete(workspaceId);
            const observed = observedFiles.get(workspaceId) ?? new Map<string, string | null>();
            if (name === "file_read" && typeof result.path === "string" && typeof result.digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(result.digest)) {
              observed.set(result.path, result.digest);
            }
            const mutation = result.mutation as { changes?: Array<{ path?: unknown; afterDigest?: unknown }> } | undefined;
            for (const change of mutation?.changes ?? []) {
              if (typeof change.path === "string" && (change.afterDigest === null ||
                (typeof change.afterDigest === "string" && /^sha256:[a-f0-9]{64}$/u.test(change.afterDigest)))) observed.set(change.path, change.afterDigest);
            }
            if (observed.size) observedFiles.set(workspaceId, observed);
          }
          const verificationHint = resourceVerificationHint(name, input, result);
          const reference = result.fullResultArtifact;
          const artifactId = reference && typeof reference === "object" && !Array.isArray(reference)
            ? (reference as Record<string, unknown>).artifactId : undefined;
          const artifacts = typeof artifactId === "string" && /^art_[a-f0-9]{24}$/u.test(artifactId) ? [artifactId] : [];
          return { ok: true, summary: typeof result.summary === "string" ? result.summary : `${name} completed.`, evidence: { schemaVersion: 1, toolName: name, result: result as JsonValue, artifacts, diagnostics: [],
            ...(verificationHint === undefined ? {} : { verificationHint }) } };
        },
      },
      requiredPermissions: ["agent.use"],
      validateInput: input => basicInput(name, input),
      authorizeResource: async request => basicInput(name, request.input),
    } satisfies CloudToolBinding;
  });
}
