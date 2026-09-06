import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Workspace } from "@daoyin/harness-workspace";
import type { RecentWorkspace } from "@daoyin/harness-protocol";

interface HistoryData {
  schemaVersion: 1;
  legacyRoot: string;
  recent: RecentWorkspace[];
}

function rootKey(root: string): string {
  return process.platform === "win32" ? root.toLowerCase() : root;
}

export async function validateWorkspaceRoot(value: unknown): Promise<string> {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 4096) {
    throw Object.assign(new Error("请输入文件夹的完整路径。"), { code: "WORKSPACE_ROOT_INVALID" });
  }
  const root = value.trim();
  if (!path.isAbsolute(root) || [...root].some((character) => character.charCodeAt(0) < 32) || root.startsWith("\\\\") || root.startsWith("//") ||
    (process.platform === "win32" && (!/^[a-z]:[\\/]/iu.test(root) || root.slice(2).includes(":"))) ||
    /(^|[\\/])(con|prn|aux|nul|com[1-9]|lpt[1-9])($|[.\\/])/iu.test(root)) {
    throw Object.assign(new Error("请选择本机文件夹，或输入有效的绝对路径。"), { code: "WORKSPACE_ROOT_INVALID" });
  }
  try {
    return (await Workspace.open(root)).root;
  } catch {
    throw Object.assign(new Error("文件夹不存在或无法访问，请检查路径和访问权限。"), { code: "WORKSPACE_ROOT_INVALID" });
  }
}

export class WorkspaceHistory {
  private constructor(readonly dataDir: string, private data: HistoryData) {}

  static async open(dataDir: string, initialRoot: string): Promise<WorkspaceHistory> {
    let data: HistoryData;
    try {
      const parsed = JSON.parse(await readFile(path.join(dataDir, "workspaces.json"), "utf8")) as HistoryData;
      if (parsed.schemaVersion !== 1 || typeof parsed.legacyRoot !== "string" || !Array.isArray(parsed.recent) ||
        parsed.recent.some((item) => typeof item.root !== "string" || typeof item.name !== "string" || typeof item.lastOpenedAt !== "string")) {
        throw new Error("Invalid workspace history.");
      }
      data = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      data = { schemaVersion: 1, legacyRoot: initialRoot, recent: [] };
    }
    return new WorkspaceHistory(dataDir, data);
  }

  get recent(): RecentWorkspace[] { return this.data.recent.map((item) => ({ ...item })); }

  catalogDirectory(root: string): string {
    if (rootKey(root) === rootKey(this.data.legacyRoot)) return path.join(this.dataDir, "state");
    const id = createHash("sha256").update(rootKey(root)).digest("hex").slice(0, 24);
    return path.join(this.dataDir, "workspaces", id, "state");
  }

  async remember(root: string): Promise<void> {
    const next: HistoryData = {
      ...this.data,
      recent: [{ root, name: path.basename(root) || root, lastOpenedAt: new Date().toISOString() },
        ...this.data.recent.filter((item) => rootKey(item.root) !== rootKey(root))].slice(0, 20),
    };
    await mkdir(this.dataDir, { recursive: true });
    const temporary = path.join(this.dataDir, `workspaces.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(next, null, 2), { encoding: "utf8", flag: "wx" });
      await rename(temporary, path.join(this.dataDir, "workspaces.json"));
      this.data = next;
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
