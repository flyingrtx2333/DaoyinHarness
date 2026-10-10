import { assertWorkspacePath } from "@daoyin/harness-contracts";
import { ResourceError } from "./repository.js";

export interface TextPatch { path: string; create: boolean; remove: boolean; hunks: string[] }
function conflict(): never { throw new ResourceError("PATCH_CONTEXT_CONFLICT", "Patch ranges or text do not match the current file; read the affected range and rebuild the patch.", 409); }
function unsupported(): never { throw new ResourceError("PATCH_FORMAT_UNSUPPORTED", "Use unified text hunks for file_patch; use file_move for renames and file_write for binary content or mode-specific capabilities.", 422); }

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
  const rawLines = patch.split("\n");
  const lines = rawLines.map(line => line.endsWith("\r") ? line.slice(0, -1) : line);
  const files: TextPatch[] = [];
  let current: TextPatch | undefined;
  let oldRemaining = 0, newRemaining = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if ((oldRemaining || newRemaining) && rawLines[index]!.endsWith("\r")) unsupported();
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
  const source = Array.from(text.matchAll(/([^\n]*)(\n|$)/gu))
    .filter(match => match[0] !== "")
    .map(match => ({ content: match[1]!.endsWith("\r") && match[2] === "\n" ? match[1]!.slice(0, -1) : match[1]!,
      ending: match[2] === "\n" ? (match[1]!.endsWith("\r") ? "\r\n" : "\n") : "" }));
  const output: typeof source = []; let cursor = 0, lastMarker = "", lastSourceEnding = "";
  let insertionEnding = source.find(line => line.ending)?.ending ?? "\n";
  for (const line of file.hunks) {
    if (line.startsWith("@@ ")) {
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line)!;
      const oldStart = Number(header[1]), oldCount = Number(header[2] ?? 1);
      const newStart = Number(header[3]), newCount = Number(header[4] ?? 1);
      const start = oldStart - (oldCount ? 1 : 0);
      if (!Number.isSafeInteger(start) || start < cursor || start > source.length) conflict();
      for (let index = cursor; index < start; index++) output.push(source[index]!); cursor = start;
      if (output.length !== newStart - (newCount ? 1 : 0)) conflict();
      insertionEnding = source[start]?.ending || source[start - 1]?.ending || insertionEnding;
      lastMarker = ""; continue;
    }
    if (line === "\\ No newline at end of file") {
      if (!lastMarker) conflict();
      if (lastMarker !== "+" && lastSourceEnding !== "") conflict();
      if (lastMarker !== "-") output[output.length - 1]!.ending = "";
      lastMarker = "";
      continue;
    }
    const marker = line[0]!, content = line.slice(1);
    if (marker !== "+") {
      const original = source[cursor]; if (!original || original.content !== content) conflict();
      lastSourceEnding = original.ending; if (original.ending) insertionEnding = original.ending;
      if (marker === " ") output.push({ ...original }); cursor++;
    } else output.push({ content, ending: insertionEnding });
    lastMarker = marker;
  }
  for (let index = cursor; index < source.length; index++) output.push(source[index]!);
  if (file.remove) { if (output.length) conflict(); return null; }
  if (output.some((line, index) => !line.ending && index < output.length - 1)) conflict();
  const result = Buffer.from(output.map(line => line.content + line.ending).join(""));
  if (result.length > 16 * 1024 * 1024) throw new ResourceError("FILE_EDIT_LIMIT", "Patched file exceeds 16 MiB.", 413);
  return result;
}
