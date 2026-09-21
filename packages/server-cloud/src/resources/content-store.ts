import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { assertSha256Digest } from "@daoyin/harness-contracts";

export interface ContentStore {
  put(content: Uint8Array): Promise<{ digest: string; size: number }>;
  read(digest: string, maximumBytes?: number): Promise<Buffer>;
  has(digest: string): Promise<boolean>;
}

const MAX_BLOB_BYTES = 128 * 1024 * 1024;

function blobPath(root: string, digest: string): string {
  assertSha256Digest(digest);
  const hash = digest.slice("sha256:".length);
  return path.join(root, hash.slice(0, 2), hash.slice(2, 4), hash);
}

export class FileContentStore implements ContentStore {
  readonly #root: string;

  private constructor(root: string) { this.#root = root; }

  public static async open(root: string): Promise<FileContentStore> {
    if (!path.isAbsolute(root)) throw Object.assign(new Error("Content store root must be absolute."), { code: "CONTENT_ROOT_INVALID" });
    await mkdir(root, { recursive: true, mode: 0o700 });
    return new FileContentStore(path.resolve(root));
  }

  public async put(content: Uint8Array): Promise<{ digest: string; size: number }> {
    if (content.byteLength > MAX_BLOB_BYTES) throw Object.assign(new Error("Content blob exceeds 128 MiB."), { code: "CONTENT_TOO_LARGE" });
    const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    const target = blobPath(this.#root, digest);
    try {
      const current = await stat(target);
      if (!current.isFile() || current.size !== content.byteLength) throw new Error("Content address collision or invalid entry.");
      return { digest, size: content.byteLength };
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temporary, target); }
    catch (error) {
      await rm(temporary, { force: true });
      try { if ((await stat(target)).isFile()) return { digest, size: content.byteLength }; } catch { /* Preserve original failure. */ }
      throw error;
    }
    return { digest, size: content.byteLength };
  }

  public async read(digest: string, maximumBytes = MAX_BLOB_BYTES): Promise<Buffer> {
    const target = blobPath(this.#root, digest);
    const info = await stat(target);
    if (!info.isFile() || info.size > Math.min(MAX_BLOB_BYTES, maximumBytes)) {
      throw Object.assign(new Error("Content blob is unavailable or exceeds the read budget."), { code: "CONTENT_READ_DENIED" });
    }
    const content = await readFile(target);
    const actual = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    if (actual !== digest) throw Object.assign(new Error("Content blob failed digest verification."), { code: "CONTENT_CORRUPT" });
    return content;
  }

  public async has(digest: string): Promise<boolean> {
    try { return (await stat(blobPath(this.#root, digest))).isFile(); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
  }
}
