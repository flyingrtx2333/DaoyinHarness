import http from "node:http";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { chmod, chown, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertResourceId, assertWorkspacePath, type RuntimeSpec, type WorkspaceEntry } from "@daoyin/harness-contracts";
import type { WorkspaceVersion } from "@daoyin/harness-protocol";
import { FileContentStore } from "./content-store.js";
import { ResourceError } from "./repository.js";
import { assertRuntimeSpec } from "./runtime-policy.js";
import { ensureWorkspaceEgress, isolateExistingContainer } from "./workspace-network.js";
import type { ExecutorProcessRequest, ResolvedSecret } from "./contracts.js";
import { assertFileVersion, fileBaseline, fileChange, fileDigest, fileMutation } from "./file-mutation.js";
import { applyTextPatch, parseTextPatch } from "./text-patch.js";
import { PROJECT_DECLARATIONS, environmentVersionProbes, environmentCacheKey, isDependencyDeclaration, environmentRuntimeAssessment } from "./environment.js";
import { ProcessReceiptStore, receiptPage } from "./process-receipts.js";
import { workspaceVersion } from "./workspace-version.js";

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
const IMAGE_CATALOG = JSON.parse(process.env.HARNESS_RUNTIME_IMAGES ?? "{}") as Record<string, { image: string; digest: string; capabilities?: string[] }>;
const SANDBOX_PROBE = JSON.parse(process.env.HARNESS_SANDBOX_PROBE ?? "null") as { imageId?: string; executable?: string; args?: string[] } | null;
const content = await FileContentStore.open(CONTENT_ROOT);
const receipts = new ProcessReceiptStore(path.join(CONTENT_ROOT, "process-receipts"));
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
    await isolateExistingContainer(name, workspaceId, EGRESS_NETWORK, (args, timeoutMs) => docker(args, timeoutMs, undefined, 100_000));
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
let processSweep: Promise<void> | undefined;
async function enforceProcessTimeouts(): Promise<void> {
  if (processSweep) return processSweep;
  processSweep = (async () => {
    for (const [processId, session] of processes) {
      await dispatchSerialized({ action: "process", operation: "read", workspaceId: session.workspaceId, processId })
        .catch(() => { console.error(`Process evidence could not be retained: ${processId}`); });
    }
  })();
  try { await processSweep; } finally { processSweep = undefined; }
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

async function runtimeDirectory(workspaceId: string, segments: readonly string[], userOwned = false): Promise<string> {
  let target = workspaceRoot(workspaceId);
  for (const segment of [".harness", ...segments]) {
    target = path.join(target, segment);
    await mkdir(target, { mode: 0o711 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ResourceError("WORKSPACE_RUNTIME_PATH_INVALID", "Runtime directories cannot be replaced by links or files.", 403);
  }
  await chmod(target, userOwned ? 0o700 : 0o711); await chown(target, userOwned ? 1000 : 0, userOwned ? 1000 : 0);
  return target;
}

async function saveRuntime(workspaceId: string, spec: RuntimeSpec): Promise<void> {
  const directory = await runtimeDirectory(workspaceId, []);
  const target = path.join(directory, "runtime.json");
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new ResourceError("WORKSPACE_RUNTIME_PATH_INVALID", "Runtime metadata cannot be a link.", 403);
  const temporary = path.join(directory, `runtime-${randomBytes(8).toString("hex")}.pending`);
  await writeFile(temporary, JSON.stringify(spec), { mode: 0o600, flag: "wx" }); await rename(temporary, target);
  await chown(target, 0, 0);
}

async function ensureWorkspaceRuntimeDirectories(workspaceId: string, cacheKey: string): Promise<void> {
  await runtimeDirectory(workspaceId, []);
  await runtimeDirectory(workspaceId, ["environments"]);
  await runtimeDirectory(workspaceId, ["environments", cacheKey]);
  for (const name of ["home", "cache", "python-user", "npm-global", "cargo", "go"]) {
    await runtimeDirectory(workspaceId, ["environments", cacheKey, name], true);
  }
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
  const directory = path.join(workspaceRoot(workspaceId), ".harness"); const target = path.join(directory, "runtime.json");
  const directoryInfo = await lstat(directory); const info = await lstat(target);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || !info.isFile() || info.isSymbolicLink())
    throw new ResourceError("WORKSPACE_RUNTIME_PATH_INVALID", "Runtime metadata paths cannot be links.", 403);
  const value = JSON.parse(await readFile(target, "utf8")) as RuntimeSpec;
  assertRuntimeSpec(value); image(value); return value;
}

async function sourceVersion(workspaceId: string, spec: RuntimeSpec, signal?: AbortSignal): Promise<WorkspaceVersion> {
  signal?.throwIfAborted();
  const running = await docker(["ps", "--filter", `label=daoyin.harness.workspace=${workspaceId}`, "--filter", "label=daoyin.harness.process", "--format", "{{.Names}}"], 10_000, undefined, 20_000, signal);
  signal?.throwIfAborted();
  if (running.exitCode !== 0 || running.timedOut) return { state: "unknown", reason: "SOURCE_WRITERS_UNOBSERVED" };
  if (running.stdout.trim()) return { state: "unknown", reason: "SOURCE_WRITER_RUNNING" };
  const declarations = await projectDeclarations(workspaceId, true);
  const digest = spec.image.kind === "builtin" ? spec.image.digest : spec.image.imageDigest!;
  return workspaceVersion(workspaceRoot(workspaceId), environmentCacheKey(digest, declarations, spec.environment), signal);
}

async function savedSourceVersion(workspaceId: string, processId: string): Promise<WorkspaceVersion> {
  assertResourceId(processId, "prc");
  try {
    const directory = await runtimeDirectory(workspaceId, ["process-source"]);
    const target = path.join(directory, `${processId}.json`); const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) return { state: "unknown", reason: "SOURCE_VERSION_METADATA_INVALID" };
    const value = JSON.parse(await readFile(target, "utf8")) as WorkspaceVersion;
    if (value.state === "known" && typeof value.digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(value.digest) || value.state === "unknown" && typeof value.reason === "string") return value;
  } catch { /* Historical and unacknowledged launches must remain unknown. */ }
  return { state: "unknown", reason: "SOURCE_VERSION_BEFORE_UNAVAILABLE" };
}

async function run(executable: string, args: string[], timeoutMs: number, input?: string, maximumBytes = 1_000_000, signal?: AbortSignal): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(executable, args, { shell: false, stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C.UTF-8" } });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0); let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0); let timedOut = false; let exceeded = false;
    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
      if (current.byteLength + chunk.byteLength > maximumBytes) { exceeded = true; child.kill("SIGKILL"); return current; }
      return Buffer.concat([current, chunk]);
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const abort = (): void => { child.kill("SIGKILL"); }; signal?.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.once("close", code => { clearTimeout(timer); signal?.removeEventListener("abort", abort); if (exceeded) reject(new ResourceError("PROCESS_OUTPUT_LIMIT", "Process output exceeded its limit.", 422)); else resolve({ exitCode: code ?? 1, stdout: stdout.toString(), stderr: stderr.toString(), timedOut }); });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

async function docker(args: string[], timeoutMs = 30_000, input?: string, maximumBytes?: number, signal?: AbortSignal): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  return run("/usr/bin/docker", args, timeoutMs, input, maximumBytes, signal);
}

async function removeSandboxContainer(name: string): Promise<boolean> {
  const removed = await docker(["rm", "-f", name], 30_000, undefined, 20_000).catch(() => null);
  if (removed?.exitCode === 0 && !removed.timedOut) return true;
  const listed = await docker(["ps", "-a", "--format", "{{.Names}}"], 10_000, undefined, 20_000).catch(() => null);
  return listed !== null && listed.exitCode === 0 && !listed.timedOut &&
    !listed.stdout.split(/\r?\n/u).includes(name);
}

function assertSandboxStarted(result: { exitCode: number; stderr: string }): void {
  if (result.exitCode !== 125) return;
  throw new ResourceError("PROCESS_START_FAILED",
    "Sandbox process could not start. The selected runtime image or its memory and PID limits may be unusable.", 422);
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

function assertProcessCwd(value: string | undefined): string {
  const cwd = value ?? ".";
  try { assertWorkspacePath(cwd === "." ? "workspace" : cwd); }
  catch { throw new ResourceError("PROCESS_CWD_INVALID", "Process cwd must be a workspace-relative path; omit it or use . for the workspace root.", 422); }
  return cwd;
}

async function egressArguments(workspaceId: string, runId: string, timeoutSeconds: number): Promise<{ networkName: string; args: string[] }> {
  if (!EGRESS_PROXY || EGRESS_SECRET.length < 32) throw new ResourceError("EGRESS_UNAVAILABLE", "Controlled public egress is not configured.", 503);
  let url: URL;
  try { url = new URL(EGRESS_PROXY); } catch { throw new ResourceError("EGRESS_UNAVAILABLE", "Controlled public egress is not configured.", 503); }
  if (url.protocol !== "http:" || url.username || url.password || !/^[a-z0-9][a-z0-9.-]{0,252}$/u.test(url.hostname)) {
    throw new ResourceError("EGRESS_UNAVAILABLE", "Controlled public egress is not configured.", 503);
  }
  const isolated = await ensureWorkspaceEgress(workspaceId, (args, timeoutMs) => docker(args, timeoutMs, undefined, 100_000));
  const payload = Buffer.from(JSON.stringify({ workspaceId, runId: runId.slice(0, 160), expiresAt: Date.now() + timeoutSeconds * 1000 + 300_000 })).toString("base64url");
  const signature = createHmac("sha256", EGRESS_SECRET).update(payload).digest("base64url");
  url.username = payload; url.password = signature;
  return { networkName: isolated.networkName,
    args: ["--add-host", `${url.hostname}:${isolated.proxyAddress}`, "--env", `HTTP_PROXY=${url.href}`, "--env", `HTTPS_PROXY=${url.href}`, "--env", `ALL_PROXY=${url.href}`,
      "--env", "NO_PROXY=localhost,127.0.0.1,::1"] };
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
  return result.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, "$1[REDACTED_CREDENTIALS]@");
}

async function commonArgs(workspaceId: string, spec: RuntimeSpec, name: string, runId = "system"): Promise<string[]> {
  const root = workspaceRoot(workspaceId); const egress = spec.network === "public" ? await egressArguments(workspaceId, runId, spec.limits.timeoutSeconds) : null;
  const declarations = await projectDeclarations(workspaceId, true);
  const digest = spec.image.kind === "builtin" ? spec.image.digest : spec.image.imageDigest!;
  const cacheKey = environmentCacheKey(digest, declarations, spec.environment);
  await ensureWorkspaceRuntimeDirectories(workspaceId, cacheKey);
  const environmentRoot = `/workspace/.harness/environments/${cacheKey}`;
  const environmentHostRoot = path.join(root, ".harness", "environments", cacheKey);
  return ["run", "--runtime", RUNTIME, "--name", name, "--label", "daoyin.harness.resource=1", "--label", `daoyin.harness.workspace=${workspaceId}`,
    "--network", egress?.networkName ?? "none", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
    "--memory", `${spec.limits.memoryMiB}m`, "--memory-swap", `${spec.limits.memoryMiB}m`, "--cpus", String(spec.limits.cpu), "--pids-limit", String(spec.limits.pids),
    "--ulimit", "nofile=2048:2048", "--log-driver", "local", "--log-opt", "max-size=4m", "--log-opt", "max-file=3",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m,mode=1777", "--mount", `type=bind,src=${root},dst=/workspace`,
    "--mount", `type=bind,src=${path.join(root, ".harness")},dst=/workspace/.harness,readonly`,
    ...["home", "cache", "python-user", "npm-global", "cargo", "go"].flatMap(name => ["--mount", `type=bind,src=${path.join(environmentHostRoot,name)},dst=${environmentRoot}/${name}`]),
    "--workdir", "/workspace",
    "--env", `HOME=${environmentRoot}/home`, "--env", `XDG_CACHE_HOME=${environmentRoot}/cache`,
    "--env", `PYTHONUSERBASE=${environmentRoot}/python-user`, "--env", `PIP_CACHE_DIR=${environmentRoot}/cache/pip`,
    "--env", `NPM_CONFIG_CACHE=${environmentRoot}/cache/npm`, "--env", `NPM_CONFIG_PREFIX=${environmentRoot}/npm-global`,
    "--env", `CARGO_HOME=${environmentRoot}/cargo`, "--env", `GOPATH=${environmentRoot}/go`, "--env", `GOMODCACHE=${environmentRoot}/go/pkg/mod`,
    "--env", `PATH=${environmentRoot}/python-user/bin:${environmentRoot}/npm-global/bin:${environmentRoot}/cargo/bin:/usr/local/go/bin:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    "--env", "CI=1", "--env", "NO_COLOR=1",
    ...(egress?.args ?? []),
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
      if (entry.kind === "file") {
        await writeFile(target, await content.read(entry.blobHash), { mode: entry.mode, flag: "wx" });
        await chmod(target, entry.mode);
      }
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

async function prepare(request: ExecutorProcessRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const workspaceId = request.workspaceId!; assertResourceId(workspaceId, "wsp"); const root = workspaceRoot(workspaceId);
  if (request.operation === "fingerprint") return { sourceVersion: await sourceVersion(workspaceId, await loadRuntime(workspaceId), signal) };
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
      const extracted = await foreground(workspaceId, spec, command.executable, command.args, ".", undefined, 120_000, undefined, request.runId, undefined, signal);
      if (extracted.exitCode !== 0) throw new ResourceError("WORKSPACE_UPLOAD_EXTRACT_FAILED", extracted.stderr.slice(-2000) || "Uploaded workspace package could not be extracted.", 422);
    } finally { await rm(archive, { force: true }); }
    await rm(path.join(root, ".harness"), { recursive: true, force: true });
    const entries = await scan(workspaceId); await saveRuntime(workspaceId, spec); return { entries };
  }
  if (source.kind !== "git") throw new ResourceError("WORKSPACE_SOURCE_PENDING", "This workspace source requires an uploaded artifact materialization step.", 501);
  const container = `hr-import-${workspaceId.slice(4)}`;
  const importPath = path.join(root, ".harness-import-repo");
  const args = [...await commonArgs(workspaceId, spec, container, request.runId), "--rm", image(spec), "git", "clone", "--no-checkout", "--", source.url, "/workspace/.harness-import-repo"];
  const clone = await docker(args, Math.min(spec.limits.timeoutSeconds * 1000, 600_000), undefined, spec.limits.maxOutputBytes);
  if (clone.exitCode !== 0) throw new ResourceError("WORKSPACE_GIT_CLONE_FAILED", `Git import failed: ${clone.stderr.slice(-2000)}`, 422);
  const checkout = await docker([...await commonArgs(workspaceId, spec, `${container}-checkout`, request.runId), "--rm", image(spec), "git", "-C", "/workspace/.harness-import-repo", "checkout", "--detach", source.revision], 120_000);
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

async function atomicFileWrite(target: string, data: Buffer, existing: boolean): Promise<void> {
  const info = existing ? await stat(target) : undefined;
  await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
  const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, data, { flag: "wx", mode: info ? info.mode & 0o777 : 0o644 });
    await chown(temporary, info?.uid ?? 1000, info?.gid ?? 1000);
    if (info) await chmod(temporary, info.mode & 0o777);
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
}

async function fileOperation(request: ExecutorProcessRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
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
    const info = await stat(target);
    if (!info.isFile() || info.size > (operation === "read_binary" ? maximum : 16 * 1024 * 1024)) throw new ResourceError("FILE_READ_LIMIT", "File exceeds the supported read size.", 413);
    const data = await readFile(target);
    if (operation === "read_binary") return { contentBase64: data.toString("base64"), size: data.length };
    const binary = data.includes(0) || !Buffer.from(data.toString("utf8")).equals(data);
    if (binary || data.length > maximum)
      return { path: request.path, digest: fileDigest(data), size: data.length, binary, contentAvailable: false,
        reason: binary ? "binary" : "text-budget-exceeded" };
    const lines = data.toString("utf8").match(/[^\n]*(?:\n|$)/gu)?.filter(line => line.length > 0) ?? [];
    const start = Math.max(1, request.startLine ?? 1); const end = Math.min(lines.length, request.endLine ?? lines.length);
    return { path: request.path, digest: fileDigest(data), startLine: start, endLine: end, totalLines: lines.length,
      endsWithNewline: data.at(-1) === 10, content: lines.slice(start - 1, end).join("") };
  }
  if (operation === "write") {
    const target = await safePath(workspaceId, request.path!, true); const data = request.contentBase64 === undefined ? Buffer.from(request.content ?? "") : Buffer.from(request.contentBase64, "base64");
    if (data.length > 16 * 1024 * 1024) throw new ResourceError("FILE_WRITE_LIMIT", "File exceeds the write limit.", 413);
    const before = await fileBaseline(target); assertFileVersion(before, request.expectedDigest);
    const mutation = fileMutation([fileChange(request.path!, before, data)]);
    if (!mutation.changed) return { mutation, path: request.path, size: data.length, digest: fileDigest(data) };
    await atomicFileWrite(target, data, before !== null);
    return { mutation, path: request.path, size: data.length, digest: fileDigest(data) };
  }
  if (operation === "patch") {
    if (request.patch !== undefined) {
      const plans = []; let baselineBytes = 0;
      for (const item of parseTextPatch(request.patch)) {
        const target = await safePath(workspaceId, item.path, true); const before = await fileBaseline(target);
        baselineBytes += before?.length ?? 0;
        if (baselineBytes > 32 * 1024 * 1024) throw new ResourceError("FILE_EDIT_LIMIT", "Patch baselines exceed 32 MiB; use a smaller edit.", 413);
        if (request.expectedDigests !== undefined) assertFileVersion(before,
          Object.hasOwn(request.expectedDigests, item.path) ? request.expectedDigests[item.path] : null);
        const after = applyTextPatch(item, before);
        plans.push({ target, before, after, change: fileChange(item.path, before, after) });
      }
      // Validate every file before changing any. The existing queue and pause
      // cover publication; each individual text write is atomic.
      const mutation = fileMutation(plans.map(plan => plan.change));
      try {
        for (const plan of plans) {
          if (!plan.change.changed) continue;
          if (plan.after === null) { await unlink(plan.target); continue; }
          await atomicFileWrite(plan.target, plan.after, plan.before !== null);
        }
      } catch {
        throw new ResourceError("PATCH_WRITE_FAILED", "Patch publication failed; some files may have changed. Inspect actual files before recovery; do not replay automatically.", 503);
      }
      return { mutation };
    }
    const target = await safePath(workspaceId, request.path!); const before = await fileBaseline(target);
    assertFileVersion(before, request.expectedDigest);
    if (before === null || before.includes(0)) throw new ResourceError("PATCH_CONTEXT_CONFLICT", "Exact replacement requires an existing text file.", 409);
    const text = before.toString("utf8"); const expected = request.expected ?? "";
    if (!Buffer.from(text).equals(before)) throw new ResourceError("PATCH_CONTEXT_CONFLICT", "Exact replacement requires valid UTF-8 text.", 409);
    if (!expected.length) throw new ResourceError("PATCH_CONTEXT_CONFLICT", "Expected text must not be empty.", 409);
    const first = text.indexOf(expected); if (first < 0 || text.indexOf(expected, first + expected.length) >= 0) throw new ResourceError("PATCH_CONTEXT_CONFLICT", "Expected text is missing or ambiguous.", 409);
    const after = Buffer.from(text.slice(0, first) + (request.replacement ?? "") + text.slice(first + expected.length));
    if (after.length > 16 * 1024 * 1024) throw new ResourceError("FILE_EDIT_LIMIT", "Patched file exceeds 16 MiB.", 413);
    const mutation = fileMutation([fileChange(request.path!, before, after)]);
    if (mutation.changed) await atomicFileWrite(target, after, true);
    return { mutation, path: request.path, digest: fileDigest(after) };
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
    const result = await foreground(workspaceId, spec, "rg", args, ".", undefined, 30_000, undefined, request.runId, undefined, signal);
    if (result.exitCode !== 0 && result.exitCode !== 1) throw new ResourceError("FILE_SEARCH_FAILED", result.stderr.slice(-2000), 422);
    if (request.searchMode === "glob") return { paths: result.stdout.split("\n").filter(Boolean).slice(0, 500) };
    return { matches: result.stdout.split("\n").filter(Boolean).slice(0, 500).map(line => JSON.parse(line) as unknown) };
  }
  throw new ResourceError("FILE_OPERATION_DENIED", "File operation is not allowed.", 403);
}

async function foreground(workspaceId: string, spec: RuntimeSpec, executable: string, args: string[], cwd = ".", stdin?: string, timeoutMs?: number, environment?: Record<string, string>, runId = "system", secretValues?: ResolvedSecret[], signal?: AbortSignal): Promise<Record<string, unknown> & { exitCode: number; stdout: string; stderr: string }> {
  assertProcessInput(executable, args);
  cwd = assertProcessCwd(cwd);
  const name = `hr-run-${workspaceId.slice(4, 16)}-${randomBytes(4).toString("hex")}`;
  const secrets = await secretArguments(name, spec.secretRefs, secretValues);
  try {
    const command = [...await commonArgs(workspaceId, spec, name, runId), "--rm", ...secrets, ...safeEnvironment(environment), "--workdir", `/workspace/${cwd === "." ? "" : cwd}`, "-i", image(spec), executable, ...args];
    const result = await docker(command, Math.min(timeoutMs ?? spec.limits.timeoutSeconds * 1000, spec.limits.timeoutSeconds * 1000), stdin, spec.limits.maxOutputBytes, signal);
    signal?.throwIfAborted();
    if (result.timedOut) throw new ResourceError("PROCESS_TIMEOUT", "Process exceeded its execution timeout and was terminated.", 408);
    assertSandboxStarted(result);
    return { ...result, stdout: await redactSecretOutput(name, result.stdout), stderr: await redactSecretOutput(name, result.stderr),
      sandbox: "gVisor", network: spec.network === "public" ? "controlled-public" : "none" };
  } finally {
    if (!(await removeSandboxContainer(name))) throw new ResourceError("PROCESS_CLEANUP_FAILED", "Process container could not be terminated.", 503);
    await cleanupSecrets(name);
  }
}

async function gitOperation(request: ExecutorProcessRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const workspaceId = request.workspaceId!; const spec = await loadRuntime(workspaceId); const operation = request.operation ?? "";
  const commands: Record<string, string[]> = {
    status: ["status", "--short", "--branch"], diff: ["diff", "--no-ext-diff", "--no-textconv", ...(request.revision ? [request.revision] : [])],
    log: ["log", "--oneline", "-50"], checkout: ["checkout", "--detach", request.revision ?? ""], branch: ["switch", "-c", request.revision ?? ""],
    commit: ["-c", "user.name=Daoyin Harness", "-c", "user.email=harness@invalid", "commit", "-m", request.message ?? "Harness update"],
    export_patch: ["diff", "--binary", "HEAD"],
  };
  const args = commands[operation]; if (!args) throw new ResourceError("GIT_OPERATION_DENIED", "Git operation is not allowed.", 403);
  const sourceVersionBefore = await sourceVersion(workspaceId, spec, signal);
  if (operation === "commit") {
    const staged = await foreground(workspaceId, spec, "git", ["add", "-A"], ".", undefined, 120_000, undefined, request.runId, undefined, signal);
    if (staged.exitCode !== 0) throw new ResourceError("GIT_OPERATION_FAILED", staged.stderr.slice(-2000) || "Git changes could not be staged.", 422);
  }
  const result = await foreground(workspaceId, spec, "git", args, ".", undefined, 120_000, undefined, request.runId, undefined, signal);
  if (result.exitCode !== 0) throw new ResourceError("GIT_OPERATION_FAILED", result.stderr.slice(-2000) || "Git operation failed.", 422);
  const sourceVersionAfter = await sourceVersion(workspaceId, spec, signal);
  return { ...(operation === "export_patch" ? { content: result.stdout } : result), sourceVersionBefore, sourceVersionAfter };
}

async function projectDeclarations(workspaceId: string, dependenciesOnly = false): Promise<Array<{ path: string; digest: string; size: number; content: string; truncated: boolean }>> {
  const result: Array<{ path: string; digest: string; size: number; content: string; truncated: boolean }> = [];
  let remaining = 64 * 1024;
  for (const name of PROJECT_DECLARATIONS) {
    if (dependenciesOnly && !isDependencyDeclaration(name)) continue;
    let target: string;
    try { target = await safePath(workspaceId, name); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const info = await lstat(target);
    if (!info.isFile() || info.size > 16 * 1024 * 1024) continue;
    const bytes = await readFile(target); const maximum = Math.min(remaining, 8192);
    const preview = bytes.subarray(0, maximum); remaining -= preview.byteLength;
    result.push({ path: name, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      size: bytes.byteLength, content: preview.toString("utf8"), truncated: preview.byteLength < bytes.byteLength });
  }
  return result;
}
async function environmentInspect(request: ExecutorProcessRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const workspaceId = request.workspaceId!; const spec = await loadRuntime(workspaceId);
  const declarations = await projectDeclarations(workspaceId);
  const catalogCapabilities = spec.image.kind === "builtin" ? IMAGE_CATALOG[spec.image.id]?.capabilities : undefined;
  const capabilities = Array.isArray(catalogCapabilities) ? catalogCapabilities.filter(value => typeof value === "string") : [];
  const executables = environmentVersionProbes(declarations, capabilities);
  const gitArgs = [["rev-parse", "--is-shallow-repository"], ["describe", "--tags", "--always"], ["status", "--short"]];
  const commands = [...executables.map(executable => ({ executable, args: [executable === "go" ? "version" : "--version"] })),
    ...gitArgs.map(args => ({ executable: "git", args: ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args] }))];
  const probeSpec = { ...spec, network: "none" as const, secretRefs: [] };
  const probeEnvironment = { PATH: "/usr/local/go/bin:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", NODE_OPTIONS: "", PYTHONPATH: "", PYTHONSTARTUP: "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0" };
  type ProbeResult = { exitCode?: number; output?: string; truncated?: boolean; code?: string };
  let results: ProbeResult[] | undefined;
  // The driver is independently authored, fixed runtime code. Only our fixed
  // version and Git metadata argument arrays are passed as data; no project
  // imports, shell, hooks, or configuration evaluation are involved.
  const driver = executables.includes("node") ? { executable: "node", args: ["-e", `
const {spawnSync}=require('node:child_process');
const commands=JSON.parse(process.argv[1]);
console.log(JSON.stringify(commands.map(({executable,args})=>{
 const result=spawnSync(executable,args,{shell:false,timeout:3000,maxBuffer:4096,encoding:'utf8'});
 const output=String(result.stdout||'')+String(result.stderr||'');
 return {...(Number.isInteger(result.status)?{exitCode:result.status}:{}),output:output.slice(0,2048),truncated:output.length>2048,...(result.error?{code:result.error.code||'PROBE_FAILED'}:{})};
})));`] }
    : executables.includes("python3") ? { executable: "python3", args: ["-I", "-S", "-c", `
import json, subprocess, sys, tempfile
results=[]
for command in json.loads(sys.argv[1]):
    with tempfile.TemporaryFile() as output:
        try:
            result=subprocess.run([command['executable'],*command['args']],stdout=output,stderr=output,timeout=3,check=False)
            item={'exitCode':result.returncode}
        except subprocess.TimeoutExpired:
            item={'code':'PROBE_TIMEOUT'}
        except OSError as error:
            item={'code':'PROBE_FAILED','errno':error.errno}
        output.seek(0)
        data=output.read(2049)
        item.update(output=data[:2048].decode('utf-8',errors='replace'),truncated=len(data)>2048)
        results.append(item)
print(json.dumps(results))`] } : undefined;
  if (driver) {
    try {
      const probe = await foreground(workspaceId, probeSpec, driver.executable, [...driver.args, JSON.stringify(commands)],
        ".", undefined, commands.length * 3000 + 3000, probeEnvironment, request.runId, undefined, signal);
      if (probe.exitCode === 0) {
        const value: unknown = JSON.parse(probe.stdout);
        if (Array.isArray(value) && value.length === commands.length && value.every(item => item !== null && typeof item === "object")) results = value as ProbeResult[];
      }
    } catch (error) { signal?.throwIfAborted(); if (error instanceof ResourceError && ["PROCESS_CLEANUP_FAILED", "WORKSPACE_RUNTIME_PATH_INVALID"].includes(error.code)) throw error; }
  }
  if (!results) {
    results = [];
    for (const command of commands) {
      signal?.throwIfAborted();
      try {
        const probe = await foreground(workspaceId, probeSpec, command.executable, command.args,
          ".", undefined, 3000, probeEnvironment, request.runId, undefined, signal);
        const output = String(probe.stdout + probe.stderr);
        results.push({ exitCode: probe.exitCode, output: output.slice(0, 2048), truncated: output.length > 2048 });
      } catch (error) { signal?.throwIfAborted(); results.push({ code: error instanceof ResourceError ? error.code : "PROBE_FAILED" }); }
    }
  }
  const observations = results;
  const interpreters = executables.map((executable, index) => ({ executable, available: observations[index]?.exitCode === 0, ...observations[index] }));
  const imageDigest = spec.image.kind === "builtin" ? spec.image.digest : spec.image.imageDigest!;
  const sourceMetadata = gitArgs.map((args, index) => ({ args, ...observations[executables.length + index] }));
  return { runtime: spec, interpreters, declarations, sourceMetadata, runtimeAssessment: environmentRuntimeAssessment(declarations, interpreters),
    cacheKey: environmentCacheKey(imageDigest, declarations, spec.environment),
    uncertainty: "Declarations are bounded untrusted data, not executed configuration or proof of compatibility. Git metadata may be absent or shallow; derived package versions must be checked, never invented. Verification commands and optional test dependencies remain model-selected from project declarations." };
}

async function processOperation(request: ExecutorProcessRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const workspaceId = request.workspaceId!; const operation = request.operation ?? ""; const spec = await loadRuntime(workspaceId);
  if (operation === "run") {
    const sourceVersionBefore = await sourceVersion(workspaceId, spec, signal);
    const result = await foreground(workspaceId, spec, request.executable ?? "", request.args ?? [], request.cwd, request.stdin, request.timeoutMs, request.environment, request.runId, request.secretValues, signal);
    return { ...result, sourceVersionBefore, sourceVersionAfter: await sourceVersion(workspaceId, spec, signal) };
  }
  if (operation === "start") {
    if (request.mode !== "background" && request.mode !== "pty") throw new ResourceError("PROCESS_MODE_INVALID", "Background or PTY mode is required.");
    assertProcessInput(request.executable ?? "", request.args ?? []);
    if (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 100 || request.timeoutMs > 3_600_000))
      throw new ResourceError("PROCESS_TIMEOUT_INVALID", "Process lifetime must be between 100 and 3600000 milliseconds.");
    const cwd = assertProcessCwd(request.cwd);
    const processId = request.processId ?? `prc_${randomBytes(12).toString("hex")}`; assertResourceId(processId, "prc");
    const name = `hr-${processId}`;
    if (await receipts.read(workspaceId, processId)) throw new ResourceError("PROCESS_ALREADY_STARTED", "This process already has a durable receipt; startup was not replayed.", 409);
    const existing = await docker(["inspect", "--format", "{{.Id}}", name], 10_000, undefined, 2000);
    if (existing.exitCode === 0) throw new ResourceError("PROCESS_ALREADY_STARTED", "This process identity already exists; startup was not replayed.", 409);
    const sourceVersionBefore = await sourceVersion(workspaceId, spec, signal);
    const sourceDirectory = await runtimeDirectory(workspaceId, ["process-source"]);
    try { await writeFile(path.join(sourceDirectory, `${processId}.json`), JSON.stringify(sourceVersionBefore), { mode: 0o600, flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ResourceError("PROCESS_ALREADY_STARTED", "A launch record already exists; uncertain startup was not replayed.", 409); throw error; }
    const startedAt = new Date().toISOString();
    const timeoutAt = Date.now() + Math.min(request.timeoutMs ?? spec.limits.timeoutSeconds * 1000, spec.limits.timeoutSeconds * 1000);
    const secrets = await secretArguments(name, spec.secretRefs, request.secretValues);
    const containerArgs = await commonArgs(workspaceId, spec, name, request.runId);
    signal?.throwIfAborted();
    const hasStdin = typeof request.stdin === "string";
    if (hasStdin) containerArgs[0] = "create";
    const args = [...containerArgs, ...(hasStdin ? ["-i"] : ["-d"]), "--label", `daoyin.harness.process=${processId}`,
      "--label", `daoyin.harness.mode=${request.mode}`, "--label", `daoyin.harness.started_at=${startedAt}`,
      "--label", `daoyin.harness.timeout_at=${String(timeoutAt)}`,
      ...(request.mode === "pty" ? ["-i", "-t"] : []), ...secrets, ...safeEnvironment(request.environment),
      "--workdir", `/workspace/${cwd !== "." ? cwd : ""}`, image(spec), request.executable ?? "", ...(request.args ?? [])];
    const result = await docker(args, 30_000); if (result.exitCode !== 0) { await cleanupSecrets(name); throw new ResourceError("PROCESS_START_FAILED", result.stderr.slice(-2000), 422); }
    processes.set(processId, { workspaceId, name, mode: request.mode, startedAt, timeoutAt });
    if (hasStdin) {
      // Docker create + one attached start feeds finite input without a shell
      // wrapper or a second command launch. Daemon logs remain authoritative.
      const attached = spawn("/usr/bin/docker", ["start", "--attach", "--interactive", name], {
        shell: false, stdio: ["pipe", "ignore", "ignore"], env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C.UTF-8" },
      });
      attached.stdin.on("error", () => undefined);
      attached.stdin.end(request.stdin);
      attached.on("error", () => { console.error(`Tracked process attach failed: ${processId}`); });
      const timer = setTimeout(() => attached.kill("SIGKILL"), Math.max(1, timeoutAt - Date.now()) + 5000);
      timer.unref(); attached.once("close", () => clearTimeout(timer));
      // Observe the same container; never retry its start if acknowledgement is
      // delayed. A created state is retained for subsequent read/stop evidence.
      const launchDeadline = Date.now() + 3000;
      do {
        const state = await docker(["inspect", "--format", "{{.State.Status}}", name], 2000, undefined, 2000);
        if (state.exitCode === 0 && state.stdout.trim() !== "created") break;
        await delay(100);
      } while (Date.now() < launchDeadline);
    }
    if (signal?.aborted) return processOperation({ ...request, operation: "stop", processId }, undefined);
    return { processId, status: "running", mode: request.mode, timeoutAt: new Date(timeoutAt).toISOString(), sourceVersionBefore };
  }
  if (operation === "read" || operation === "stop") {
    if (request.cursor !== undefined && (!Number.isSafeInteger(request.cursor) || request.cursor < 0))
      throw new ResourceError("PROCESS_CURSOR_INVALID", "Process cursor must be a nonnegative integer.");
    const processId = request.processId ?? "";
    const saved = await receipts.read(workspaceId, processId);
    if (saved) {
      const pending = processes.get(processId);
      if (pending?.workspaceId === workspaceId && await removeSandboxContainer(pending.name)) {
        processes.delete(processId); await cleanupSecrets(pending.name);
      }
      return { ...receiptPage(saved, request.cursor), cleanupPending: processes.has(processId) };
    }
    const session = await processSession(workspaceId, processId);
    let inspected = await docker(["inspect", "--format", "{{json .State}}", session.name], 10_000);
    if (inspected.exitCode !== 0 || inspected.timedOut) throw new ResourceError("PROCESS_OBSERVATION_FAILED", "Original process state could not be observed; it was not restarted.", 503);
    const initial = JSON.parse(inspected.stdout) as { Status?: string };
    const active = !["exited", "dead"].includes(initial.Status ?? "");
    const timedOut = active && session.timeoutAt > 0 && Date.now() >= session.timeoutAt;
    const cancelled = active && operation === "stop";
    if (timedOut || cancelled) {
      const stopped = await docker(["stop", "--time", "2", session.name], 15_000, undefined, 20_000);
      if (stopped.exitCode !== 0 || stopped.timedOut) throw new ResourceError("PROCESS_STOP_FAILED", "Process could not be stopped; evidence and container were retained.", 503);
    }
    if (timedOut || cancelled) inspected = await docker(["inspect", "--format", "{{json .State}}", session.name], 10_000);
    if (inspected.exitCode !== 0 || inspected.timedOut) throw new ResourceError("PROCESS_OBSERVATION_FAILED", "Stopped process state could not be retained.", 503);
    const state = JSON.parse(inspected.stdout) as { Status?: string; ExitCode?: number; FinishedAt?: string };
    if (!state.Status || !Number.isSafeInteger(state.ExitCode)) throw new ResourceError("PROCESS_OBSERVATION_FAILED", "Process state is incomplete.", 503);
    const logs = await docker(["logs", session.name], 20_000, undefined, 16_000_000);
    if (logs.exitCode !== 0 || logs.timedOut) throw new ResourceError("PROCESS_OBSERVATION_FAILED", "Original process output could not be retained; cleanup was deferred.", 503);
    const redacted = Buffer.from(await redactSecretOutput(session.name, logs.stdout + logs.stderr));
    const limited = redacted.subarray(0, spec.limits.maxOutputBytes);
    const terminal = ["exited", "dead"].includes(state.Status);
    if (terminal) {
      const sourceVersionBefore = await savedSourceVersion(workspaceId, processId);
      const sourceVersionAfter = await sourceVersion(workspaceId, spec, signal);
      const receipt = await receipts.save({ processId, workspaceId,
        state: timedOut ? "timed_out" : cancelled ? "cancelled" : state.Status,
        exitCode: typeof state.ExitCode === "number" ? state.ExitCode : null,
        output: limited.toString("utf8"), cursor: limited.byteLength, truncated: limited.byteLength < redacted.byteLength,
        startedAt: session.startedAt, finishedAt: state.FinishedAt ?? null, timeoutAt: new Date(session.timeoutAt).toISOString(), sourceVersionBefore, sourceVersionAfter });
      // Canonical receipt exists before either the Docker logs or mounted secret
      // values disappear. A lost control response is observed, never replayed.
      const cleaned = await removeSandboxContainer(session.name);
      if (cleaned) { processes.delete(processId); await cleanupSecrets(session.name); }
      return { ...receiptPage(receipt, request.cursor), cleanupPending: !cleaned };
    }
    const start = Math.min(Math.max(0, request.cursor ?? 0), limited.byteLength);
    return { processId, output: limited.subarray(start).toString("utf8"), cursor: limited.byteLength,
      truncated: limited.byteLength < redacted.byteLength, state: state.Status, exitCode: null,
      startedAt: session.startedAt, timeoutAt: new Date(session.timeoutAt).toISOString(), finishedAt: null };
  }
  if (operation === "write") {
    const processId = request.processId ?? ""; const session = await processSession(workspaceId, processId); if (session.mode !== "pty") throw new ResourceError("PROCESS_PTY_REQUIRED", "A running PTY process is required.", 409);
    const result = await docker(["attach", "--sig-proxy=false", "--detach-keys", "ctrl-]", session.name], 10_000, `${request.stdin ?? ""}\x1d`, 100_000);
    return { processId, accepted: !result.timedOut && result.exitCode === 0 };
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
    "--security-opt", "no-new-privileges", "--pids-limit", "48", "--memory", "64m", probeImage.image,
    SANDBOX_PROBE.executable, ...SANDBOX_PROBE.args], 30_000, undefined, 20_000);
  if (probe.exitCode !== 0) throw new ResourceError("SANDBOX_PROBE_FAILED", "The gVisor startup probe failed.", 503);
  const egress = await egressArguments("wsp_000000000000000000000000", "readiness", 30);
  const proxy = new URL(EGRESS_PROXY);
  const egressProbe = await docker(["run", "--rm", "--runtime", RUNTIME, "--network", egress.networkName, "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--pids-limit", "48", "--memory", "64m",
    ...egress.args, probeImage.image, "node", "-e",
    `const net=require('node:net');const s=net.createConnection({host:${JSON.stringify(proxy.hostname)},port:${Number(proxy.port || 80)}});s.setTimeout(5000);s.once('connect',()=>{s.end();process.exit(0)});s.once('timeout',()=>process.exit(2));s.once('error',()=>process.exit(3))`],
    30_000, undefined, 20_000);
  if (egressProbe.exitCode !== 0) throw new ResourceError("EGRESS_PROBE_FAILED", "The gVisor egress proxy probe failed.", 503);
  return { ready: true, runtime: RUNTIME, publicNetwork: "controlled", images: Object.keys(IMAGE_CATALOG) };
}

async function dispatch(request: ExecutorProcessRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  if (request.action === "readiness") return readiness();
  if (request.action === "reconcile") { await reconcileProcesses(); await enforceProcessTimeouts(); return { processes: [...processes.keys()] }; }
  if (!request.workspaceId) throw new ResourceError("WORKSPACE_REQUIRED", "Workspace is required.");
  if (request.action === "workspace_prepare") return withPausedWorkspaceProcesses(request.workspaceId, () => prepare(request, signal));
  if (request.action === "workspace_remove") {
    const root = workspaceRoot(request.workspaceId); const imageFile = path.join(DISK_ROOT, `${request.workspaceId}.ext4`);
    await run("/usr/bin/umount", [root], 30_000, undefined, 20_000).catch(() => undefined);
    await rm(root, { recursive: true, force: true }); await rm(imageFile, { force: true }); return { removed: true };
  }
  if (request.action === "environment") return withPausedWorkspaceProcesses(request.workspaceId, () => environmentInspect(request, signal));
  if (request.action === "image_import") return importImage(request);
  if (request.action === "file") return withPausedWorkspaceProcesses(request.workspaceId, () => fileOperation(request, signal));
  if (request.action === "git") return withPausedWorkspaceProcesses(request.workspaceId, () => gitOperation(request, signal));
  if (request.action === "process") return processOperation(request, signal);
  throw new ResourceError("EXECUTOR_ACTION_DENIED", "Executor operation is not allowed.", 403);
}

async function readProcessWithWait(request: ExecutorProcessRequest, waitMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const started = performance.now();
  const deadline = started + waitMs;
  while (true) {
    // Each observation joins the normal workspace queue; sleeping between
    // observations must not hold it and block edits or process_stop.
    const result = await dispatchSerialized({ ...request, waitMs: 0 }, signal);
    const remaining = deadline - performance.now();
    if ((typeof result.output === "string" && result.output.length > 0) ||
        !["running", "created", "restarting", "paused"].includes(String(result.state)) || remaining <= 0) {
      return { ...result, observation: { waitMs, elapsedMs: Math.round(performance.now() - started) } };
    }
    await delay(Math.min(500, remaining), undefined, { signal });
  }
}

function dispatchSerialized(request: ExecutorProcessRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (request.action === "process" && request.operation === "read") {
    const waitMs = request.waitMs ?? 0;
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 30_000)
      throw new ResourceError("PROCESS_WAIT_INVALID", "Process observation wait must be an integer between 0 and 30000 milliseconds.");
    if (waitMs > 0) return readProcessWithWait(request, waitMs, signal);
  }
  if (request.action === "readiness" || !request.workspaceId) return dispatch(request, signal);
  const previous = workspaceQueues.get(request.workspaceId) ?? Promise.resolve();
  const pending = previous.then(() => dispatch(request, signal));
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
  const controller = new AbortController(); request.once("aborted", () => controller.abort());
  response.once("close", () => { if (!response.writableEnded) controller.abort(); });
  let body = ""; request.on("data", chunk => { body += chunk.toString(); if (Buffer.byteLength(body) > 2_000_000) request.destroy(); });
  request.on("end", () => { void (async () => {
      try { const value = await dispatchSerialized(JSON.parse(body) as ExecutorProcessRequest, controller.signal); response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(value)); }
    catch (error) { const failure = error instanceof ResourceError ? error : new ResourceError("EXECUTOR_FAILED", "Sandbox executor failed.", 503); response.writeHead(failure.status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { code: failure.code, message: failure.message } })); }
  })(); });
});
server.listen(SOCKET, () => {
  const gid = Number(process.env.HARNESS_RESOURCE_GID); if (Number.isSafeInteger(gid) && gid > 0) void chown(SOCKET, 0, gid).then(() => chmod(SOCKET, 0o660));
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { clearInterval(timeoutSweep); server.close(); });
