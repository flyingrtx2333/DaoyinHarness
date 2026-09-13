import { createHash } from "node:crypto";
import type { ExecutionIdentity } from "@daoyin/harness-contracts";

export class ProjectError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export interface ProjectOwner { actor: string; space: string }
export interface Project {
  id: string; title: string; slug: string; revision: number; activeVersion: string | null;
  createdAt: string; updatedAt: string;
}
export interface ProjectFile { path: string; content: string }
export interface ProjectVersion { id: string; projectId: string; revision: number; digest: string; createdAt: string }
export interface ProjectOperation {
  id: string; projectId: string; kind: string; status: string; result: Record<string, unknown> | null;
  error: string | null; createdAt: string;
}
export interface ExecutorRequest {
  action: "domains" | "readiness" | "prepare" | "check" | "preview" | "publish" | "rollback" | "stop" | "status";
  projectId: string; slug?: string; versionId?: string; files?: ProjectFile[]; mode?: "development" | "production";
}
export const PROJECT_TOOLS = ["project_list", "project_create", "project_files", "project_write", "project_check", "project_preview", "project_publish"] as const;
export function ownerOf(identity: ExecutionIdentity): ProjectOwner {
  if (identity.space.kind === "public") throw new ProjectError("PROJECT_ACCOUNT_REQUIRED", "请登录道引账号。", 403);
  return { actor: String(identity.actorUserId), space: JSON.stringify(identity.space) };
}
export function ownerKey(owner: ProjectOwner): string {
  return createHash("sha256").update(JSON.stringify([owner.actor, owner.space])).digest("hex");
}
export function identifier(value: unknown, prefix: string): string {
  if (typeof value !== "string" || !new RegExp("^" + prefix + "_[a-f0-9]{24}$", "u").test(value))
    throw new ProjectError("PROJECT_ID_INVALID", "项目或版本标识无效。");
  return value;
}
export function filePath(value: unknown): string {
  if (typeof value !== "string" || value.length > 180 || value.startsWith("/") ||
      !/^[A-Za-z0-9_. /-]+$/u.test(value) || value.split("/").some(p => !p || p === "." || p === ".." || p.startsWith(".") ||
        ["node_modules", "dist", "build", "proc", "dev"].includes(p)) ||
      !/\.(?:tsx?|jsx?|json|css|html|md|svg|txt)$/u.test(value))
    throw new ProjectError("PROJECT_PATH_DENIED", "只允许项目内的源代码、样式和文本文件。");
  return value;
}
export function checkedFiles(value: unknown): ProjectFile[] {
  if (!Array.isArray(value) || value.length > 60) throw new ProjectError("PROJECT_FILES_INVALID", "单次最多修改 60 个文件。");
  let bytes = 0;
  const paths = new Set<string>();
  return value.map((f: unknown) => {
    if (!f || typeof f !== "object" || !("path" in f) || !("content" in f)) throw new ProjectError("PROJECT_FILE_INVALID", "文件格式无效。");
    const p = filePath(f.path);
    if (paths.has(p) || typeof f.content !== "string" || Buffer.byteLength(f.content) > 131072) throw new ProjectError("PROJECT_FILE_TOO_LARGE", "文件重复或超过 128 KB。");
    paths.add(p); bytes += Buffer.byteLength(f.content);
    if (bytes > 524288) throw new ProjectError("PROJECT_WRITE_TOO_LARGE", "单次修改超过 512 KB。");
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:saishi|story)_agent_[A-Za-z0-9_-]{64}/u.test(f.content))
      throw new ProjectError("PROJECT_SECRET_DENIED", "检测到凭据，请勿写入项目代码。");
    return { path: p, content: f.content };
  });
}
export function slugValue(value: unknown): string {
  // Reserved namespace coexists safely with the existing wildcard hosting service.
  if (typeof value !== "string" || !/^h-[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/u.test(value))
    throw new ProjectError("PROJECT_SLUG_INVALID", "网址名称需以 h- 开头，使用小写字母、数字和连字符。");
  return value;
}
