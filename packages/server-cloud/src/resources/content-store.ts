import { createHash, randomUUID } from "node:crypto";
import { chmod, chown, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
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
  readonly #sharedGid: number | undefined;

  private constructor(root: string, sharedGid: number | undefined) { this.#root = root; this.#sharedGid = sharedGid; }

  public static async open(root: string): Promise<FileContentStore> {
    if (!path.isAbsolute(root)) throw Object.assign(new Error("Content store root must be absolute."), { code: "CONTENT_ROOT_INVALID" });
    const parsed = Number(process.env.HARNESS_CONTENT_STORE_GID ?? "");
    const sharedGid = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
    await mkdir(root, { recursive: true, mode: sharedGid === undefined ? 0o700 : 0o2770 });
    if (sharedGid !== undefined) { await chown(root, -1, sharedGid); await chmod(root, 0o2770); }
    return new FileContentStore(path.resolve(root), sharedGid);
  }

  async #ensureDirectory(directory: string): Promise<void> {
    try { await mkdir(directory, { mode: this.#sharedGid === undefined ? 0o700 : 0o2770 }); }
    catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error; }
    if (this.#sharedGid !== undefined) { await chown(directory, -1, this.#sharedGid); await chmod(directory, 0o2770); }
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
    const relative = path.relative(this.#root, path.dirname(target)).split(path.sep);
    let directory = this.#root;
    for (const segment of relative) { directory = path.join(directory, segment); await this.#ensureDirectory(directory); }
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", this.#sharedGid === undefined ? 0o600 : 0o660);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    if (this.#sharedGid !== undefined) { await chown(temporary, -1, this.#sharedGid); await chmod(temporary, 0o660); }
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
