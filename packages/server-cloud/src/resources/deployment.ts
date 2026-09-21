import { createHash, createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { chmod, chown, copyFile, mkdir, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import {
  assertResourceId, assertSha256Digest, assertWorkspacePath, type DeploymentSpec, type RuntimeSpec, type WorkspaceEntry,
} from "@daoyin/harness-contracts";
import { type DeploymentWorkerRequest, type ResolvedResourceBinding, type ResolvedSecret } from "./contracts.js";
import { ResourceError } from "./repository.js";
import { assertRuntimeSpec } from "./runtime-policy.js";
import { ensureWorkspaceEgress, isolateExistingContainer } from "./workspace-network.js";

const ROOT = process.env.HARNESS_DEPLOYMENT_ROOT ?? "/var/lib/daoyin-resources/deployments";
const CONTENT = process.env.HARNESS_CONTENT_STORE_ROOT ?? "/var/lib/daoyin-resources/content";
const SECRET_ROOT = process.env.HARNESS_SECRET_MATERIAL_ROOT ?? "/run/daoyin-resource-secrets";
const SOCKET = "/run/daoyin-resource-deployer/control.sock";
const ROUTER_HOST = process.env.HARNESS_DEPLOYMENT_ROUTER_HOST ?? "127.0.0.1";
const ROUTER_PORT = Number(process.env.HARNESS_DEPLOYMENT_ROUTER_PORT ?? 4712);
const RUNTIME = process.env.HARNESS_GVISOR_RUNTIME ?? "runsc";
const EGRESS_NETWORK = process.env.HARNESS_EGRESS_NETWORK ?? "harness-public-egress";
const EGRESS_PROXY = process.env.HARNESS_EGRESS_PROXY ?? "http://daoyin-resource-egress:3128";
const EGRESS_SECRET = process.env.HARNESS_EGRESS_HMAC_SECRET ?? "";
const ENDPOINT_SUFFIX = process.env.HARNESS_DEPLOYMENT_DOMAIN_SUFFIX ?? ".demo.daoyintech.com";
const MAX_ONLINE_DEPLOYMENTS = Number(process.env.HARNESS_MAX_ONLINE_DEPLOYMENTS ?? 2);
const BINDING_ROOTS = (process.env.HARNESS_BINDING_ROOTS ?? "/run/daoyin-projects/brokers").split(":").filter(Boolean).map(item => path.resolve(item));
const IMAGE_CATALOG = JSON.parse(process.env.HARNESS_RUNTIME_IMAGES ?? "{}") as Record<string, { image: string; digest: string }>;
const STATE_PATH = path.join(ROOT, "routes.json");

interface RouteTarget { deploymentId: string; workspaceId?: string; hostname: string; port?: number; socketPath?: string; containerName: string }
interface PersistedState { routes: Record<string, string>; deployments: Record<string, RouteTarget> }

let state: PersistedState = { routes: {}, deployments: {} };
let mutationQueue: Promise<void> = Promise.resolve();

function run(executable: string, args: string[], timeoutMs: number, maximumBytes = 200_000): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" } });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0); let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0); let exceeded = false;
    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
      if (current.byteLength + chunk.byteLength > maximumBytes) { exceeded = true; child.kill("SIGKILL"); return current; }
      return Buffer.concat([current, chunk]);
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once("error", reject);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("close", (code) => { clearTimeout(timer); if (exceeded) reject(new ResourceError("DEPLOYMENT_OUTPUT_LIMIT", "Deployment command output exceeded its limit.", 413));
      else resolve({ exitCode: code ?? -1, stdout: stdout.toString(), stderr: stderr.toString() }); });
  });
}

const docker = (args: string[], timeoutMs = 30_000): Promise<{ exitCode: number; stdout: string; stderr: string }> => run("/usr/bin/docker", args, timeoutMs);

function image(spec: RuntimeSpec): string {
  if (spec.image.kind === "dockerfile") {
    assertSha256Digest(spec.image.imageDigest);
    return spec.image.imageDigest;
  }
  const selected = IMAGE_CATALOG[spec.image.id];
  if (!selected || selected.digest !== spec.image.digest || !selected.image.endsWith(`@${selected.digest}`)) {
    throw new ResourceError("DEPLOYMENT_IMAGE_DENIED", "Deployment runtime image is not in the signed image catalog.", 403);
  }
  return selected.image;
}

function deploymentSpec(value: unknown): DeploymentSpec {
  if (!value || typeof value !== "object") throw new ResourceError("DEPLOYMENT_SPEC_INVALID", "Artifact deployment metadata is required.", 422);
  const spec = value as Partial<DeploymentSpec>;
  if (spec.version !== 1 || spec.kind !== "web-service" || !spec.command || !spec.health || !spec.environment ||
      typeof spec.command.executable !== "string" || !spec.command.executable || spec.command.executable.includes("\0") ||
      !Array.isArray(spec.command.args) || spec.command.args.length > 128 || spec.command.args.some((item) => typeof item !== "string" || item.includes("\0") || item.length > 16_000) ||
      typeof spec.command.cwd !== "string" || !spec.transport || !["tcp", "unix"].includes(spec.transport.kind) ||
      typeof spec.health.path !== "string" || !/^\/[\x21-\x7e]{0,255}$/u.test(spec.health.path) ||
      !Number.isSafeInteger(spec.health.timeoutSeconds) || spec.health.timeoutSeconds! < 1 || spec.health.timeoutSeconds! > 120 ||
      Array.isArray(spec.environment) || Object.entries(spec.environment).some(([key, item]) => !/^[A-Z_][A-Z0-9_]{0,79}$/u.test(key) ||
        /(?:TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|AUTH|API_KEY|ACCESS_KEY)/u.test(key) || typeof item !== "string" || item.includes("\0") || item.length > 16_000)) {
    throw new ResourceError("DEPLOYMENT_SPEC_INVALID", "Artifact deployment metadata is invalid.", 422);
  }
  assertWorkspacePath(spec.command.cwd === "." ? "workspace" : spec.command.cwd);
  if ((spec.transport.kind === "tcp" && (!Number.isSafeInteger(spec.transport.port) || spec.transport.port < 1024 || spec.transport.port > 65_535)) ||
      (spec.transport.kind === "unix" && spec.transport.path !== "/run/app/app.sock")) throw new ResourceError("DEPLOYMENT_SPEC_INVALID", "Deployment transport is invalid.", 422);
  if (!Array.isArray(spec.resourceIds) || spec.resourceIds.length > 16 || new Set(spec.resourceIds).size !== spec.resourceIds.length) throw new ResourceError("DEPLOYMENT_SPEC_INVALID", "Deployment resource bindings are invalid.", 422);
  for (const resourceId of spec.resourceIds) assertResourceId(resourceId);
  return structuredClone(spec as DeploymentSpec);
}

async function bindingArguments(resourceIds: readonly string[], bindings: readonly ResolvedResourceBinding[] | undefined): Promise<string[]> {
  if (!resourceIds.length) return [];
  if (!bindings || bindings.length !== resourceIds.length) throw new ResourceError("RESOURCE_BINDING_UNAVAILABLE", "Deployment resource bindings were not resolved.", 503);
  const expected = new Set(resourceIds); const seen = new Set<string>(); const targets = new Set<string>(); const args: string[] = [];
  for (const binding of bindings) {
    if (!expected.has(binding.resourceId) || seen.has(binding.resourceId) || targets.has(binding.targetPath) ||
        !(/^(?:\/run\/bindings\/[a-z0-9][a-z0-9._-]{0,79}|\/run\/broker)$/u.test(binding.targetPath))) {
      throw new ResourceError("RESOURCE_BINDING_INVALID", "Deployment resource binding is invalid.", 422);
    }
    const host = await realpath(binding.hostPath);
    if (!BINDING_ROOTS.some(root => host === root || host.startsWith(`${root}${path.sep}`))) throw new ResourceError("RESOURCE_BINDING_ESCAPE", "Deployment resource binding is outside an approved root.", 403);
    seen.add(binding.resourceId); targets.add(binding.targetPath); args.push("--mount", `type=bind,src=${host},dst=${binding.targetPath}${binding.readOnly ? ",readonly" : ""}`);
  }
  if (seen.size !== expected.size) throw new ResourceError("RESOURCE_BINDING_INVALID", "Deployment resource bindings are incomplete.", 422);
  return args;
}

function hostname(endpoint: string): string {
  let parsed: URL; try { parsed = new URL(endpoint); } catch { throw new ResourceError("DEPLOYMENT_ENDPOINT_INVALID", "Deployment endpoint must be a valid HTTPS origin.", 422); }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || parsed.pathname !== "/" || parsed.search || parsed.hash ||
      !host.endsWith(ENDPOINT_SUFFIX) || host === ENDPOINT_SUFFIX.slice(1) || !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(host)) {
    throw new ResourceError("DEPLOYMENT_ENDPOINT_INVALID", "Deployment endpoint is outside the managed HTTPS domain.", 422);
  }
  return host;
}

function blobPath(digest: string): string {
  assertSha256Digest(digest); const hash = digest.slice(7);
  return path.join(CONTENT, hash.slice(0, 2), hash.slice(2, 4), hash);
}

async function verifyDigest(file: string, expected: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const hash = createHash("sha256"); const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk)); stream.once("error", reject);
    stream.once("end", () => hash.digest("hex") === expected.slice(7) ? resolve() : reject(new ResourceError("DEPLOYMENT_BLOB_MISMATCH", "Snapshot content digest verification failed.", 409)));
  });
}

function safeSymlink(entryPath: string, target: string): void {
  if (!target || target.includes("\0") || path.posix.isAbsolute(target)) throw new ResourceError("DEPLOYMENT_SYMLINK_INVALID", "Snapshot symlink target is invalid.", 422);
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entryPath), target));
  if (resolved === ".." || resolved.startsWith("../")) throw new ResourceError("DEPLOYMENT_SYMLINK_ESCAPE", "Snapshot symlink escapes the deployment root.", 403);
}

async function materialize(deploymentId: string, entries: readonly WorkspaceEntry[]): Promise<string> {
  assertResourceId(deploymentId, "dep");
  if (entries.length > 100_000) throw new ResourceError("DEPLOYMENT_MANIFEST_LIMIT", "Snapshot contains too many entries.", 413);
  const destination = path.join(ROOT, deploymentId, "app"); const staging = `${destination}.next`;
  await rm(staging, { recursive: true, force: true }); await mkdir(staging, { recursive: true, mode: 0o755 }); await chmod(staging, 0o755);
  try {
    for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
      assertWorkspacePath(entry.path); const target = path.resolve(staging, ...entry.path.split("/"));
      if (!target.startsWith(`${path.resolve(staging)}${path.sep}`)) throw new ResourceError("DEPLOYMENT_PATH_ESCAPE", "Snapshot entry escapes the deployment root.", 403);
      let directory = staging;
      for (const segment of entry.path.split("/").slice(0, -1)) {
        directory = path.join(directory, segment); await mkdir(directory, { recursive: true, mode: 0o755 }); await chmod(directory, 0o755);
      }
      if (entry.kind === "symlink") { safeSymlink(entry.path, entry.target); await symlink(entry.target, target); continue; }
      const source = blobPath(entry.blobHash); await verifyDigest(source, entry.blobHash); await copyFile(source, target);
      await chmod(target, entry.mode & 0o555); await chown(target, 1000, 1000);
    }
    await rm(destination, { recursive: true, force: true }); await rename(staging, destination);
    return destination;
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}

function proxyEnvironment(workspaceId: string, deploymentId: string, address: string): string[] {
  if (EGRESS_SECRET.length < 32) throw new ResourceError("EGRESS_UNAVAILABLE", "Controlled deployment egress is not configured.", 503);
  const payload = Buffer.from(JSON.stringify({ workspaceId, runId: `deployment:${deploymentId}`, expiresAt: Date.now() + 24 * 60 * 60 * 1000 })).toString("base64url");
  const signature = createHmac("sha256", EGRESS_SECRET).update(payload).digest("base64url");
  const proxy = new URL(EGRESS_PROXY); proxy.hostname = address; proxy.username = payload; proxy.password = signature;
  return ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"].flatMap((name) => ["--env", `${name}=${proxy.href}`])
    .concat(["--env", "NO_PROXY=127.0.0.1,localhost,::1"]);
}

async function secretArguments(deploymentId: string, expectedRefs: readonly string[], values: readonly ResolvedSecret[] | undefined): Promise<string[]> {
  if (!expectedRefs.length) return [];
  if (!values || values.length !== expectedRefs.length) throw new ResourceError("SECRET_RESOLUTION_REQUIRED", "Deployment secrets were not resolved by the trusted service.", 503);
  const directory = path.join(SECRET_ROOT, deploymentId); const expected = new Set(expectedRefs); const seen = new Set<string>();
  await rm(directory, { recursive: true, force: true }); await mkdir(directory, { recursive: true, mode: 0o700 });
  const mapping: Record<string, string> = {};
  try {
    for (const item of values) {
      if (!expected.has(item.ref) || seen.has(item.ref) || typeof item.value !== "string" || item.value.length > 262_144) throw new ResourceError("SECRET_RESPONSE_INVALID", "Resolved deployment secrets are invalid.", 503);
      seen.add(item.ref); const file = createHash("sha256").update(item.ref).digest("hex"); const hostPath = path.join(directory, file); const containerPath = `/run/secrets/${file}`;
      await writeFile(hostPath, item.value, { flag: "wx", mode: 0o400 }); await chown(hostPath, 1000, 1000);
      mapping[item.ref] = containerPath;
    }
    if (seen.size !== expected.size) throw new ResourceError("SECRET_RESPONSE_INVALID", "Resolved deployment secrets are incomplete.", 503);
    await chown(directory, 1000, 1000); await chmod(directory, 0o500);
    return ["--mount", `type=bind,src=${directory},dst=/run/secrets,readonly`, "--env", `HARNESS_SECRET_FILES=${JSON.stringify(mapping)}`];
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

async function persist(): Promise<void> {
  const temporary = `${STATE_PATH}.next`; await writeFile(temporary, JSON.stringify(state), { mode: 0o600 }); await rename(temporary, STATE_PATH);
}

async function mappedPort(containerName: string, containerPort: number): Promise<number> {
  const value = await docker(["port", containerName, `${containerPort}/tcp`]);
  const matched = /127\.0\.0\.1:(\d+)\s*$/u.exec(value.stdout.trim()); const port = Number(matched?.[1]);
  if (value.exitCode !== 0 || !Number.isSafeInteger(port) || port < 1) throw new ResourceError("DEPLOYMENT_PORT_UNAVAILABLE", "Candidate deployment port was not published.", 503);
  return port;
}

async function health(target: { port?: number; socketPath?: string }, host: string, spec: DeploymentSpec): Promise<void> {
  const deadline = Date.now() + spec.health.timeoutSeconds * 1000; let last = "health check did not complete";
  while (Date.now() < deadline) {
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const request = http.request({ ...(target.socketPath ? { socketPath: target.socketPath } : { host: "127.0.0.1", port: target.port }),
          path: spec.health.path, method: "GET", headers: { Host: host }, timeout: 3000 }, response => {
          response.resume(); response.once("end", () => resolve(response.statusCode ?? 0));
        });
        request.once("timeout", () => request.destroy(new Error("health timeout"))); request.once("error", reject); request.end();
      });
      if (status >= 200 && status < 400) return; last = `health returned ${status}`;
    } catch (error) { last = error instanceof Error ? error.message : "health request failed"; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new ResourceError("DEPLOYMENT_HEALTH_FAILED", `Candidate deployment failed health checks: ${last}.`, 422);
}

async function containerRunning(name: string): Promise<boolean> {
  const result = await docker(["inspect", "--format", "{{.State.Running}}", name], 10_000);
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

async function capacity(host: string, memoryMiB: number): Promise<void> {
  if (!Number.isSafeInteger(MAX_ONLINE_DEPLOYMENTS) || MAX_ONLINE_DEPLOYMENTS < 1 || MAX_ONLINE_DEPLOYMENTS > 100) {
    throw new ResourceError("DEPLOYMENT_CONFIGURATION_INVALID", "Deployment hosting quota is invalid.", 503);
  }
  if (!state.routes[host] && Object.keys(state.routes).length >= MAX_ONLINE_DEPLOYMENTS) {
    throw new ResourceError("DEPLOYMENT_HOSTING_QUOTA", `The cloud pilot currently allows ${MAX_ONLINE_DEPLOYMENTS} online applications.`, 429);
  }
  const running = await docker(["ps", "--filter", "label=daoyin.harness.deployment", "--format", "{{.Names}}"], 15_000);
  if (running.exitCode !== 0 || running.stdout.split("\n").filter(Boolean).length >= MAX_ONLINE_DEPLOYMENTS * 2 + 1) throw new ResourceError("DEPLOYMENT_CAPACITY_WAIT", "Deployment switch capacity is currently in use.", 429);
  const memory = /MemAvailable:\s+(\d+)\s+kB/iu.exec(await readFile("/proc/meminfo", "utf8"));
  if (!memory || Number(memory[1]) < (memoryMiB + 256) * 1024) throw new ResourceError("DEPLOYMENT_CAPACITY_WAIT", "The server does not have enough free memory for a safe deployment switch.", 429);
}

async function deploy(request: DeploymentWorkerRequest): Promise<Record<string, unknown>> {
  const deploymentId = request.deploymentId ?? ""; const workspaceId = request.workspaceId ?? "";
  assertResourceId(deploymentId, "dep"); assertResourceId(workspaceId, "wsp");
  if (!request.runtime || !request.entries || !request.endpoint) throw new ResourceError("DEPLOYMENT_INPUT_INVALID", "Deployment runtime, snapshot and endpoint are required.");
  assertRuntimeSpec(request.runtime);
  const spec = deploymentSpec(request.spec); const host = hostname(request.endpoint); const root = await materialize(deploymentId, request.entries);
  const containerName = `hr-dep-${deploymentId.slice(4)}`;
  await docker(["rm", "-f", containerName], 30_000).catch(() => undefined);
  const secrets = await secretArguments(deploymentId, request.runtime.secretRefs, request.secretValues);
  const bindings = await bindingArguments(spec.resourceIds, request.bindings);
  const limits = request.runtime.limits;
  await capacity(host, limits.memoryMiB);
  const environment = { ...request.runtime.environment, ...spec.environment,
    ...(spec.transport.kind === "tcp" ? { PORT: String(spec.transport.port) } : {}) };
  const egress = await ensureWorkspaceEgress(workspaceId, docker);
  const runRoot = path.join(ROOT, deploymentId, "run");
  if (spec.transport.kind === "unix") { await rm(runRoot, { recursive: true, force: true }); await mkdir(runRoot, { recursive: true, mode: 0o700 }); await chown(runRoot, 1000, 1000); }
  const args = ["run", "-d", "--name", containerName, "--runtime", RUNTIME, "--network", egress.networkName,
    "--label", `daoyin.harness.deployment=${deploymentId}`, "--label", `daoyin.harness.workspace=${workspaceId}`,
    "--user", "1000:1000", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", String(limits.pids),
    "--memory", `${limits.memoryMiB}m`, "--memory-swap", `${limits.memoryMiB}m`, "--cpus", String(limits.cpu),
    "--ulimit", "nofile=2048:2048", "--log-driver", "local", "--log-opt", "max-size=4m", "--log-opt", "max-file=3",
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m", "--mount", `type=bind,src=${root},dst=/app,readonly`,
    ...(spec.transport.kind === "tcp" ? ["--publish", `127.0.0.1::${spec.transport.port}`] : ["--mount", `type=bind,src=${runRoot},dst=/run/app`]),
    ...proxyEnvironment(workspaceId, deploymentId, egress.proxyAddress), ...secrets, ...bindings,
    ...Object.entries(environment).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    "--workdir", `/app/${spec.command.cwd === "." ? "" : spec.command.cwd}`, image(request.runtime), spec.command.executable, ...spec.command.args];
  const started = await docker(args, 60_000);
  if (started.exitCode !== 0) { await rm(path.join(SECRET_ROOT, deploymentId), { recursive: true, force: true }); throw new ResourceError("DEPLOYMENT_START_FAILED", started.stderr.slice(-4000) || "Candidate deployment did not start.", 422); }
  try {
    const target = spec.transport.kind === "tcp" ? { port: await mappedPort(containerName, spec.transport.port) }
      : { socketPath: path.join(runRoot, path.basename(spec.transport.path)) };
    await health(target, host, spec);
    state.deployments[deploymentId] = { deploymentId, workspaceId, hostname: host, containerName, ...target };
    state.routes[host] = deploymentId;
    const keep = new Set([deploymentId, ...(request.previousDeploymentId ? [request.previousDeploymentId] : [])]);
    for (const [id, old] of Object.entries(state.deployments)) if (old.hostname === host && !keep.has(id)) {
      await docker(["rm", "-f", old.containerName], 30_000).catch(() => undefined);
      await rm(path.join(SECRET_ROOT, id), { recursive: true, force: true }); delete state.deployments[id];
    }
    await persist();
    return { deploymentId, endpoint: `https://${host}`, healthy: true, previousDeploymentId: request.previousDeploymentId ?? null };
  } catch (error) { await docker(["rm", "-f", containerName], 30_000).catch(() => undefined); await rm(path.join(SECRET_ROOT, deploymentId), { recursive: true, force: true }); throw error; }
}

async function rollback(request: DeploymentWorkerRequest): Promise<Record<string, unknown>> {
  const deploymentId = request.deploymentId ?? ""; const targetId = request.previousDeploymentId ?? "";
  assertResourceId(deploymentId, "dep"); assertResourceId(targetId, "dep");
  const current = state.deployments[deploymentId]; const target = state.deployments[targetId];
  if (!current || !target || current.hostname !== target.hostname || !(await containerRunning(target.containerName))) {
    throw new ResourceError("DEPLOYMENT_ROLLBACK_UNAVAILABLE", "The previous immutable deployment is not available for activation.", 409);
  }
  state.routes[current.hostname] = targetId; await persist();
  return { deploymentId, rolledBackTo: targetId, endpoint: `https://${current.hostname}`, healthy: true };
}

async function deactivate(request: DeploymentWorkerRequest): Promise<Record<string, unknown>> {
  const deploymentId = request.deploymentId ?? ""; assertResourceId(deploymentId, "dep");
  const target = state.deployments[deploymentId];
  if (target && state.routes[target.hostname] === deploymentId) delete state.routes[target.hostname];
  if (target) await docker(["rm", "-f", target.containerName], 30_000).catch(() => undefined);
  await rm(path.join(SECRET_ROOT, deploymentId), { recursive: true, force: true });
  delete state.deployments[deploymentId]; await persist();
  return { deploymentId, active: false };
}

async function readiness(): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(ROUTER_PORT) || ROUTER_PORT < 1 || ROUTER_PORT > 65_535 || EGRESS_SECRET.length < 32 ||
      !Number.isSafeInteger(MAX_ONLINE_DEPLOYMENTS) || MAX_ONLINE_DEPLOYMENTS < 1 || MAX_ONLINE_DEPLOYMENTS > 100) throw new ResourceError("DEPLOYMENT_CONFIGURATION_INVALID", "Deployment router configuration is invalid.", 503);
  await realpath(CONTENT); const dockerInfo = await docker(["info", "--format", "{{json .Runtimes}}"], 15_000);
  if (dockerInfo.exitCode !== 0 || !(JSON.parse(dockerInfo.stdout) as Record<string, unknown>)[RUNTIME]) throw new ResourceError("SANDBOX_UNAVAILABLE", "gVisor runtime is unavailable for deployments.", 503);
  const network = await docker(["network", "inspect", "--format", "{{.Internal}} {{index .Labels \"daoyin.harness.egress\"}}", EGRESS_NETWORK], 15_000);
  if (network.exitCode !== 0 || network.stdout.trim() !== "true controlled-public") throw new ResourceError("EGRESS_UNAVAILABLE", "Controlled deployment egress network is unavailable.", 503);
  return { ready: true, router: `http://${ROUTER_HOST}:${ROUTER_PORT}`, runtime: RUNTIME, maximumOnlineDeployments: MAX_ONLINE_DEPLOYMENTS };
}

async function dispatch(request: DeploymentWorkerRequest): Promise<Record<string, unknown>> {
  if (request.action === "readiness") return readiness();
  if (request.action === "deploy") return deploy(request);
  if (request.action === "rollback") return rollback(request);
  if (request.action === "deactivate") return deactivate(request);
  if (request.action === "status") {
    const id = request.deploymentId ?? ""; assertResourceId(id, "dep"); const target = state.deployments[id];
    return { deploymentId: id, known: Boolean(target), running: target ? await containerRunning(target.containerName) : false,
      active: target ? state.routes[target.hostname] === id : false };
  }
  throw new ResourceError("DEPLOYMENT_ACTION_DENIED", "Deployment operation is not allowed.", 403);
}

function dispatchSerialized(request: DeploymentWorkerRequest): Promise<Record<string, unknown>> {
  if (request.action === "readiness" || request.action === "status") return dispatch(request);
  const pending = mutationQueue.then(() => dispatch(request));
  mutationQueue = pending.then(() => undefined, () => undefined);
  return pending;
}

async function reconcileDeploymentNetworks(): Promise<void> {
  for (const target of Object.values(state.deployments)) {
    if (!(await containerRunning(target.containerName))) continue;
    let workspaceId = target.workspaceId;
    if (!workspaceId) {
      const inspected = await docker(["inspect", "--format", "{{index .Config.Labels \"daoyin.harness.workspace\"}}", target.containerName], 10_000);
      workspaceId = inspected.exitCode === 0 ? inspected.stdout.trim() : "";
    }
    try { assertResourceId(workspaceId ?? "", "wsp"); }
    catch { throw new ResourceError("DEPLOYMENT_NETWORK_RECONCILE_FAILED", "A running deployment has no valid workspace identity.", 503); }
    await isolateExistingContainer(target.containerName, workspaceId!, EGRESS_NETWORK, docker);
    target.workspaceId = workspaceId;
  }
}

await mkdir(ROOT, { recursive: true, mode: 0o700 }); await mkdir(path.dirname(SOCKET), { recursive: true, mode: 0o750 });
await mkdir(SECRET_ROOT, { recursive: true, mode: 0o700 });
try { state = JSON.parse(await readFile(STATE_PATH, "utf8")) as PersistedState; } catch { state = { routes: {}, deployments: {} }; }
for (const [host, id] of Object.entries(state.routes)) if (!state.deployments[id] || !(await containerRunning(state.deployments[id]!.containerName))) delete state.routes[host];
await readiness(); await reconcileDeploymentNetworks(); await persist(); await unlink(SOCKET).catch(() => undefined);

const control = http.createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/deploy") { response.writeHead(404).end(); return; }
  let body = ""; request.on("data", chunk => { body += chunk.toString(); if (Buffer.byteLength(body) > 16_000_000) request.destroy(); });
  request.on("end", () => { void (async () => {
    try {
      const parsed = JSON.parse(body) as DeploymentWorkerRequest;
      const value = await dispatchSerialized(parsed);
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    } catch (error) {
      const failure = error instanceof ResourceError ? error : new ResourceError("DEPLOYMENT_EXECUTOR_FAILED", "Deployment executor failed.", 503);
      response.writeHead(failure.status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { code: failure.code, message: failure.message } }));
    }
  })(); });
});
control.listen(SOCKET, () => { const gid = Number(process.env.HARNESS_RESOURCE_GID); if (Number.isSafeInteger(gid) && gid > 0) void chown(SOCKET, 0, gid).then(() => chmod(SOCKET, 0o660)); });

function targetForHost(value: string | undefined): RouteTarget | undefined {
  const host = (value ?? "").split(":", 1)[0]!.toLowerCase(); const id = state.routes[host]; return id ? state.deployments[id] : undefined;
}
function applicationCookies(value: string | undefined): string | undefined {
  const cookies = (value ?? "").split(";").map(item => item.trim()).filter(item => /^__Host-[A-Za-z0-9_.-]+=/u.test(item));
  return cookies.length ? cookies.join("; ") : undefined;
}
function requestHeaders(request: http.IncomingMessage, target: RouteTarget): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { host: target.hostname, "x-forwarded-proto": "https", "x-forwarded-host": target.hostname };
  for (const name of ["content-type", "content-length", "accept", "accept-language", "accept-encoding", "range", "origin", "if-none-match", "if-modified-since", "user-agent"] as const) {
    if (request.headers[name] !== undefined) headers[name] = request.headers[name];
  }
  const cookies = applicationCookies(request.headers.cookie); if (cookies) headers.cookie = cookies;
  return headers;
}
function responseHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const safe: http.OutgoingHttpHeaders = {};
  for (const name of ["content-type", "content-length", "cache-control", "etag", "last-modified", "content-disposition", "location",
    "content-security-policy", "referrer-policy", "x-content-type-options", "x-frame-options", "content-encoding", "content-range", "accept-ranges", "vary",
    "access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers", "access-control-allow-credentials"] as const) {
    const value = headers[name]; if (value !== undefined) safe[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  const cookies = headers["set-cookie"]?.filter(value => /^__Host-[A-Za-z0-9_.-]+=/u.test(value) && !/;\s*domain=/iu.test(value) &&
    /;\s*secure(?:;|$)/iu.test(value) && /;\s*path=\/(?:;|$)/iu.test(value));
  if (cookies?.length) safe["set-cookie"] = cookies;
  return safe;
}
function originAllowed(request: http.IncomingMessage, target: RouteTarget): boolean {
  const origin = request.headers.origin; const expected = `https://${target.hostname}`; const unsafe = !["GET", "HEAD", "OPTIONS"].includes(request.method ?? "GET");
  return (!origin || origin === expected) && !(unsafe && applicationCookies(request.headers.cookie) && origin !== expected);
}
const router = http.createServer((request, response) => {
  const target = targetForHost(request.headers.host); if (!target) { response.writeHead(404).end("Deployment route not found.\n"); return; }
  if (!originAllowed(request, target)) { response.writeHead(403).end("Origin denied.\n"); return; }
  const headers = requestHeaders(request, target);
  const upstream = http.request({ ...(target.socketPath ? { socketPath: target.socketPath } : { host: "127.0.0.1", port: target.port }),
    method: request.method, path: request.url, headers }, reply => { response.writeHead(reply.statusCode ?? 502, responseHeaders(reply.headers)); reply.pipe(response); });
  upstream.once("error", () => { if (!response.headersSent) response.writeHead(502); response.end("Deployment unavailable.\n"); }); request.pipe(upstream);
});
router.on("upgrade", (request, socket, head) => {
  const target = targetForHost(request.headers.host); if (!target) { socket.destroy(); return; }
  if (!originAllowed(request, target)) { socket.destroy(); return; }
  const upstream = target.socketPath ? net.connect(target.socketPath) : net.connect(target.port!, "127.0.0.1");
  upstream.once("connect", () => {
    const headers = requestHeaders(request, target); headers.upgrade = request.headers.upgrade; headers.connection = "Upgrade";
    if (request.headers["sec-websocket-key"]) headers["sec-websocket-key"] = request.headers["sec-websocket-key"];
    if (request.headers["sec-websocket-version"]) headers["sec-websocket-version"] = request.headers["sec-websocket-version"];
    if (request.headers["sec-websocket-protocol"]) headers["sec-websocket-protocol"] = request.headers["sec-websocket-protocol"];
    const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`, ...Object.entries(headers).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value ?? ""}`), "", ""];
    upstream.write(lines.join("\r\n")); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket);
  });
  upstream.once("error", () => socket.destroy());
});
router.listen(ROUTER_PORT, ROUTER_HOST);

async function close(): Promise<void> {
  await Promise.all([new Promise<void>(resolve => control.close(() => resolve())), new Promise<void>(resolve => router.close(() => resolve()))]);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void close(); });
