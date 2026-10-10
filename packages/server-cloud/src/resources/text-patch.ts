import { assertWorkspacePath } from "@daoyin/harness-contracts";
import { ResourceError } from "./repository.js";

export interface TextPatch { path: string; create: boolean; remove: boolean; hunks: string[] }
const conflict = (): never => { throw new ResourceError("PATCH_CONTEXT_CONFLICT", "Patch ranges or text do not match the current file; read the affected range and rebuild the patch.", 409); };
const unsupported = (): never => { throw new ResourceError("PATCH_FORMAT_UNSUPPORTED", "Use unified text hunks for file_patch; use file_move for renames and file_write for binary content or mode-specific capabilities.", 422); };

function headerPath(line: string): string | null {
  let value = line.slice(4).split("\t")[0]!;
  if (value.startsWith('"')) { try { value = JSON.parse(value) as string; } catch { unsupported(); } }
  if (typeof value !== "string") unsupported();
  if (value === "/dev/null") return null;
  if (!/^[ab]\//u.test(value)) unsupported();
  value = value.slice(2); assertWorkspacePath(value); return value;
}

/** Strict, bounded unified text contract; no language runtime or fuzzy matching. */
export function parseTextPatch(patch: string): TextPatch[] {
  const lines = patch.split("\n").map(line => line.endsWith("\r") ? line.slice(0, -1) : line);
  const files: TextPatch[] = [];
  let current: TextPatch | undefined;
  let oldRemaining = 0, newRemaining = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line === "\\ No newline at end of file") { if (!current) conflict(); current.hunks.push(line); continue; }
    if (oldRemaining || newRemaining) {
      const marker = line[0];
      if (marker === " " || marker === "-") oldRemaining--;
      if (marker === " " || marker === "+") newRemaining--;
      if (![" ", "-", "+"].includes(marker ?? "") || oldRemaining < 0 || newRemaining < 0) conflict();
      current!.hunks.push(line); continue;
    }
    if (line.startsWith("--- ")) {
      const oldPath = headerPath(line), next = lines[++index];
      if (!next?.startsWith("+++ ")) unsupported();
      const newPath = headerPath(next);
      if ((!oldPath && !newPath) || (oldPath && newPath && oldPath !== newPath)) unsupported();
      const path = (newPath ?? oldPath)!;
      if (files.some(file => file.path === path) || files.length >= 128) unsupported();
      current = { path, create: oldPath === null, remove: newPath === null, hunks: [] }; files.push(current); continue;
    }
    if (line.startsWith("@@ ")) {
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/u.exec(line);
      if (!current || !header) conflict();
      oldRemaining = Number(header[2] ?? 1); newRemaining = Number(header[4] ?? 1);
      current.hunks.push(line); continue;
    }
    if (line === "" || line.startsWith("diff --git ") || line.startsWith("index ") || /^new file mode 100644$/u.test(line) || /^deleted file mode 100[0-7]{3}$/u.test(line)) continue;
    unsupported();
  }
  if (oldRemaining || newRemaining || !files.length || files.some(file => !file.hunks.length)) conflict();
  return files;
}

export function applyTextPatch(file: TextPatch, before: Buffer | null): Buffer | null {
  if (file.create !== (before === null) || before?.includes(0)) conflict();
  const text = before?.toString("utf8") ?? "";
  if (before && !Buffer.from(text).equals(before)) unsupported();
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const source = text === "" ? [] : text.split(/\r?\n/u);
  if (text.endsWith("\n")) source.pop();
  const output: string[] = []; let cursor = 0, trailingNewline = text.endsWith("\n"), lastMarker = "";
  for (const line of file.hunks) {
    if (line.startsWith("@@ ")) {
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line)!;
      const oldStart = Number(header[1]), oldCount = Number(header[2] ?? 1);
      const newStart = Number(header[3]), newCount = Number(header[4] ?? 1);
      const start = oldStart - (oldCount ? 1 : 0);
      if (!Number.isSafeInteger(start) || start < cursor || start > source.length) conflict();
      for (let index = cursor; index < start; index++) output.push(source[index]!); cursor = start;
      if (output.length !== newStart - (newCount ? 1 : 0)) conflict();
      lastMarker = ""; continue;
    }
    if (line === "\\ No newline at end of file") {
      if (!lastMarker) conflict();
      if (lastMarker !== "-") trailingNewline = false;
      continue;
    }
    const marker = line[0]!, content = line.slice(1);
    if (marker !== "+") { if (source[cursor] !== content) conflict(); cursor++; }
    if (marker !== "-") { output.push(content); trailingNewline = true; }
    lastMarker = marker;
  }
  if (cursor < source.length) trailingNewline = text.endsWith("\n");
  for (let index = cursor; index < source.length; index++) output.push(source[index]!);
  if (file.remove) { if (output.length) conflict(); return null; }
  const result = Buffer.from(output.join(eol) + (output.length && trailingNewline ? eol : ""));
  if (result.length > 16 * 1024 * 1024) throw new ResourceError("FILE_EDIT_LIMIT", "Patched file exceeds 16 MiB.", 413);
  return result;
}
