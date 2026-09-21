import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { chmod, chown, lstat, mkdir, readFile, realpath, rm, stat, unlink } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { assertResourceId, assertWorkspacePath } from "@daoyin/harness-contracts";
import { ResourceError } from "./repository.js";

const WORKSPACES = process.env.HARNESS_WORKSPACE_ROOT ?? "/var/lib/daoyin-resources/workspaces";
const OUTPUTS = process.env.HARNESS_BUILD_OUTPUT_ROOT ?? "/var/lib/daoyin-resources/builds";
const BUILDKIT = process.env.HARNESS_BUILDKIT_ADDRESS ?? "unix:///run/daoyin-buildkit/buildkitd.sock";
const SOCKET = "/run/daoyin-resource-builder/control.sock";

interface BuildRequest { workspaceId: string; dockerfile: string; context: string; timeoutMs?: number }
async function safeDirectory(workspaceId: string, relative: string): Promise<string> {
  assertResourceId(workspaceId, "wsp"); assertWorkspacePath(relative === "." ? "workspace" : relative);
  const root = await realpath(path.join(WORKSPACES, workspaceId)); const target = await realpath(path.resolve(root, relative));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new ResourceError("BUILD_CONTEXT_ESCAPE", "Build context escapes the workspace.", 403);
  if (!(await lstat(target)).isDirectory()) throw new ResourceError("BUILD_CONTEXT_INVALID", "Build context must be a directory.");
  return target;
}
async function safeDockerfile(root: string, relative: string): Promise<string> {
  assertWorkspacePath(relative); const target = await realpath(path.resolve(root, relative));
  if (!target.startsWith(`${root}${path.sep}`) || !(await lstat(target)).isFile()) throw new ResourceError("DOCKERFILE_INVALID", "Dockerfile is not a regular workspace file.");
  return target;
}
function validateDockerfile(value: string): void {
  if (Buffer.byteLength(value) > 1_000_000) throw new ResourceError("DOCKERFILE_LIMIT", "Dockerfile exceeds the size limit.", 413);
  const logical = value.replace(/\\\r?\n/gu, " ").split(/\r?\n/u);
  const from = logical.map((line) => /^\s*FROM\s+(?:--platform=\S+\s+)?([^\s]+)(?:\s+AS\s+\S+)?\s*$/iu.exec(line)?.[1]).filter((item): item is string => Boolean(item));
  if (!from.length || from.some((image) => !image.includes("@sha256:") || !/@sha256:[a-f0-9]{64}$/u.test(image))) {
    throw new ResourceError("DOCKERFILE_BASE_UNPINNED", "Every Dockerfile base image must use an exact sha256 digest.", 422);
  }
  if (logical.some((line) => /^\s*(?:ADD\s+https?:|RUN\s+--mount=type=ssh|RUN\s+--mount=type=secret)/iu.test(line))) {
    throw new ResourceError("DOCKERFILE_DIRECT_SECRET_DENIED", "Remote ADD, SSH mounts and inline secret mounts are not allowed.", 403);
  }
}
async function execute(executable: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C.UTF-8" } });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0), stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0), exceeded = false;
    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
      if (current.byteLength + chunk.byteLength > 2_000_000) { exceeded = true; child.kill("SIGKILL"); return current; }
      return Buffer.concat([current, chunk]);
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); }); child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once("error", reject); const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("close", (code) => { clearTimeout(timer); if (exceeded) reject(new ResourceError("BUILD_OUTPUT_LIMIT", "Build logs exceeded the limit.", 413));
      else if (code !== 0) reject(new ResourceError("OCI_BUILD_FAILED", stderr.toString().slice(-4000) || "OCI build failed.", 422));
      else resolve({ stdout: stdout.toString(), stderr: stderr.toString() }); });
  });
}
async function digest(file: string): Promise<string> {
  return new Promise((resolve, reject) => { const hash = createHash("sha256"); const stream = createReadStream(file); stream.on("data", (chunk) => hash.update(chunk)); stream.once("error", reject); stream.once("end", () => resolve(`sha256:${hash.digest("hex")}`)); });
}
async function build(request: BuildRequest): Promise<Record<string, unknown>> {
  const context = await safeDirectory(request.workspaceId, request.context); const dockerfile = await safeDockerfile(context, request.dockerfile);
  validateDockerfile(await readFile(dockerfile, "utf8")); await mkdir(OUTPUTS, { recursive: true, mode: 0o700 });
  const output = path.join(OUTPUTS, `${request.workspaceId}-${randomBytes(8).toString("hex")}.tar`);
  try {
    const result = await execute("/usr/bin/buildctl", ["--addr", BUILDKIT, "build", "--frontend", "dockerfile.v0",
      "--local", `context=${context}`, "--local", `dockerfile=${path.dirname(dockerfile)}`, "--opt", `filename=${path.basename(dockerfile)}`,
      "--output", `type=oci,dest=${output}`, "--progress", "plain"], Math.min(request.timeoutMs ?? 600_000, 600_000));
    const info = await stat(output); if (!info.isFile() || info.size > 2 * 1024 * 1024 * 1024) throw new ResourceError("OCI_IMAGE_LIMIT", "Built OCI image exceeds the limit.", 413);
    return { archive: output, archiveDigest: await digest(output), size: info.size, log: `${result.stdout}${result.stderr}`.slice(-200_000) };
  } catch (error) { await rm(output, { force: true }); throw error; }
}

await mkdir(path.dirname(SOCKET), { recursive: true, mode: 0o750 }); await unlink(SOCKET).catch(() => undefined);
const server = http.createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/build") { response.writeHead(404).end(); return; }
  let body = ""; request.on("data", (chunk) => { body += chunk.toString(); if (Buffer.byteLength(body) > 64_000) request.destroy(); });
  request.on("end", () => { void (async () => {
    try {
      const value = await build(JSON.parse(body) as BuildRequest);
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    } catch (error) {
      const failure = error instanceof ResourceError ? error : new ResourceError("OCI_BUILDER_FAILED", "OCI builder failed.", 503);
      response.writeHead(failure.status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { code: failure.code, message: failure.message } }));
    }
  })(); });
});
server.listen(SOCKET, () => { const gid = Number(process.env.HARNESS_RESOURCE_GID);
  if (Number.isSafeInteger(gid) && gid > 0) void chown(SOCKET, -1, gid).then(() => chmod(SOCKET, 0o660)); });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close());
