import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { ResourceError } from "./repository.js";

export const fileDigest = (data: Buffer): string => `sha256:${createHash("sha256").update(data).digest("hex")}`;

/** Called under the executor's existing workspace lock with processes paused. */
export async function fileBaseline(target: string): Promise<Buffer | null> {
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new ResourceError("FILE_EDIT_LIMIT", "Edit observation requires a regular file within 16 MiB.", 413);
    return await readFile(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function assertFileVersion(before: Buffer | null, expected: string | null | undefined): void {
  if (expected === undefined) return; // Ordinary manual API writes remain compatible.
  if (expected !== null && !/^sha256:[a-f0-9]{64}$/u.test(expected)) throw new ResourceError("FILE_VERSION_INVALID", "File version must be an observed SHA-256 digest.", 422);
  if (expected !== (before === null ? null : fileDigest(before))) {
    throw new ResourceError(expected === null ? "FILE_NOT_OBSERVED" : "FILE_STALE_VERSION",
      "File is unread or changed since observation; read the current file before editing again.", 409);
  }
}

/** A bounded changed-region preview, not a minimal diff or correctness check. */
export function fileChange(path: string, before: Buffer | null, after: Buffer | null) {
  const beforeDigest = before === null ? null : fileDigest(before);
  const afterDigest = after === null ? null : fileDigest(after);
  const changed = beforeDigest !== afterDigest;
  const base = { path, changed, beforeDigest, afterDigest };
  if (!changed || [before, after].some(data => data && (data.includes(0) || !Buffer.from(data.toString("utf8")).equals(data)))) return base;
  const physicalLines = (data: Buffer | null) => data?.toString("utf8").match(/[^\n]*(?:\n|$)/gu)?.filter(line => line.length > 0) ?? [];
  const oldLines = physicalLines(before), newLines = physicalLines(after);
  let first = 0;
  while (first < oldLines.length && first < newLines.length && oldLines[first] === newLines[first]) first++;
  let oldEnd = oldLines.length, newEnd = newLines.length;
  while (oldEnd > first && newEnd > first && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd--; }
  // Keep work and output bounded even for a whole-file replacement.
  let preview = `@@ -${first + (oldEnd > first ? 1 : 0)},${oldEnd - first} +${first + (newEnd > first ? 1 : 0)},${newEnd - first} @@\n`;
  let previewTruncated = false;
  for (const [lines, end, marker] of [[oldLines, oldEnd, "-"], [newLines, newEnd, "+"]] as const) {
    for (let index = first; index < end; index++) {
      const original = lines[index]!;
      const line = `${marker}${original}${original.endsWith("\n") ? "" : "\n\\ No newline at end of file\n"}`;
      if (preview.length + line.length > 2000) { previewTruncated = true; break; }
      preview += line;
    }
  }
  return { ...base, beforeRange: { startLine: first + 1, lineCount: oldEnd - first },
    afterRange: { startLine: first + 1, lineCount: newEnd - first }, previewKind: "changed-region", preview, previewTruncated };
}

export function fileMutation(changes: ReturnType<typeof fileChange>[]) {
  return { changed: changes.some(change => change.changed), totalFiles: changes.length,
    changes: changes.slice(0, 8), changesTruncated: changes.length > 8 };
}
