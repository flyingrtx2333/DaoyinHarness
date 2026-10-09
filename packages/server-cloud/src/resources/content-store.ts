import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, chown, lstat, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { assertSha256Digest } from "@daoyin/harness-contracts";

export interface ContentStore {
  put(content: Uint8Array): Promise<{ digest: string; size: number }>;
  read(digest: string, maximumBytes?: number): Promise<Buffer>;
  has(digest: string): Promise<boolean>;
  readRange?(digest: string, offset: number, length: number): Promise<Buffer>;
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
    const store = new FileContentStore(path.resolve(root), sharedGid);
    await mkdir(path.dirname(store.#root), { recursive: true, mode: sharedGid === undefined ? 0o700 : 0o2770 });
    await store.#ensureDirectory(store.#root);
    return store;
  }

  async #ensureDirectory(directory: string): Promise<void> {
    const mode = this.#sharedGid === undefined ? 0o700 : 0o2770;
    let created = false;
    try { await mkdir(directory, { mode }); created = true; }
    catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error; }
    const effectiveUid = process.geteuid?.() ?? process.getuid?.();
    const initial = await lstat(directory);
    if (!initial.isDirectory() || (created && effectiveUid !== undefined && initial.uid !== effectiveUid)) {
      throw Object.assign(new Error("Content directory is not a real owned directory."), { code: "CONTENT_DIRECTORY_INVALID" });
    }
    // Only initialize directories created by this operation. Another service may
    // own a perfectly usable shared prefix; attempting chown/chmod would fail.
    if (created) {
      if (this.#sharedGid !== undefined) await chown(directory, -1, this.#sharedGid);
      await chmod(directory, mode);
    }
    const current = await lstat(directory);
    const ownershipMatches = this.#sharedGid === undefined
      ? effectiveUid === undefined || current.uid === effectiveUid
      : current.gid === this.#sharedGid;
    if (!current.isDirectory() || !ownershipMatches || (current.mode & 0o7777) !== mode) {
      throw Object.assign(new Error("Content directory permissions do not match its configured access boundary."), { code: "CONTENT_DIRECTORY_PERMISSIONS" });
    }
    // Mode bits alone do not prove this process can use the configured group.
    await access(directory, constants.R_OK | constants.W_OK | constants.X_OK);
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

  public async readRange(digest: string, offset: number, length: number): Promise<Buffer> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 1_000_000) throw new Error("Invalid bounded content range.");
    const handle = await open(blobPath(this.#root, digest), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_BLOB_BYTES || offset > info.size) throw new Error("Content range is unavailable.");
      const bytes = Buffer.alloc(Math.min(length, info.size - offset));
      const read = await handle.read(bytes, 0, bytes.length, offset);
      if (read.bytesRead !== bytes.length) throw new Error("Content range changed during the read.");
      return bytes;
    } finally { await handle.close(); }
  }
}
