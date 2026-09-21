import type { JsonValue } from "@daoyin/harness-protocol";

export type ResourceKind = "workspace" | "database" | "browser" | "artifact" | "deployment" | "business";
export type WorkspaceSource =
  | { kind: "empty" }
  | { kind: "git"; url: string; revision: string }
  | { kind: "upload"; artifactId: string }
  | { kind: "snapshot"; snapshotId: string };

export interface ResourceRef {
  id: string;
  kind: ResourceKind;
  title: string;
  version: number;
  capabilities: readonly string[];
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeLimits {
  cpu: number;
  memoryMiB: number;
  pids: number;
  diskMiB: number;
  timeoutSeconds: number;
  maxOutputBytes: number;
}

export type RuntimeImage =
  | { kind: "builtin"; id: string; digest: string }
  | { kind: "dockerfile"; path: string; context: string; imageDigest?: string };

export interface RuntimeSpec {
  image: RuntimeImage;
  environment: Readonly<Record<string, string>>;
  secretRefs: readonly string[];
  network: "public" | "none";
  limits: RuntimeLimits;
}

export interface Workspace extends ResourceRef {
  kind: "workspace";
  source: WorkspaceSource;
  runtime: RuntimeSpec;
  activeSnapshotId: string | null;
  state: "creating" | "ready" | "failed" | "archived";
}

export type WorkspaceEntry =
  | { path: string; kind: "file"; mode: number; size: number; blobHash: string }
  | { path: string; kind: "symlink"; mode: number; size: number; target: string };

export interface WorkspaceSnapshot {
  id: string;
  workspaceId: string;
  parentSnapshotId: string | null;
  digest: string;
  entries: readonly WorkspaceEntry[];
  createdAt: string;
}

export interface Artifact extends ResourceRef {
  kind: "artifact";
  workspaceId: string;
  snapshotId: string | null;
  mediaType: string;
  size: number;
  blobHash: string;
  metadata: JsonValue;
}

export interface DeploymentSpec {
  version: 1;
  kind: "web-service";
  command: {
    executable: string;
    args: readonly string[];
    cwd: string;
  };
  transport: { kind: "tcp"; port: number } | { kind: "unix"; path: string };
  health: {
    path: string;
    timeoutSeconds: number;
  };
  environment: Readonly<Record<string, string>>;
  resourceIds: readonly string[];
}

export interface Deployment extends ResourceRef {
  kind: "deployment";
  workspaceId: string;
  artifactId: string;
  status: "queued" | "starting" | "healthy" | "failed" | "rolled_back";
  endpoint: string | null;
  previousDeploymentId: string | null;
}

export interface ProcessSession {
  id: string;
  workspaceId: string;
  runId: string;
  executable: string;
  args: readonly string[];
  cwd: string;
  mode: "foreground" | "background" | "pty";
  status: "starting" | "running" | "exited" | "failed" | "cancelled" | "timed_out" | "interrupted";
  exitCode: number | null;
  outputCursor: number;
  startedAt: string;
  timeoutAt: string | null;
  finishedAt: string | null;
}

const ID = /^(?:res|wsp|snp|art|dep|prc)_[a-f0-9]{24}$/u;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?($|\/))(?!.*\0).{1,512}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

export function assertResourceId(value: unknown, prefix?: string): asserts value is string {
  if (typeof value !== "string" || !ID.test(value) || prefix !== undefined && !value.startsWith(`${prefix}_`)) {
    throw Object.assign(new Error("Resource identifier is invalid."), { code: "RESOURCE_ID_INVALID" });
  }
}

export function assertWorkspacePath(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SAFE_PATH.test(value.replaceAll("\\", "/"))) {
    throw Object.assign(new Error("Workspace path is invalid."), { code: "WORKSPACE_PATH_INVALID" });
  }
}

export function assertSha256Digest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw Object.assign(new Error("Content digest is invalid."), { code: "CONTENT_DIGEST_INVALID" });
  }
}

export function defaultRuntimeSpec(image: RuntimeImage): RuntimeSpec {
  return {
    image,
    environment: {},
    secretRefs: [],
    network: "public",
    limits: { cpu: 1, memoryMiB: 1536, pids: 256, diskMiB: 4096, timeoutSeconds: 600, maxOutputBytes: 1_000_000 },
  };
}
