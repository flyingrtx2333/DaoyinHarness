import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceVersion } from "@daoyin/harness-protocol";

// This is source evidence, not a snapshot or an installation cache. Resource
// metadata, Git objects and interpreter-generated caches cannot change it.
const EXCLUDED = new Set([".git", ".harness", "__pycache__", ".pytest_cache", ".mypy_cache"]);
export async function workspaceVersion(root: string, runtimeIdentity: string, signal?: AbortSignal): Promise<WorkspaceVersion> {
  const started = performance.now(); let bytes = 0; let entries = 0;
  const hash = createHash("sha256").update(JSON.stringify(["workspace-source-v1", runtimeIdentity]));
  const observed = new Map<string, Awaited<ReturnType<typeof lstat>>>();
  const check = (): void => {
    signal?.throwIfAborted();
    if (entries > 20_000 || bytes > 64 * 1024 * 1024 || performance.now() - started > 5000) throw new Error("SOURCE_VERSION_LIMIT");
  };
  const same = (before: Awaited<ReturnType<typeof lstat>>, after: Awaited<ReturnType<typeof lstat>>): boolean =>
    before.dev === after.dev && before.ino === after.ino && before.mode === after.mode && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
  try {
    const boundary = await realpath(root);
    const walk = async (directory: string): Promise<void> => {
      check(); const beforeDirectory = await lstat(directory);
      observed.set(directory, beforeDirectory);
      if (!beforeDirectory.isDirectory() || beforeDirectory.isSymbolicLink()) throw new Error("SOURCE_VERSION_CHANGED");
      const resolved = await realpath(directory);
      if (resolved !== boundary && !resolved.startsWith(`${boundary}${path.sep}`)) throw new Error("SOURCE_VERSION_ESCAPE");
      for (const name of (await readdir(directory)).sort()) {
        if (EXCLUDED.has(name) || name.startsWith(".harness-restore-") || directory === root && name === "lost+found") continue;
        check(); entries++;
        const target = path.join(directory, name); const before = await lstat(target);
        observed.set(target, before);
        const relative = path.relative(root, target).replaceAll("\\", "/");
        if (before.isDirectory()) { hash.update(JSON.stringify([relative, "directory", before.mode & 0o777])); await walk(target); continue; }
        if (before.isSymbolicLink()) {
          const value = await readlink(target);
          hash.update(JSON.stringify([relative, "symlink", before.mode & 0o777, value]));
        } else if (before.isFile()) {
          bytes += before.size; check();
          const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            if (!same(before, await handle.stat())) throw new Error("SOURCE_VERSION_CHANGED");
            const content = createHash("sha256"); const buffer = Buffer.alloc(64 * 1024); let position = 0;
            while (true) {
              check(); const result = await handle.read(buffer, 0, buffer.length, position);
              if (result.bytesRead === 0) break;
              position += result.bytesRead;
              if (position > before.size) throw new Error("SOURCE_VERSION_CHANGED");
              content.update(buffer.subarray(0, result.bytesRead));
            }
            if (position !== before.size || !same(before, await handle.stat())) throw new Error("SOURCE_VERSION_CHANGED");
            hash.update(JSON.stringify([relative, "file", before.mode & 0o777, content.digest("hex")]));
          } finally { await handle.close(); }
        } else throw new Error("SOURCE_VERSION_UNSUPPORTED_ENTRY");
        if (!same(before, await lstat(target))) throw new Error("SOURCE_VERSION_CHANGED");
      }
      if (!same(beforeDirectory, await lstat(directory))) throw new Error("SOURCE_VERSION_CHANGED");
    };
    await walk(root);
    for (const [target, before] of observed) {
      check();
      if (!same(before, await lstat(target))) throw new Error("SOURCE_VERSION_CHANGED");
    }
    check();
    return { state: "known", digest: `sha256:${hash.digest("hex")}` };
  } catch (error) {
    signal?.throwIfAborted();
    const reason = error instanceof Error && /^SOURCE_VERSION_/u.test(error.message) ? error.message : "SOURCE_VERSION_UNAVAILABLE";
    return { state: "unknown", reason };
  }
}
