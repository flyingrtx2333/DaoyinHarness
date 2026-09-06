import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

const WINDOWS_DEVICE_NAME = /(^|[\\/])(con|prn|aux|nul|com[1-9]|lpt[1-9])($|[.\\/])/i;
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", ".venv", "__pycache__", ".cache", "coverage", "dist", "build", "claude-code-main"]);

export interface WorkspaceLimits {
  maxFileBytes: number;
  maxFiles: number;
  maxSearchResults: number;
  maxDepth: number;
}

export interface FileSearchMatch {
  path: string;
  line: number;
  text: string;
}

const DEFAULT_LIMITS: WorkspaceLimits = {
  maxFileBytes: 1_000_000,
  maxFiles: 2_000,
  maxSearchResults: 200,
  maxDepth: 12,
};

export class WorkspaceError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceError";
    this.code = code;
  }
}

function toPortable(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertRelativePath(relativePath: string): void {
  if (
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    path.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    relativePath.startsWith("\\\\") ||
    relativePath.split(/[\\/]+/u).includes("..") ||
    relativePath.includes(":") ||
    WINDOWS_DEVICE_NAME.test(relativePath)
  ) {
    throw new WorkspaceError("WORKSPACE_PATH_REJECTED", "Path must be a safe workspace-relative path.");
  }
}

export class Workspace {
  readonly #root: string;
  readonly #limits: WorkspaceLimits;

  private constructor(root: string, limits: WorkspaceLimits) {
    this.#root = root;
    this.#limits = limits;
  }

  public static async open(root: string, limits: Partial<WorkspaceLimits> = {}): Promise<Workspace> {
    const resolvedRoot = await realpath(path.resolve(root));
    const rootStats = await stat(resolvedRoot);
    if (!rootStats.isDirectory()) {
      throw new WorkspaceError("WORKSPACE_ROOT_INVALID", "Workspace root must be a directory.");
    }
    return new Workspace(resolvedRoot, { ...DEFAULT_LIMITS, ...limits });
  }

  public get root(): string {
    return this.#root;
  }

  public async listFiles(relativeDirectory = "."): Promise<string[]> {
    const directory = relativeDirectory === "." ? this.#root : await this.#existingPath(relativeDirectory);
    const directoryStats = await stat(directory);
    if (!directoryStats.isDirectory()) {
      throw new WorkspaceError("WORKSPACE_NOT_DIRECTORY", "Requested path is not a directory.");
    }
    const results: string[] = [];
    const visit = async (current: string, depth: number): Promise<void> => {
      if (depth > this.#limits.maxDepth) {
        return;
      }
      const entries = await readdir(current, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (results.length >= this.#limits.maxFiles) {
          return;
        }
        const absolute = path.join(current, entry.name);
        if (entry.isSymbolicLink()) {
          continue;
        }
        if (entry.isDirectory()) {
          if (IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
          await visit(absolute, depth + 1);
        } else if (entry.isFile()) {
          results.push(toPortable(path.relative(this.#root, absolute)));
        }
      }
    };
    await visit(directory, 0);
    return results;
  }

  public async readText(relativePath: string): Promise<string> {
    const absolute = await this.#existingPath(relativePath);
    const fileStats = await stat(absolute);
    if (!fileStats.isFile()) {
      throw new WorkspaceError("WORKSPACE_NOT_FILE", "Requested path is not a file.");
    }
    if (fileStats.size > this.#limits.maxFileBytes) {
      throw new WorkspaceError("WORKSPACE_FILE_TOO_LARGE", "File exceeds the workspace read limit.");
    }
    return readFile(absolute, "utf8");
  }

  public async writeText(relativePath: string, content: string): Promise<void> {
    if (Buffer.byteLength(content, "utf8") > this.#limits.maxFileBytes) {
      throw new WorkspaceError("WORKSPACE_FILE_TOO_LARGE", "Content exceeds the workspace write limit.");
    }
    const destination = await this.#writablePath(relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    const verifiedParent = await realpath(path.dirname(destination));
    if (!isWithin(this.#root, verifiedParent)) {
      throw new WorkspaceError("WORKSPACE_ESCAPE", "Write destination escapes the workspace.");
    }
    const temporary = path.join(verifiedParent, `.${path.basename(destination)}.${crypto.randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true });
      throw new WorkspaceError("WORKSPACE_WRITE_FAILED", "Atomic workspace write failed.", { cause: error });
    }
  }

  public async replaceText(relativePath: string, expected: string, replacement: string): Promise<void> {
    if (expected.length === 0) {
      throw new WorkspaceError("WORKSPACE_PATCH_INVALID", "Expected text cannot be empty.");
    }
    const current = await this.readText(relativePath);
    const first = current.indexOf(expected);
    if (first < 0 || current.indexOf(expected, first + expected.length) >= 0) {
      throw new WorkspaceError("WORKSPACE_PATCH_CONFLICT", "Expected text must match exactly once.");
    }
    await this.writeText(relativePath, `${current.slice(0, first)}${replacement}${current.slice(first + expected.length)}`);
  }

  public async searchText(query: string, relativeDirectory = "."): Promise<FileSearchMatch[]> {
    if (query.length === 0 || query.length > 500) {
      throw new WorkspaceError("WORKSPACE_SEARCH_INVALID", "Search query must contain 1 to 500 characters.");
    }
    const files = await this.listFiles(relativeDirectory);
    const matches: FileSearchMatch[] = [];
    for (const file of files) {
      if (matches.length >= this.#limits.maxSearchResults) {
        break;
      }
      try {
        const content = await this.readText(file);
        const lines = content.split(/\r?\n/u);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          if (line?.includes(query)) {
            matches.push({ path: file, line: index + 1, text: line.slice(0, 500) });
            if (matches.length >= this.#limits.maxSearchResults) {
              break;
            }
          }
        }
      } catch (error) {
        if (!(error instanceof WorkspaceError) || error.code !== "WORKSPACE_FILE_TOO_LARGE") {
          throw error;
        }
      }
    }
    return matches;
  }

  async #existingPath(relativePath: string): Promise<string> {
    assertRelativePath(relativePath);
    const lexical = path.resolve(this.#root, relativePath);
    if (!isWithin(this.#root, lexical)) {
      throw new WorkspaceError("WORKSPACE_ESCAPE", "Path escapes the workspace.");
    }
    const resolved = await realpath(lexical);
    if (!isWithin(this.#root, resolved)) {
      throw new WorkspaceError("WORKSPACE_ESCAPE", "Resolved path escapes the workspace.");
    }
    return resolved;
  }

  async #writablePath(relativePath: string): Promise<string> {
    assertRelativePath(relativePath);
    const destination = path.resolve(this.#root, relativePath);
    if (!isWithin(this.#root, destination)) {
      throw new WorkspaceError("WORKSPACE_ESCAPE", "Path escapes the workspace.");
    }
    try {
      const entry = await lstat(destination);
      if (entry.isSymbolicLink()) {
        throw new WorkspaceError("WORKSPACE_ESCAPE", "Symbolic-link destinations are not writable.");
      }
      const resolved = await realpath(destination);
      if (!isWithin(this.#root, resolved)) {
        throw new WorkspaceError("WORKSPACE_ESCAPE", "Resolved path escapes the workspace.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    let ancestor = path.dirname(destination);
    while (isWithin(this.#root, ancestor)) {
      try {
        const resolvedAncestor = await realpath(ancestor);
        if (!isWithin(this.#root, resolvedAncestor)) {
          throw new WorkspaceError("WORKSPACE_ESCAPE", "Write parent escapes the workspace.");
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        const parent = path.dirname(ancestor);
        if (parent === ancestor) {
          throw new WorkspaceError("WORKSPACE_ESCAPE", "No safe workspace parent exists.");
        }
        ancestor = parent;
      }
    }
    return destination;
  }
}
