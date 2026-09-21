import type { DeploymentSpec, RuntimeSpec, WorkspaceEntry, WorkspaceSource } from "@daoyin/harness-contracts";

export const RESOURCE_TOOL_NAMES = [
  "resource_list", "resource_attach", "resource_detach",
  "workspace_create", "workspace_inspect", "workspace_snapshot", "workspace_restore",
  "file_list", "file_stat", "file_read", "file_search", "file_write", "file_patch", "file_mkdir", "file_move", "file_remove",
  "git_status", "git_diff", "git_log", "git_branch", "git_checkout", "git_commit", "git_export_patch",
  "process_run", "process_start", "process_read", "process_write", "process_stop", "process_list",
  "artifact_create", "artifact_read", "artifact_list",
  "deployment_create", "deployment_status", "deployment_rollback",
] as const;

export type ResourceToolName = typeof RESOURCE_TOOL_NAMES[number];
export type ResourceAction = ResourceToolName | "readiness" | "migrate_projects" | "reconcile" | "cancel_run";

export interface ResourceControlRequest {
  action: ResourceAction;
  owner?: { actor: string; space: string };
  authorization?: unknown;
  sessionId?: string;
  sourceRun?: string;
  requestId?: string;
  resourceId?: string;
  workspaceId?: string;
  snapshotId?: string;
  artifactId?: string;
  deploymentId?: string;
  processId?: string;
  title?: string;
  source?: WorkspaceSource;
  runtimeId?: "node22" | "python313" | "go125" | "rust190";
  runtime?: RuntimeSpec;
  entries?: WorkspaceEntry[];
  path?: string;
  from?: string;
  to?: string;
  content?: string;
  contentBase64?: string;
  expected?: string;
  replacement?: string;
  patch?: string;
  query?: string;
  searchMode?: "literal" | "regex" | "glob";
  glob?: string;
  startLine?: number;
  endLine?: number;
  maximumBytes?: number;
  executable?: string;
  args?: string[];
  cwd?: string;
  stdin?: string;
  processMode?: "foreground" | "background" | "pty";
  timeoutMs?: number;
  cursor?: number;
  signal?: string;
  environment?: Record<string, string>;
  mediaType?: string;
  metadata?: unknown;
  message?: string;
  revision?: string;
  endpoint?: string;
}

export interface ExecutorFileEntry {
  path: string;
  kind: "file" | "directory" | "symlink";
  mode: number;
  size: number;
  modifiedAt: string;
  target?: string;
}

export interface ResolvedSecret { ref: string; value: string }
export interface ResolvedResourceBinding { resourceId: string; hostPath: string; targetPath: string; readOnly: boolean }

export interface ExecutorProcessRequest {
  action: "readiness" | "workspace_prepare" | "workspace_remove" | "image_import" | "file" | "git" | "process" | "reconcile";
  workspaceId?: string | undefined;
  snapshotId?: string | undefined;
  runtime?: RuntimeSpec | undefined;
  source?: WorkspaceSource | undefined;
  entries?: WorkspaceEntry[] | undefined;
  operation?: string | undefined;
  processId?: string | undefined;
  runId?: string | undefined;
  path?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  content?: string | undefined;
  contentBase64?: string | undefined;
  expected?: string | undefined;
  replacement?: string | undefined;
  patch?: string | undefined;
  query?: string | undefined;
  searchMode?: "literal" | "regex" | "glob" | undefined;
  glob?: string | undefined;
  startLine?: number | undefined;
  endLine?: number | undefined;
  maximumBytes?: number | undefined;
  executable?: string | undefined;
  args?: string[] | undefined;
  cwd?: string | undefined;
  stdin?: string | undefined;
  mode?: "foreground" | "background" | "pty" | undefined;
  timeoutMs?: number | undefined;
  cursor?: number | undefined;
  environment?: Record<string, string> | undefined;
  revision?: string | undefined;
  message?: string | undefined;
  archive?: string | undefined;
  archiveDigest?: string | undefined;
  mediaType?: string | undefined;
  secretValues?: ResolvedSecret[] | undefined;
  bindings?: ResolvedResourceBinding[] | undefined;
}

export interface DeploymentWorkerRequest {
  action: "readiness" | "deploy" | "status" | "rollback" | "deactivate";
  deploymentId?: string;
  previousDeploymentId?: string;
  endpoint?: string;
  workspaceId?: string;
  runtime?: RuntimeSpec;
  entries?: WorkspaceEntry[];
  spec?: DeploymentSpec;
  secretValues?: ResolvedSecret[];
  bindings?: ResolvedResourceBinding[];
}
