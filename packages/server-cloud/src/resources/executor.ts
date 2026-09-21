import http from "node:http";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, chown, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertResourceId, assertWorkspacePath, type RuntimeSpec, type WorkspaceEntry } from "@daoyin/harness-contracts";
import { FileContentStore } from "./content-store.js";
import { ResourceError } from "./repository.js";
import { assertRuntimeSpec } from "./runtime-policy.js";
import type { ExecutorProcessRequest, ResolvedSecret } from "./contracts.js";

const ROOT = process.env.HARNESS_WORKSPACE_ROOT ?? "/var/lib/daoyin-resources/workspaces";
const CONTENT_ROOT = process.env.HARNESS_CONTENT_STORE_ROOT ?? "/var/lib/daoyin-resources/content";
const BUILD_OUTPUT_ROOT = process.env.HARNESS_BUILD_OUTPUT_ROOT ?? "/var/lib/daoyin-resources/builds";
const DISK_ROOT = process.env.HARNESS_WORKSPACE_DISK_ROOT ?? "/var/lib/daoyin-resources/disks";
const SECRET_ROOT = process.env.HARNESS_SECRET_MATERIAL_ROOT ?? "/run/daoyin-resource-secrets";
const SOCKET = "/run/daoyin-resource-executor/control.sock";
const RUNTIME = process.env.HARNESS_GVISOR_RUNTIME ?? "runsc";
const EGRESS_NETWORK = process.env.HARNESS_EGRESS_NETWORK ?? "harness-public-egress";
const EGRESS_PROXY = process.env.HARNESS_EGRESS_PROXY ?? process.env.HARNESS_EGRESS_PROXY_URL ?? "";
const EGRESS_SECRET = process.env.HARNESS_EGRESS_HMAC_SECRET ?? "";
const IMAGE_CATALOG = JSON.parse(process.env.HARNESS_RUNTIME_IMAGES ?? "{}") as Record<string, { image: string; digest: string }>;
const SANDBOX_PROBE = JSON.parse(process.env.HARNESS_SANDBOX_PROBE ?? "null") as { imageId?: string; executable?: string; args?: string[] } | null;
const content = await FileContentStore.open(CONTENT_ROOT);
const processes = new Map<string, { workspaceId: string; name: string; mode: "background" | "pty"; startedAt: string; timeoutAt: number }>();

async function processSession(workspaceId: string, processId: string): Promise<{ workspaceId: string; name: string; mode: "background" | "pty"; startedAt: string; timeoutAt: number }> {
  const current = processes.get(processId);
  if (current?.workspaceId === workspaceId) return current;
  assertResourceId(processId, "prc");
  const name = `hr-${processId}`;
  const inspected = await docker(["inspect", "--format", "{{json .Config.Labels}}", name], 10_000, undefined, 100_000);
  if (inspected.exitCode !== 0) throw new ResourceError("PROCESS_NOT_FOUND", "Process is not available in this workspace.", 404);
  const labels = JSON.parse(inspected.stdout) as Record<string, string>;
  if (labels["daoyin.harness.workspace"] !== workspaceId || labels["daoyin.harness.process"] !== processId ||
      !["background", "pty"].includes(labels["daoyin.harness.mode"] ?? "")) {
    throw new ResourceError("PROCESS_NOT_FOUND", "Process is not available in this workspace.", 404);
  }
  const recovered = { workspaceId, name, mode: labels["daoyin.harness.mode"] as "background" | "pty",
    startedAt: labels["daoyin.harness.started_at"] ?? new Date().toISOString(), timeoutAt: Number(labels["daoyin.harness.timeout_at"] ?? 0) };
  processes.set(processId, recovered);
  return recovered;
}

async function reconcileProcesses(): Promise<void> {
  const listed = await docker(["ps", "-a", "--filter", "label=daoyin.harness.resource=1", "--format", "{{.Names}}"], 20_000, undefined, 1_000_000);
  if (listed.exitCode !== 0) throw new ResourceError("PROCESS_RECONCILE_FAILED", "Sandbox processes could not be reconciled.", 503);
  for (const name of listed.stdout.split(/\r?\n/u).filter((item) => /^hr-prc_[a-f0-9]{24}$/u.test(item))) {
    const processId = name.slice(3); const inspected = await docker(["inspect", "--format", "{{json .Config.Labels}}", name], 10_000, undefined, 100_000);
    if (inspected.exitCode !== 0) continue;
    const labels = JSON.parse(inspected.stdout) as Record<string, string>; const workspaceId = labels["daoyin.harness.workspace"] ?? "";
    if (!/^wsp_[a-f0-9]{24}$/u.test(workspaceId) || labels["daoyin.harness.process"] !== processId || !["background", "pty"].includes(labels["daoyin.harness.mode"] ?? "")) continue;
    processes.set(processId, { workspaceId, name, mode: labels["daoyin.harness.mode"] as "background" | "pty",
      startedAt: labels["daoyin.harness.started_at"] ?? new Date().toISOString(), timeoutAt: Number(labels["daoyin.harness.timeout_at"] ?? 0) });
  }
}
async function reconcileProcessSecrets(): Promise<void> {
  await mkdir(SECRET_ROOT, { recursive: true, mode: 0o700 }); const live = new Set([...processes.values()].map(item => item.name));
  for (const item of await readdir(SECRET_ROOT, { withFileTypes: true })) {
    if (item.isDirectory() && /^hr-(?:run-|prc_)/u.test(item.name) && !live.has(item.name)) await cleanupSecrets(item.name);
  }
}
async function enforceProcessTimeouts(): Promise<void> {
  const now = Date.now();
  for (const [processId, session] of processes) if (session.timeoutAt > 0 && now >= session.timeoutAt) {
    await docker(["rm", "-f", session.name], 30_000).catch(() => undefined); processes.delete(processId);
    await cleanupSecrets(session.name);
  }
}

function workspaceRoot(workspaceId: string): string {
  assertResourceId(workspaceId, "wsp");
  return path.join(ROOT, workspaceId);
}

function image(spec: RuntimeSpec): string {
  if (spec.image.kind === "dockerfile") {
    if (!spec.image.imageDigest) throw new ResourceError("RUNTIME_IMAGE_PENDING", "The workspace image has not been built.", 409);
    return spec.image.imageDigest;
  }
  const entry = IMAGE_CATALOG[spec.image.id];
  if (!entry || entry.digest !== spec.image.digest || !entry.image.includes("@sha256:")) throw new ResourceError("RUNTIME_IMAGE_DENIED", "Runtime image is not in the signed catalog.", 403);
  return entry.image;
}

async function safePath(workspaceId: string, relative: string, forCreation = false): Promise<string> {
  const normalized = relative.replaceAll("\\", "/"); assertWorkspacePath(normalized);
  if (/^(?:\.harness(?:\/|$)|\.harness-restore-|lost\+found(?:\/|$))/u.test(normalized)) throw new ResourceError("WORKSPACE_PATH_RESERVED", "Path is reserved by the workspace runtime.", 403);
  const root = workspaceRoot(workspaceId); const candidate = path.resolve(root, normalized);
  const boundary = `${path.resolve(root)}${path.sep}`;
  if (!candidate.startsWith(boundary)) throw new ResourceError("WORKSPACE_PATH_ESCAPE", "Path escapes the workspace.", 403);
  let check = forCreation ? path.dirname(candidate) : candidate;
  if (forCreation) {
    while (check !== root) {
      try { await lstat(check); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        check = path.dirname(check);
      }
    }
  }
  const resolved = await realpath(check);
  if (resolved !== path.resolve(root) && !resolved.startsWith(boundary)) throw new ResourceError("WORKSPACE_SYMLINK_ESCAPE", "Path resolves outside the workspace.", 403);
  return candidate;
}

async function saveRuntime(workspaceId: string, spec: RuntimeSpec): Promise<void> {
  const directory = path.join(workspaceRoot(workspaceId), ".harness");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, "runtime.json"), JSON.stringify(spec), { mode: 0o600 });
  await chown(directory, 0, 0); await chown(path.join(directory, "runtime.json"), 0, 0);
}

async function ensureWorkspaceStorage(workspaceId: string, diskMiB: number): Promise<void> {
  const root = workspaceRoot(workspaceId); await mkdir(DISK_ROOT, { recursive: true, mode: 0o700 });
  const imageFile = path.join(DISK_ROOT, `${workspaceId}.ext4`); const mounted = await run("/usr/bin/findmnt", ["--noheadings", "--output", "SOURCE", "--target", root], 10_000, undefined, 4000).catch(() => ({ exitCode: 1, stdout: "", stderr: "", timedOut: false }));
  if (mounted.exitCode === 0) return;
  try { await stat(imageFile); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const allocated = await run("/usr/bin/truncate", ["--size", `${diskMiB}M`, imageFile], 30_000);
    if (allocated.exitCode !== 0) throw new ResourceError("WORKSPACE_DISK_FAILED", "Workspace disk could not be allocated.", 503);
    const formatted = await run("/usr/sbin/mkfs.ext4", ["-q", "-F", imageFile], 120_000, undefined, 20_000);
    if (formatted.exitCode !== 0) { await rm(imageFile, { force: true }); throw new ResourceError("WORKSPACE_DISK_FAILED", "Workspace disk could not be formatted.", 503); }
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const attached = await run("/usr/bin/mount", ["-o", "loop,nodev,nosuid", imageFile, root], 30_000, undefined, 20_000);
  if (attached.exitCode !== 0) throw new ResourceError("WORKSPACE_DISK_FAILED", "Workspace disk could not be mounted.", 503);
  await chown(root, 1000, 1000);
}

async function loadRuntime(workspaceId: string): Promise<RuntimeSpec> {
  const value = JSON.parse(await readFile(path.join(workspaceRoot(workspaceId), ".harness", "runtime.json"), "utf8")) as RuntimeSpec;
  image(value); return value;
}

async function run(executable: string, args: string[], timeoutMs: number, input?: string, maximumBytes = 1_000_000): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C.UTF-8" } });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0); let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0); let timedOut = false; let exceeded = false;
    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
      if (current.byteLength + chunk.byteLength > maximumBytes) { exceeded = true; child.kill("SIGKILL"); return current; }
      return Buffer.concat([current, chunk]);
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once("error", reject);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.once("close", code => { clearTimeout(timer); if (exceeded) reject(new ResourceError("PROCESS_OUTPUT_LIMIT", "Process output exceeded its limit.", 422)); else resolve({ exitCode: code ?? 1, stdout: stdout.toString(), stderr: stderr.toString(), timedOut }); });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

async function docker(args: string[], timeoutMs = 30_000, input?: string, maximumBytes?: number): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  return run("/usr/bin/docker", args, timeoutMs, input, maximumBytes);
}

const workspaceQueues = new Map<string, Promise<void>>();

async function withPausedWorkspaceProcesses<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
  const listed = await docker(["ps", "--filter", `label=daoyin.harness.workspace=${workspaceId}`,
    "--filter", "label=daoyin.harness.process", "--format", "{{.Names}}"], 15_000, undefined, 200_000);
  if (listed.exitCode !== 0) throw new ResourceError("WORKSPACE_FREEZE_FAILED", "Workspace processes could not be inspected safely.", 503);
  const names = listed.stdout.split(/\r?\n/u).map(value => value.trim()).filter(value => /^hr-prc_[a-f0-9]{24}$/u.test(value));
  const paused: string[] = [];
  try {
    for (const name of names) {
      const result = await docker(["pause", name], 15_000, undefined, 20_000);
      if (result.exitCode !== 0) throw new ResourceError("WORKSPACE_FREEZE_FAILED", "Workspace process could not be paused safely.", 503);
      paused.push(name);
    }
    return await operation();
  } finally {
    for (const name of paused.reverse()) {
      const resumed = await docker(["unpause", name], 15_000, undefined, 20_000).catch(() => ({ exitCode: 1 }));
      if (resumed.exitCode !== 0) await docker(["rm", "-f", name], 30_000, undefined, 20_000).catch(() => undefined);
    }
  }
}

function safeEnvironment(value: Record<string, string> | undefined): string[] {
  const result: string[] = [];
  for (const [key, item] of Object.entries(value ?? {})) {
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/u.test(key) || /(?:TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|AUTH|API_KEY|ACCESS_KEY)/u.test(key) || item.includes("\0") || item.length > 16_000) {
      throw new ResourceError("PROCESS_ENV_DENIED", "Process environment contains a denied key or value.", 403);
    }
    result.push("--env", `${key}=${item}`);
  }
  return result;
}

function assertProcessInput(executable: string, args: readonly string[]): void {
  if (!executable || executable.includes("\0") || args.length > 128 || args.some(value => value.includes("\0") || value.length > 16_000)) {
    throw new ResourceError("PROCESS_INPUT_INVALID", "Executable or arguments are invalid.");
  }
  if (args.some(value => /(?:^|[?&;\s])(?:authorization|token|secret|password|passwd|api[-_]?key|access[-_]?key)=/iu.test(value) ||
      /^(?:--?(?:password|passwd|token|secret|api[-_]?key|access[-_]?key))(?:=|$)/iu.test(value) || /^Bearer\s+/iu.test(value))) {
    throw new ResourceError("PROCESS_SECRET_ARGUMENT_DENIED", "Pass credentials through a configured secretRef file, not process arguments.", 403);
  }
  for (const value of args) {
    try { const url = new URL(value); if (url.username || url.password) throw new ResourceError("PROCESS_SECRET_ARGUMENT_DENIED", "Credential-bearing URLs are not allowed in process arguments.", 403); }
    catch (error) { if (error instanceof ResourceError) throw error; }
  }
}

function egressEnvironment(workspaceId: string, runId: string, timeoutSeconds: number): string[] {
  if (!EGRESS_PROXY || EGRESS_SECRET.length < 32) throw new ResourceError("EGRESS_UNAVAILABLE", "Controlled public egress is not configured.", 503);
  const payload = Buffer.from(JSON.stringify({ workspaceId, runId: runId.slice(0, 160), expiresAt: Date.now() + timeoutSeconds * 1000 + 300_000 })).toString("base64url");
  const signature = createHmac("sha256", EGRESS_SECRET).update(payload).digest("base64url");
  const url = new URL(EGRESS_PROXY); url.username = payload; url.password = signature;
  return ["--env", `HTTP_PROXY=${url.href}`, "--env", `HTTPS_PROXY=${url.href}`, "--env", `ALL_PROXY=${url.href}`,
    "--env", "NO_PROXY=localhost,127.0.0.1,::1"];
}

async function secretArguments(name: string, expectedRefs: readonly string[], values: readonly ResolvedSecret[] | undefined): Promise<string[]> {
  if (!expectedRefs.length) return [];
  if (!values || values.length !== expectedRefs.length) throw new ResourceError("SECRET_RESOLUTION_REQUIRED", "Workspace secrets were not resolved by the trusted service.", 503);
  const expected = new Set(expectedRefs); const seen = new Set<string>(); const directory = path.join(SECRET_ROOT, name);
  await rm(directory, { recursive: true, force: true }); await mkdir(directory, { recursive: true, mode: 0o700 });
  const mapping: Record<string, string> = {};
  try {
    for (const item of values) {
      if (!expected.has(item.ref) || seen.has(item.ref) || typeof item.value !== "string" || item.value.length > 262_144) throw new ResourceError("SECRET_RESPONSE_INVALID", "Resolved workspace secrets are invalid.", 503);
      seen.add(item.ref); const file = createHash("sha256").update(item.ref).digest("hex"); const hostPath = path.join(directory, file); const containerPath = `/run/secrets/${file}`;
      await writeFile(hostPath, item.value, { flag: "wx", mode: 0o400 }); await chown(hostPath, 1000, 1000);
      mapping[item.ref] = containerPath;
    }
    if (seen.size !== expected.size) throw new ResourceError("SECRET_RESPONSE_INVALID", "Resolved workspace secrets are incomplete.", 503);
    await chown(directory, 1000, 1000); await chmod(directory, 0o500);
    return ["--mount", `type=bind,src=${directory},dst=/run/secrets,readonly`, "--env", `HARNESS_SECRET_FILES=${JSON.stringify(mapping)}`];
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

const cleanupSecrets = (name: string): Promise<void> => rm(path.join(SECRET_ROOT, name), { recursive: true, force: true });
async function redactSecretOutput(name: string, value: string): Promise<string> {
  let result = value; const directory = path.join(SECRET_ROOT, name);
  try {
    for (const file of await readdir(directory)) {
      const secret = await readFile(path.join(directory, file), "utf8");
      if (secret) result = result.replaceAll(secret, "[REDACTED_SECRET]");
    }
  } catch { /* No secret material was mounted. */ }
  return result;
}

function commonArgs(workspaceId: string, spec: RuntimeSpec, name: string, runId = "system"): string[] {
  const root = workspaceRoot(workspaceId); const network = spec.network === "public" ? EGRESS_NETWORK : "none";
  return ["run", "--runtime", RUNTIME, "--name", name, "--label", "daoyin.harness.resource=1", "--label", `daoyin.harness.workspace=${workspaceId}`,
    "--network", network, "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
    "--memory", `${spec.limits.memoryMiB}m`, "--memory-swap", `${spec.limits.memoryMiB}m`, "--cpus", String(spec.limits.cpu), "--pids-limit", String(spec.limits.pids),
    "--ulimit", "nofile=2048:2048", "--log-driver", "local", "--log-opt", "max-size=4m", "--log-opt", "max-file=3",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m,mode=1777", "--mount", `type=bind,src=${root},dst=/workspace`, "--workdir", "/workspace",
    "--env", "HOME=/tmp", "--env", "CI=1", "--env", "NO_COLOR=1",
    ...(spec.network === "public" ? egressEnvironment(workspaceId, runId, spec.limits.timeoutSeconds) : []),
    ...safeEnvironment(spec.environment)];
}

async function scan(workspaceId: string): Promise<WorkspaceEntry[]> {
  const root = workspaceRoot(workspaceId); const entries: WorkspaceEntry[] = []; let total = 0; let count = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      if (name === ".harness" || name === "lost+found" || name.startsWith(".harness-restore-")) continue;
      const target = path.join(directory, name); const info = await lstat(target); const relative = path.relative(root, target).replaceAll("\\", "/");
      if (++count > 100_000) throw new ResourceError("WORKSPACE_ENTRY_LIMIT", "Workspace contains too many entries.", 413);
      if (info.isSymbolicLink()) {
        const raw = await readlink(target);
        if (path.isAbsolute(raw) || path.normalize(path.join(path.dirname(relative), raw)).startsWith("..")) throw new ResourceError("WORKSPACE_SYMLINK_ESCAPE", "Workspace contains an escaping symbolic link.", 422);
        entries.push({ path: relative, kind: "symlink", mode: info.mode & 0o777, size: Buffer.byteLength(raw), target: raw });
      } else if (info.isDirectory()) await walk(target);
      else if (info.isFile()) {
        total += info.size; if (total > 2 * 1024 * 1024 * 1024) throw new ResourceError("WORKSPACE_SNAPSHOT_LIMIT", "Workspace exceeds the snapshot limit.", 413);
        const blob = await content.put(await readFile(target));
        entries.push({ path: relative, kind: "file", mode: info.mode & 0o777, size: info.size, blobHash: blob.digest });
      } else throw new ResourceError("WORKSPACE_ENTRY_INVALID", "Workspace contains an unsupported entry.", 422);
    }
  };
  await walk(root); return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function materialize(workspaceId: string, entries: readonly WorkspaceEntry[]): Promise<void> {
  const root = workspaceRoot(workspaceId); const temporary = path.join(root, `.harness-restore-${randomBytes(6).toString("hex")}`);
  await mkdir(temporary, { recursive: false, mode: 0o700 });
  try {
    for (const entry of entries) {
      assertWorkspacePath(entry.path);
      if (/^(?:\.harness(?:\/|$)|\.harness-restore-|lost\+found(?:\/|$))/u.test(entry.path)) throw new ResourceError("WORKSPACE_PATH_RESERVED", "Snapshot contains a reserved workspace path.");
      const target = path.join(temporary, entry.path); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      if (entry.kind === "file") await writeFile(target, await content.read(entry.blobHash), { mode: entry.mode, flag: "wx" });
      else { if (path.isAbsolute(entry.target) || path.normalize(path.join(path.dirname(entry.path), entry.target)).startsWith("..")) throw new ResourceError("WORKSPACE_SYMLINK_ESCAPE", "Snapshot contains an escaping symbolic link."); await symlink(entry.target, target); }
    }
    for (const name of await readdir(root)) if (path.join(root, name) !== temporary) await rm(path.join(root, name), { recursive: true, force: true });
    for (const name of await readdir(temporary)) await rename(path.join(temporary, name), path.join(root, name));
    await rm(temporary, { recursive: true, force: true });
    const ownership = await run("/usr/bin/chown", ["-R", "1000:1000", root], 60_000, undefined, 20_000);
    if (ownership.exitCode !== 0) throw new ResourceError("WORKSPACE_OWNERSHIP_FAILED", "Workspace ownership could not be restored.", 503);
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}

function runtimeFrom(request: ExecutorProcessRequest): RuntimeSpec {
  if (!request.runtime) throw new ResourceError("RUNTIME_REQUIRED", "Workspace runtime is required.");
  assertRuntimeSpec(request.runtime);
  image(request.runtime); return request.runtime;
}

async function prepare(request: ExecutorProcessRequest): Promise<Record<string, unknown>> {
  const workspaceId = request.workspaceId!; assertResourceId(workspaceId, "wsp"); const root = workspaceRoot(workspaceId);
  if (request.operation === "snapshot") return { entries: await scan(workspaceId) };
  if (request.operation === "set_runtime") { await saveRuntime(workspaceId, runtimeFrom(request)); return { runtimeUpdated: true }; }
  if (request.operation === "restore") { const spec = await loadRuntime(workspaceId); await materialize(workspaceId, request.entries ?? []); await saveRuntime(workspaceId, spec); return { entries: await scan(workspaceId) }; }
  await ensureWorkspaceStorage(workspaceId, runtimeFrom(request).limits.diskMiB);
  const source = request.source ?? { kind: "empty" as const };
  const spec = runtimeFrom(request);
  if (source.kind === "empty") { await saveRuntime(workspaceId, spec); return { entries: [] }; }
  if (source.kind === "snapshot") { await materialize(workspaceId, request.entries ?? []); await saveRuntime(workspaceId, spec); return { entries: await scan(workspaceId) }; }
  if (source.kind === "upload") {
    if (!request.archiveDigest || !request.mediaType) throw new ResourceError("WORKSPACE_UPLOAD_INVALID", "Uploaded workspace package metadata is missing.");
    const archive = path.join(root, `.harness-upload-${randomBytes(6).toString("hex")}`);
    await writeFile(archive, await content.read(request.archiveDigest, 128 * 1024 * 1024), { flag: "wx", mode: 0o400 }); await chown(archive, 1000, 1000);
    try {
      const command = request.mediaType === "application/zip" ? { executable: "unzip", args: ["-q", `/workspace/${path.basename(archive)}`, "-d", "/workspace"] }
        : ["application/x-tar", "application/gzip", "application/x-gzip", "application/gzip-compressed"].includes(request.mediaType)
          ? { executable: "tar", args: [request.mediaType === "application/x-tar" ? "-xf" : "-xzf", `/workspace/${path.basename(archive)}`, "-C", "/workspace"] }
          : undefined;
      if (!command) throw new ResourceError("WORKSPACE_UPLOAD_TYPE_DENIED", "Uploaded workspace package must be zip, tar or tar.gz.", 422);
      const extracted = await foreground(workspaceId, spec, command.executable, command.args, ".", undefined, 120_000, undefined, request.runId);
      if (extracted.exitCode !== 0) throw new ResourceError("WORKSPACE_UPLOAD_EXTRACT_FAILED", extracted.stderr.slice(-2000) || "Uploaded workspace package could not be extracted.", 422);
    } finally { await rm(archive, { force: true }); }
    await rm(path.join(root, ".harness"), { recursive: true, force: true });
    const entries = await scan(workspaceId); await saveRuntime(workspaceId, spec); return { entries };
  }
  if (source.kind !== "git") throw new ResourceError("WORKSPACE_SOURCE_PENDING", "This workspace source requires an uploaded artifact materialization step.", 501);
  const container = `hr-import-${workspaceId.slice(4)}`;
  const importPath = path.join(root, ".harness-import-repo");
  const args = [...commonArgs(workspaceId, spec, container, request.runId), "--rm", image(spec), "git", "clone", "--no-checkout", "--", source.url, "/workspace/.harness-import-repo"];
  const clone = await docker(args, Math.min(spec.limits.timeoutSeconds * 1000, 600_000), undefined, spec.limits.maxOutputBytes);
  if (clone.exitCode !== 0) throw new ResourceError("WORKSPACE_GIT_CLONE_FAILED", `Git import failed: ${clone.stderr.slice(-2000)}`, 422);
  const checkout = await docker([...commonArgs(workspaceId, spec, `${container}-checkout`, request.runId), "--rm", image(spec), "git", "-C", "/workspace/.harness-import-repo", "checkout", "--detach", source.revision], 120_000);
  if (checkout.exitCode !== 0) throw new ResourceError("WORKSPACE_GIT_REVISION_FAILED", `Git revision could not be checked out: ${checkout.stderr.slice(-2000)}`, 422);
  for (const name of await readdir(importPath)) await rename(path.join(importPath, name), path.join(root, name));
  await rm(importPath, { recursive: true, force: true });
  await rm(path.join(root, ".harness"), { recursive: true, force: true });
  const entries = await scan(workspaceId); await saveRuntime(workspaceId, spec);
  return { entries };
}

async function importImage(request: ExecutorProcessRequest): Promise<Record<string, unknown>> {
  const workspaceId = request.workspaceId!; assertResourceId(workspaceId, "wsp");
  if (!request.archive || !request.archiveDigest || !/^sha256:[a-f0-9]{64}$/u.test(request.archiveDigest)) throw new ResourceError("OCI_ARCHIVE_INVALID", "Built OCI archive is invalid.");
  const root = await realpath(BUILD_OUTPUT_ROOT); const archive = await realpath(request.archive);
  if (!archive.startsWith(`${root}${path.sep}`) || !path.basename(archive).startsWith(`${workspaceId}-`)) throw new ResourceError("OCI_ARCHIVE_ESCAPE", "Built OCI archive is outside the protected output directory.", 403);
  const checked = await run("/usr/bin/sha256sum", [archive], 120_000, undefined, 2000);
  if (checked.exitCode !== 0 || `sha256:${checked.stdout.trim().split(/\s+/u)[0]}` !== request.archiveDigest) throw new ResourceError("OCI_ARCHIVE_DIGEST_MISMATCH", "Built OCI archive digest verification failed.", 409);
  try {
    const loaded = await docker(["load", "--input", archive], 300_000, undefined, 200_000);
    if (loaded.exitCode !== 0) throw new ResourceError("OCI_IMAGE_IMPORT_FAILED", loaded.stderr.slice(-4000) || "Built OCI image could not be imported.", 422);
    const reference = /Loaded image(?: ID)?:\s*(\S+)/u.exec(`${loaded.stdout}\n${loaded.stderr}`)?.[1];
    if (!reference) throw new ResourceError("OCI_IMAGE_IMPORT_FAILED", "Imported OCI image did not return a content reference.", 422);
    const inspected = await docker(["image", "inspect", "--format", "{{.Id}}", reference], 30_000, undefined, 2000);
    const imageDigest = inspected.stdout.trim();
    if (inspected.exitCode !== 0 || !/^sha256:[a-f0-9]{64}$/u.test(imageDigest)) throw new ResourceError("OCI_IMAGE_IMPORT_FAILED", "Imported OCI image digest is unavailable.", 422);
    return { imageDigest };
  } finally { await rm(archive, { force: true }); }
}

async function fileOperation(request: ExecutorProcessRequest): Promise<Record<string, unknown>> {
  const workspaceId = request.workspaceId!; const operation = request.operation ?? "";
  if (operation === "list") {
    const root = request.path ? await safePath(workspaceId, request.path) : workspaceRoot(workspaceId);
    const values = await readdir(root, { withFileTypes: true });
    return { entries: values.filter(item => item.name !== ".harness" && item.name !== "lost+found" && !item.name.startsWith(".harness-restore-")).slice(0, 5000).map(item => ({ name: item.name, kind: item.isDirectory() ? "directory" : item.isSymbolicLink() ? "symlink" : "file" })) };
  }
  if (operation === "stat") {
    const target = await safePath(workspaceId, request.path!); const info = await lstat(target);
    return { path: request.path, kind: info.isDirectory() ? "directory" : info.isSymbolicLink() ? "symlink" : "file", mode: info.mode & 0o777, size: info.size, modifiedAt: info.mtime.toISOString(), ...(info.isSymbolicLink() ? { target: await readlink(target) } : {}) };
  }
  if (operation === "read" || operation === "read_binary") {
    const target = await safePath(workspaceId, request.path!); const maximum = Math.min(request.maximumBytes ?? 1_000_000, operation === "read_binary" ? 128 * 1024 * 1024 : 1_000_000);
    const info = await stat(target); if (!info.isFile() || info.size > maximum) throw new ResourceError("FILE_READ_LIMIT", "File exceeds the read budget.", 413);
    const data = await readFile(target);
    if (operation === "read_binary") return { contentBase64: data.toString("base64"), size: data.length };
    if (data.includes(0)) throw new ResourceError("FILE_BINARY", "Binary file must be read through an artifact reference.", 422);
    const lines = data.toString("utf8").split(/\r?\n/u); const start = Math.max(1, request.startLine ?? 1); const end = Math.min(lines.length, request.endLine ?? lines.length);
    return { path: request.path, startLine: start, endLine: end, totalLines: lines.length, content: lines.slice(start - 1, end).join("\n") };
  }
  if (operation === "write") {
    const target = await safePath(workspaceId, request.path!, true); const data = request.contentBase64 === undefined ? Buffer.from(request.content ?? "") : Buffer.from(request.contentBase64, "base64");
    if (data.length > 16 * 1024 * 1024) throw new ResourceError("FILE_WRITE_LIMIT", "File exceeds the write limit.", 413);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o755 }); const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, data, { flag: "wx", mode: 0o644 }); await chown(temporary, 1000, 1000); await rename(temporary, target);
    return { path: request.path, size: data.length, digest: `sha256:${createHash("sha256").update(data).digest("hex")}` };
  }
  if (operation === "patch") {
    if (request.patch !== undefined) {
      const spec = await loadRuntime(workspaceId); const result = await foreground(workspaceId, spec, "git", ["apply", "--whitespace=nowarn", "-"], ".", request.patch, 120_000, undefined, request.runId);
      if (result.exitCode !== 0) throw new ResourceError("PATCH_CONFLICT", `Patch did not apply: ${result.stderr.slice(-2000)}`, 409);
      return result;
    }
    const target = await safePath(workspaceId, request.path!); const text = await readFile(target, "utf8"); const expected = request.expected ?? "";
    const first = text.indexOf(expected); if (first < 0 || text.indexOf(expected, first + expected.length) >= 0) throw new ResourceError("PATCH_CONTEXT_CONFLICT", "Expected text is missing or ambiguous.", 409);
    await writeFile(target, text.slice(0, first) + (request.replacement ?? "") + text.slice(first + expected.length), "utf8"); return { path: request.path };
  }
  if (operation === "mkdir") { const target = await safePath(workspaceId, request.path!, true); await mkdir(target, { recursive: true, mode: 0o755 }); await chown(target, 1000, 1000); return { path: request.path }; }
  if (operation === "move") { const from = await safePath(workspaceId, request.from!); const to = await safePath(workspaceId, request.to!, true); await mkdir(path.dirname(to), { recursive: true }); await rename(from, to); return { from: request.from, to: request.to }; }
  if (operation === "remove") { const target = await safePath(workspaceId, request.path!); await rm(target, { recursive: true, force: false }); return { path: request.path }; }
  if (operation === "search") {
    const spec = await loadRuntime(workspaceId);
    if (!request.query) throw new ResourceError("FILE_SEARCH_QUERY_REQUIRED", "Search query is required.");
    const args = request.searchMode === "glob"
      ? ["--files", "-g", request.query, ...(request.glob ? ["-g", request.glob] : []), "--", request.path ?? "."]
      : ["--json", "--max-count", "200", "--max-columns", "500", ...(request.searchMode === "literal" ? ["-F"] : []), ...(request.glob ? ["-g", request.glob] : []), "--", request.query, request.path ?? "."];
    const result = await foreground(workspaceId, spec, "rg", args, ".", undefined, 30_000, undefined, request.runId);
    if (result.exitCode !== 0 && result.exitCode !== 1) throw new ResourceError("FILE_SEARCH_FAILED", result.stderr.slice(-2000), 422);
    if (request.searchMode === "glob") return { paths: result.stdout.split("\n").filter(Boolean).slice(0, 500) };
    return { matches: result.stdout.split("\n").filter(Boolean).slice(0, 500).map(line => JSON.parse(line) as unknown) };
  }
  throw new ResourceError("FILE_OPERATION_DENIED", "File operation is not allowed.", 403);
}

async function foreground(workspaceId: string, spec: RuntimeSpec, executable: string, args: string[], cwd = ".", stdin?: string, timeoutMs?: number, environment?: Record<string, string>, runId = "system", secretValues?: ResolvedSecret[]): Promise<Record<string, unknown> & { exitCode: number; stdout: string; stderr: string }> {
  assertProcessInput(executable, args);
  assertWorkspacePath(cwd === "." ? "workspace" : cwd);
  const name = `hr-run-${workspaceId.slice(4, 16)}-${randomBytes(4).toString("hex")}`;
  const secrets = await secretArguments(name, spec.secretRefs, secretValues);
  try {
    const command = [...commonArgs(workspaceId, spec, name, runId), "--rm", ...secrets, ...safeEnvironment(environment), "--workdir", `/workspace/${cwd === "." ? "" : cwd}`, "-i", image(spec), executable, ...args];
    const result = await docker(command, Math.min(timeoutMs ?? spec.limits.timeoutSeconds * 1000, spec.limits.timeoutSeconds * 1000), stdin, spec.limits.maxOutputBytes);
    return { ...result, stdout: await redactSecretOutput(name, result.stdout), stderr: await redactSecretOutput(name, result.stderr),
      sandbox: "gVisor", network: spec.network === "public" ? "controlled-public" : "none" };
  } finally { await cleanupSecrets(name); }
}

async function gitOperation(request: ExecutorProcessRequest): Promise<Record<string, unknown>> {
  const workspaceId = request.workspaceId!; const spec = await loadRuntime(workspaceId); const operation = request.operation ?? "";
  const commands: Record<string, string[]> = {
    status: ["status", "--short", "--branch"], diff: ["diff", "--no-ext-diff", "--no-textconv", ...(request.revision ? [request.revision] : [])],
    log: ["log", "--oneline", "-50"], checkout: ["checkout", "--detach", request.revision ?? ""], branch: ["switch", "-c", request.revision ?? ""],
    commit: ["-c", "user.name=Daoyin Harness", "-c", "user.email=harness@invalid", "commit", "-m", request.message ?? "Harness update"],
    export_patch: ["diff", "--binary", "HEAD"],
  };
  const args = commands[operation]; if (!args) throw new ResourceError("GIT_OPERATION_DENIED", "Git operation is not allowed.", 403);
  if (operation === "commit") {
    const staged = await foreground(workspaceId, spec, "git", ["add", "-A"], ".", undefined, 120_000, undefined, request.runId);
    if (staged.exitCode !== 0) throw new ResourceError("GIT_OPERATION_FAILED", staged.stderr.slice(-2000) || "Git changes could not be staged.", 422);
  }
  const result = await foreground(workspaceId, spec, "git", args, ".", undefined, 120_000, undefined, request.runId);
  if (result.exitCode !== 0) throw new ResourceError("GIT_OPERATION_FAILED", result.stderr.slice(-2000) || "Git operation failed.", 422);
  return operation === "export_patch" ? { content: result.stdout } : result;
}

async function processOperation(request: ExecutorProcessRequest): Promise<Record<string, unknown>> {
  const workspaceId = request.workspaceId!; const operation = request.operation ?? ""; const spec = await loadRuntime(workspaceId);
  if (operation === "run") return foreground(workspaceId, spec, request.executable ?? "", request.args ?? [], request.cwd, request.stdin, request.timeoutMs, request.environment, request.runId, request.secretValues);
  if (operation === "start") {
    if (request.mode !== "background" && request.mode !== "pty") throw new ResourceError("PROCESS_MODE_INVALID", "Background or PTY mode is required.");
    assertProcessInput(request.executable ?? "", request.args ?? []);
    const processId = `prc_${randomBytes(12).toString("hex")}`; const name = `hr-${processId}`;
    const startedAt = new Date().toISOString();
    const timeoutAt = Date.now() + Math.min(request.timeoutMs ?? spec.limits.timeoutSeconds * 1000, spec.limits.timeoutSeconds * 1000);
    const secrets = await secretArguments(name, spec.secretRefs, request.secretValues);
    const args = [...commonArgs(workspaceId, spec, name, request.runId), "-d", "--label", `daoyin.harness.process=${processId}`,
      "--label", `daoyin.harness.mode=${request.mode}`, "--label", `daoyin.harness.started_at=${startedAt}`,
      "--label", `daoyin.harness.timeout_at=${String(timeoutAt)}`,
      ...(request.mode === "pty" ? ["-i", "-t"] : []), ...secrets, ...safeEnvironment(request.environment),
      "--workdir", `/workspace/${request.cwd && request.cwd !== "." ? request.cwd : ""}`, image(spec), request.executable ?? "", ...(request.args ?? [])];
    const result = await docker(args, 30_000); if (result.exitCode !== 0) { await cleanupSecrets(name); throw new ResourceError("PROCESS_START_FAILED", result.stderr.slice(-2000), 422); }
    processes.set(processId, { workspaceId, name, mode: request.mode, startedAt, timeoutAt });
    return { processId, status: "running", mode: request.mode, timeoutAt: new Date(timeoutAt).toISOString() };
  }
  if (operation === "read") {
    const processId = request.processId ?? ""; const session = await processSession(workspaceId, processId);
    if (session.timeoutAt > 0 && Date.now() >= session.timeoutAt) {
    await docker(["rm", "-f", session.name], 30_000); processes.delete(processId);
    await cleanupSecrets(session.name);
      return { processId, output: "", cursor: request.cursor ?? 0, truncated: false, state: "timed_out", exitCode: null };
    }
    const result = await docker(["logs", session.name], 20_000, undefined, 16_000_000);
    const inspect = await docker(["inspect", "--format", "{{.State.Status}} {{.State.ExitCode}}", session.name], 10_000);
    const all = Buffer.from(result.stdout + result.stderr); const requested = Math.max(0, request.cursor ?? 0);
    const start = Math.min(requested, all.byteLength); const maximum = 1_000_000; const end = Math.min(all.byteLength, start + maximum);
    const [state = "unknown", exit = ""] = inspect.stdout.trim().split(/\s+/u);
    const output = await redactSecretOutput(session.name, all.subarray(start, end).toString("utf8"));
    if (["exited", "dead"].includes(state)) await cleanupSecrets(session.name);
    return { processId, output, cursor: end,
      truncated: end < all.byteLength, state, exitCode: state === "exited" ? Number(exit) : null };
  }
  if (operation === "write") {
    const processId = request.processId ?? ""; const session = await processSession(workspaceId, processId); if (session.mode !== "pty") throw new ResourceError("PROCESS_PTY_REQUIRED", "A running PTY process is required.", 409);
    const result = await docker(["attach", "--sig-proxy=false", "--detach-keys", "ctrl-]", session.name], 10_000, `${request.stdin ?? ""}\x1d`, 100_000);
    return { processId, accepted: !result.timedOut && result.exitCode === 0 };
  }
  if (operation === "stop") {
    const processId = request.processId ?? ""; const session = await processSession(workspaceId, processId);
    await docker(["rm", "-f", session.name], 30_000); processes.delete(processId); await cleanupSecrets(session.name); return { processId, status: "cancelled" };
  }
  if (operation === "list") return { processes: [...processes.entries()].filter(([, value]) => value.workspaceId === workspaceId).map(([processId, value]) => ({ processId, mode: value.mode, startedAt: value.startedAt, timeoutAt: new Date(value.timeoutAt).toISOString() })) };
  throw new ResourceError("PROCESS_OPERATION_DENIED", "Process operation is not allowed.", 403);
}

async function readiness(): Promise<Record<string, unknown>> {
  const info = await docker(["info", "--format", "{{json .Runtimes}}"], 15_000); if (info.exitCode !== 0) throw new ResourceError("SANDBOX_UNAVAILABLE", "Container runtime is unavailable.", 503);
  const runtimes = JSON.parse(info.stdout) as Record<string, unknown>; if (!runtimes[RUNTIME]) throw new ResourceError("SANDBOX_UNAVAILABLE", "gVisor runtime is unavailable.", 503);
  const network = await docker(["network", "inspect", "--format", "{{.Internal}} {{index .Labels \"daoyin.harness.egress\"}}", EGRESS_NETWORK], 15_000);
  if (network.exitCode !== 0 || network.stdout.trim() !== "true controlled-public") throw new ResourceError("EGRESS_UNAVAILABLE", "Controlled public egress network is unavailable or permits direct routing.", 503);
  if (!SANDBOX_PROBE?.imageId || !SANDBOX_PROBE.executable || !Array.isArray(SANDBOX_PROBE.args)) throw new ResourceError("SANDBOX_PROBE_REQUIRED", "A signed gVisor startup probe is required.", 503);
  const probeImage = IMAGE_CATALOG[SANDBOX_PROBE.imageId];
  if (!probeImage || !probeImage.image.includes("@sha256:")) throw new ResourceError("SANDBOX_PROBE_INVALID", "The gVisor startup probe image is not signed.", 503);
  const probe = await docker(["run", "--rm", "--runtime", RUNTIME, "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--pids-limit", "16", "--memory", "64m", probeImage.image,
    SANDBOX_PROBE.executable, ...SANDBOX_PROBE.args], 30_000, undefined, 20_000);
  if (probe.exitCode !== 0) throw new ResourceError("SANDBOX_PROBE_FAILED", "The gVisor startup probe failed.", 503);
  return { ready: true, runtime: RUNTIME, publicNetwork: "controlled", images: Object.keys(IMAGE_CATALOG) };
}

async function dispatch(request: ExecutorProcessRequest): Promise<Record<string, unknown>> {
  if (request.action === "readiness") return readiness();
  if (!request.workspaceId) throw new ResourceError("WORKSPACE_REQUIRED", "Workspace is required.");
  if (request.action === "workspace_prepare") return withPausedWorkspaceProcesses(request.workspaceId, () => prepare(request));
  if (request.action === "workspace_remove") {
    const root = workspaceRoot(request.workspaceId); const imageFile = path.join(DISK_ROOT, `${request.workspaceId}.ext4`);
    await run("/usr/bin/umount", [root], 30_000, undefined, 20_000).catch(() => undefined);
    await rm(root, { recursive: true, force: true }); await rm(imageFile, { force: true }); return { removed: true };
  }
  if (request.action === "image_import") return importImage(request);
  if (request.action === "file") return withPausedWorkspaceProcesses(request.workspaceId, () => fileOperation(request));
  if (request.action === "git") return withPausedWorkspaceProcesses(request.workspaceId, () => gitOperation(request));
  if (request.action === "process") return processOperation(request);
  if (request.action === "reconcile") { await reconcileProcesses(); return { processes: [...processes.keys()] }; }
  throw new ResourceError("EXECUTOR_ACTION_DENIED", "Executor operation is not allowed.", 403);
}

function dispatchSerialized(request: ExecutorProcessRequest): Promise<Record<string, unknown>> {
  if (request.action === "readiness" || !request.workspaceId) return dispatch(request);
  const previous = workspaceQueues.get(request.workspaceId) ?? Promise.resolve();
  const pending = previous.then(() => dispatch(request));
  const settled = pending.then(() => undefined, () => undefined);
  workspaceQueues.set(request.workspaceId, settled);
  void settled.finally(() => { if (workspaceQueues.get(request.workspaceId!) === settled) workspaceQueues.delete(request.workspaceId!); });
  return pending;
}

await mkdir(ROOT, { recursive: true, mode: 0o711 }); await mkdir(path.dirname(SOCKET), { recursive: true, mode: 0o750 }); await unlink(SOCKET).catch(() => undefined);
await readiness();
await reconcileProcesses();
await reconcileProcessSecrets();
const timeoutSweep = setInterval(() => { void enforceProcessTimeouts(); }, 5_000); timeoutSweep.unref();
const server = http.createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/execute") { response.writeHead(404).end(); return; }
  let body = ""; request.on("data", chunk => { body += chunk.toString(); if (Buffer.byteLength(body) > 2_000_000) request.destroy(); });
  request.on("end", () => { void (async () => {
      try { const value = await dispatchSerialized(JSON.parse(body) as ExecutorProcessRequest); response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(value)); }
    catch (error) { const failure = error instanceof ResourceError ? error : new ResourceError("EXECUTOR_FAILED", "Sandbox executor failed.", 503); response.writeHead(failure.status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { code: failure.code, message: failure.message } })); }
  })(); });
});
server.listen(SOCKET, () => {
  const gid = Number(process.env.HARNESS_RESOURCE_GID); if (Number.isSafeInteger(gid) && gid > 0) void chown(SOCKET, 0, gid).then(() => chmod(SOCKET, 0o660));
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { clearInterval(timeoutSweep); server.close(); });
