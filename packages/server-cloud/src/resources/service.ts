import http from "node:http";
import { createHash } from "node:crypto";
import { chmod, chown, mkdir, unlink } from "node:fs/promises";
import { Pool, type PoolConfig } from "pg";
import { assertExecutionIdentity, type DeploymentSpec, type ExecutionIdentity, type WorkspaceEntry } from "@daoyin/harness-contracts";
import type { JsonValue } from "@daoyin/harness-protocol";
import { FileContentStore } from "./content-store.js";
import { ResourceError, ResourceRepository } from "./repository.js";
import { assertRuntimeSpec } from "./runtime-policy.js";
import { type DeploymentWorkerRequest, type ExecutorProcessRequest, type ResolvedSecret, type ResourceControlRequest, RESOURCE_TOOL_NAMES } from "./contracts.js";
import { unixJson } from "../projects/wire.js";

const SOCKET = "/run/daoyin-resources/control.sock";
const EXECUTOR = "/run/daoyin-resource-executor/control.sock";
const BUILDER = "/run/daoyin-resource-builder/control.sock";
const DEPLOYER = "/run/daoyin-resource-deployer/control.sock";
const database = process.env.HARNESS_RESOURCES_DATABASE_URL ?? "";
const contentRoot = process.env.HARNESS_CONTENT_STORE_ROOT ?? "";
const allowed = new Set((process.env.HARNESS_RESOURCES_ALLOWED_USERS ?? "").split(",").filter(Boolean));
const allEnabled = process.env.HARNESS_RESOURCES_ENABLED === "1";
const defaultRuntime = process.env.HARNESS_DEFAULT_RUNTIME ? JSON.parse(process.env.HARNESS_DEFAULT_RUNTIME) as import("@daoyin/harness-contracts").RuntimeSpec : undefined;
const bootstrapRuntime = process.env.HARNESS_BUILDER_BOOTSTRAP_RUNTIME ? JSON.parse(process.env.HARNESS_BUILDER_BOOTSTRAP_RUNTIME) as import("@daoyin/harness-contracts").RuntimeSpec : undefined;
if (!database || !contentRoot) throw new Error("Resource database and content store configuration are required.");
const databaseUrl = new URL(database);
const poolConfig: PoolConfig = { host: databaseUrl.searchParams.get("host") ?? databaseUrl.hostname, port: Number(databaseUrl.port || 5432),
  user: decodeURIComponent(databaseUrl.username), password: decodeURIComponent(databaseUrl.password), database: decodeURIComponent(databaseUrl.pathname.slice(1)), max: 8 };
const pool = new Pool(poolConfig);
const content = await FileContentStore.open(contentRoot);
const repository = new ResourceRepository(pool, content);

function identity(input: ResourceControlRequest): ExecutionIdentity {
  assertExecutionIdentity(input.authorization);
  const value = input.authorization;
  if (!allEnabled && !allowed.has(value.actorUserId)) throw new ResourceError("RESOURCE_NOT_ENABLED", "General cloud resources are not enabled for this account.", 403);
  return value;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new ResourceError("RESOURCE_INPUT_INVALID", `${name} is required.`);
  return value;
}

function workspaceSource(value: ResourceControlRequest["source"]): NonNullable<ResourceControlRequest["source"]> {
  const source = value ?? { kind: "empty" as const };
  if (source.kind === "empty") return source;
  if (source.kind === "git") {
    let url: URL; try { url = new URL(source.url); } catch { throw new ResourceError("WORKSPACE_SOURCE_INVALID", "Git source URL is invalid.", 422); }
    if (url.protocol !== "https:" || url.username || url.password || source.url.length > 2000 || !source.revision || source.revision.length > 200 || source.revision.includes("\0")) {
      throw new ResourceError("WORKSPACE_SOURCE_INVALID", "Git source must be a credential-free HTTPS URL and explicit revision.", 422);
    }
    return source;
  }
  if (source.kind === "upload" && /^art_[a-f0-9]{24}$/u.test(source.artifactId)) return source;
  if (source.kind === "snapshot" && /^snp_[a-f0-9]{24}$/u.test(source.snapshotId)) return source;
  throw new ResourceError("WORKSPACE_SOURCE_INVALID", "Workspace source is invalid.", 422);
}

function deploymentMetadata(value: JsonValue): DeploymentSpec {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("deployment" in value)) {
    throw new ResourceError("DEPLOYMENT_SPEC_INVALID", "Artifact metadata must contain a deployment specification.", 422);
  }
  return value.deployment as unknown as DeploymentSpec;
}

function managedEndpoint(value: string): string {
  let parsed: URL; try { parsed = new URL(value); } catch { throw new ResourceError("DEPLOYMENT_ENDPOINT_INVALID", "Deployment endpoint must be a valid HTTPS origin.", 422); }
  const host = parsed.hostname.toLowerCase(); const suffix = process.env.HARNESS_DEPLOYMENT_DOMAIN_SUFFIX ?? ".demo.daoyintech.com";
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || parsed.pathname !== "/" || parsed.search || parsed.hash ||
      !host.endsWith(suffix) || host === suffix.slice(1) || !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(host)) {
    throw new ResourceError("DEPLOYMENT_ENDPOINT_INVALID", "Deployment endpoint is outside the managed HTTPS domain.", 422);
  }
  return `https://${host}`;
}

function requestedAudit(request: ResourceControlRequest): JsonValue {
  const value: Record<string, JsonValue> = { action: request.action };
  for (const key of ["workspaceId", "resourceId", "snapshotId", "artifactId", "deploymentId", "processId", "path", "from", "to",
    "searchMode", "glob", "executable", "cwd", "revision", "endpoint"] as const) {
    const item = request[key]; if (typeof item === "string") value[key] = item;
  }
  if (Array.isArray(request.args)) value.args = request.args.map(item => {
    if (/(?:authorization|token|secret|password|passwd|api[-_]?key|access[-_]?key)(?:=|:)/iu.test(item) || /^Bearer\s+/iu.test(item)) return "[REDACTED_ARGUMENT]";
    try { const url = new URL(item); return url.username || url.password ? "[REDACTED_CREDENTIAL_URL]" : item; } catch { return item; }
  });
  if (typeof request.timeoutMs === "number") value.timeoutMs = request.timeoutMs;
  if (typeof request.maximumBytes === "number") value.maximumBytes = request.maximumBytes;
  if (request.query) value.queryDigest = `sha256:${createHash("sha256").update(request.query).digest("hex")}`;
  if (request.message) value.messageDigest = `sha256:${createHash("sha256").update(request.message).digest("hex")}`;
  return value;
}

async function completedAudit(auth: ExecutionIdentity, request: ResourceControlRequest, result: Record<string, unknown>): Promise<JsonValue> {
  const encoded = Buffer.from(JSON.stringify(result)); const payload: Record<string, JsonValue> = {
    action: request.action, resultDigest: `sha256:${createHash("sha256").update(encoded).digest("hex")}`, resultBytes: encoded.byteLength,
  };
  for (const key of ["processId", "exitCode", "cursor", "state", "status", "path", "size", "digest"] as const) {
    const item = result[key]; if (typeof item === "string" || typeof item === "number" || typeof item === "boolean" || item === null) payload[key] = item;
  }
  if (request.workspaceId && (request.action === "process_run" || request.action === "process_read") &&
      [result.stdout, result.stderr, result.output].some(item => typeof item === "string" && item.length)) {
    const artifact = await repository.createArtifact(auth, { workspaceId: request.workspaceId, title: `${request.action} output`,
      mediaType: "application/json", content: encoded, metadata: { runId: request.sourceRun ?? null, processId: request.processId ?? null, audit: true } });
    payload.outputArtifactId = artifact.id; payload.outputBlobHash = artifact.blobHash;
  }
  return payload;
}

async function localCall(socket: string, path: string, input: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
  try { return await unixJson(socket, path, input, signal, 650_000); }
  catch (error) {
    const value = error as { code?: unknown; status?: unknown; message?: unknown };
    if (typeof value.code === "string" && typeof value.status === "number") throw new ResourceError(value.code, typeof value.message === "string" ? value.message : "Resource worker failed.", value.status);
    throw error;
  }
}
function executor(input: ExecutorProcessRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return localCall(EXECUTOR, "/execute", input, signal);
}
function builder(input: { workspaceId: string; dockerfile: string; context: string; timeoutMs: number }, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return localCall(BUILDER, "/build", input, signal);
}

async function resolveSecrets(auth: ExecutionIdentity, refs: readonly string[], signal?: AbortSignal): Promise<ResolvedSecret[]> {
  if (!refs.length) return [];
  const endpoint = process.env.HARNESS_SECRET_RESOLVER_URL ?? ""; const token = process.env.HARNESS_SECRET_RESOLVER_TOKEN ?? "";
  let url: URL; try { url = new URL(endpoint); } catch { throw new ResourceError("SECRET_RESOLVER_UNAVAILABLE", "Trusted secret resolver is not configured.", 503); }
  if (token.length < 32 || url.username || url.password || !((url.protocol === "http:" && ["127.0.0.1", "::1"].includes(url.hostname)) || url.protocol === "https:")) {
    throw new ResourceError("SECRET_RESOLVER_UNAVAILABLE", "Trusted secret resolver is not configured.", 503);
  }
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", ...(signal ? { signal } : {}), headers: { "Content-Type": "application/json", "X-AI-Service-Token": token },
      body: JSON.stringify({ actorUserId: auth.actorUserId, space: auth.space, refs }) });
  } catch { throw new ResourceError("SECRET_RESOLVER_UNAVAILABLE", "Trusted secret resolver could not be reached.", 503); }
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new ResourceError("SECRET_RESOLUTION_DENIED", "Requested execution secrets are unavailable.", response.status === 403 ? 403 : 503); }
  const body = await response.json() as { secrets?: unknown };
  if (!Array.isArray(body.secrets) || body.secrets.length !== refs.length || JSON.stringify(body).length > 1_000_000) throw new ResourceError("SECRET_RESPONSE_INVALID", "Trusted secret resolver returned an invalid response.", 503);
  const expected = new Set(refs); const values = body.secrets as Array<{ ref?: unknown; value?: unknown }>;
  if (values.some(item => typeof item.ref !== "string" || !expected.has(item.ref) || typeof item.value !== "string" || item.value.length > 262_144) || new Set(values.map(item => item.ref)).size !== refs.length) {
    throw new ResourceError("SECRET_RESPONSE_INVALID", "Trusted secret resolver returned an invalid response.", 503);
  }
  return values as ResolvedSecret[];
}
function deployer(input: DeploymentWorkerRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return localCall(DEPLOYER, "/deploy", input, signal);
}

async function workspaceAccess(auth: ExecutionIdentity, request: ResourceControlRequest): Promise<string> {
  const workspaceId = required(request.workspaceId, "workspaceId");
  await repository.authorizeAttached(auth, required(request.sessionId, "sessionId"), workspaceId);
  return workspaceId;
}

async function dispatchUnlocked(request: ResourceControlRequest, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!request || typeof request !== "object" || typeof request.action !== "string") throw new ResourceError("RESOURCE_INPUT_INVALID", "Resource action is required.");
  if (request.action === "readiness") return { ready: true, executor: await executor({ action: "readiness" }, signal),
    ...(process.env.HARNESS_DEPLOYMENT_EXECUTOR_ENABLED === "1" ? { deployer: await deployer({ action: "readiness" }, signal) } : {}) };
  const auth = identity(request);
  if (request.action === "cancel_run") {
    const runId = required(request.sourceRun, "sourceRun"); const stopped: string[] = [];
    for (const process of await repository.runningProcessesForRun(auth, runId)) {
      await executor({ action: "process", operation: "stop", workspaceId: process.workspaceId, processId: process.id }).catch(() => undefined);
      await repository.updateProcess(auth, process.workspaceId, process.id, { status: "cancelled" }); stopped.push(process.id);
    }
    return { summary: "Run processes cancelled.", stopped };
  }
  if (request.action === "resource_list") return { summary: "Resources listed.", resources: await repository.list(auth), attached: await repository.attached(auth, required(request.sessionId, "sessionId")) };
  if (request.action === "resource_attach") {
    await repository.attach(auth, required(request.sessionId, "sessionId"), required(request.resourceId, "resourceId"));
    return { summary: "Resource attached." };
  }
  if (request.action === "resource_detach") {
    await repository.detach(auth, required(request.sessionId, "sessionId"), required(request.resourceId, "resourceId"));
    return { summary: "Resource detached." };
  }
  if (request.action === "workspace_create") {
    const selectedRuntime = request.runtime ?? defaultRuntime;
    if (!selectedRuntime) throw new ResourceError("WORKSPACE_INPUT_INVALID", "A signed workspace runtime is required.");
    assertRuntimeSpec(selectedRuntime);
    if (request.runtime?.image.kind === "dockerfile" && request.runtime.image.imageDigest) {
      throw new ResourceError("RUNTIME_IMAGE_BUILD_REQUIRED", "Dockerfile images must be produced by the isolated builder.", 403);
    }
    const source = workspaceSource(request.source);
    const workspace = await repository.createWorkspace(auth, { title: required(request.title, "title"), source, runtime: selectedRuntime });
    await repository.attach(auth, required(request.sessionId, "sessionId"), workspace.id);
    try {
      const needsBuild = workspace.runtime.image.kind === "dockerfile" && !workspace.runtime.image.imageDigest;
      const preparationRuntime = needsBuild ? bootstrapRuntime : workspace.runtime;
      if (!preparationRuntime) throw new ResourceError("OCI_BUILDER_UNAVAILABLE", "A signed bootstrap runtime is required for Dockerfile workspaces.", 503);
      const sourceSnapshot = workspace.source.kind === "snapshot" ? await repository.snapshotOwned(auth, workspace.source.snapshotId) : undefined;
      const sourceArtifact = workspace.source.kind === "upload" ? await repository.artifact(auth, workspace.source.artifactId) : undefined;
      const prepared = await executor({ action: "workspace_prepare", workspaceId: workspace.id, runtime: preparationRuntime,
        source: workspace.source, runId: request.sourceRun, ...(sourceSnapshot ? { entries: [...sourceSnapshot.entries] } : {}),
        ...(sourceArtifact ? { archiveDigest: sourceArtifact.blobHash, mediaType: sourceArtifact.mediaType } : {}) }, signal);
      let activeWorkspace = workspace;
      if (needsBuild && workspace.runtime.image.kind === "dockerfile") {
        const built = await builder({ workspaceId: workspace.id, dockerfile: workspace.runtime.image.path,
          context: workspace.runtime.image.context, timeoutMs: Math.min(workspace.runtime.limits.timeoutSeconds * 1000, 600_000) }, signal);
        if (typeof built.archive !== "string" || typeof built.archiveDigest !== "string") throw new ResourceError("OCI_BUILD_INVALID", "OCI builder returned an invalid artifact.", 503);
        const imported = await executor({ action: "image_import", workspaceId: workspace.id, archive: built.archive, archiveDigest: built.archiveDigest }, signal);
        if (typeof imported.imageDigest !== "string") throw new ResourceError("OCI_IMAGE_IMPORT_FAILED", "Built OCI image digest is unavailable.", 503);
        const runtime = { ...workspace.runtime, image: { ...workspace.runtime.image, imageDigest: imported.imageDigest } };
        activeWorkspace = await repository.setWorkspaceRuntime(auth, workspace.id, runtime);
        await executor({ action: "workspace_prepare", operation: "set_runtime", workspaceId: workspace.id, runtime }, signal);
        if (typeof built.log === "string") await repository.createArtifact(auth, { workspaceId: workspace.id,
          title: "OCI build log", mediaType: "text/plain", content: Buffer.from(built.log), metadata: { archiveDigest: built.archiveDigest } });
      }
      const entries = Array.isArray(prepared.entries) ? prepared.entries as WorkspaceEntry[] : [];
      const snapshot = await repository.recordSnapshot(auth, workspace.id, entries);
      return { summary: "Workspace created.", workspace: await repository.setWorkspaceState(auth, activeWorkspace.id, "ready"), snapshot };
    } catch (error) {
      await repository.setWorkspaceState(auth, workspace.id, "failed", error instanceof Error ? error.message : "Workspace preparation failed.");
      throw error;
    }
  }
  if (request.action === "workspace_inspect") {
    const workspaceId = await workspaceAccess(auth, request);
    return { summary: "Workspace inspected.", workspace: await repository.workspace(auth, workspaceId),
      snapshots: await repository.snapshots(auth, workspaceId), processes: await repository.processes(auth, workspaceId),
      artifacts: await repository.artifacts(auth, workspaceId), deployments: await repository.deployments(auth, workspaceId),
      network: await repository.networkActivity(auth, workspaceId), events: await repository.events(auth, workspaceId) };
  }
  if (request.action === "workspace_snapshot") {
    const workspaceId = await workspaceAccess(auth, request);
    const exported = await executor({ action: "workspace_prepare", operation: "snapshot", workspaceId }, signal);
    const entries = Array.isArray(exported.entries) ? exported.entries as WorkspaceEntry[] : [];
    return { summary: "Workspace snapshot created.", snapshot: await repository.recordSnapshot(auth, workspaceId, entries) };
  }
  if (request.action === "workspace_restore") {
    const workspaceId = await workspaceAccess(auth, request); const snapshotId = required(request.snapshotId, "snapshotId");
    const snapshot = await repository.snapshotById(auth, workspaceId, snapshotId);
    await executor({ action: "workspace_prepare", operation: "restore", workspaceId, snapshotId, entries: [...snapshot.entries] }, signal);
    return { summary: "Workspace restored.", workspace: await repository.restore(auth, workspaceId, snapshotId), snapshot };
  }
  if (request.action.startsWith("file_")) {
    const workspaceId = await workspaceAccess(auth, request);
    const result = await executor({ action: "file", operation: request.action.slice(5), workspaceId, runId: request.sourceRun,
      path: request.path, from: request.from, to: request.to, content: request.content, contentBase64: request.contentBase64,
      expected: request.expected, replacement: request.replacement, patch: request.patch, query: request.query,
      searchMode: request.searchMode, glob: request.glob, startLine: request.startLine, endLine: request.endLine,
      maximumBytes: request.maximumBytes }, signal);
    return { summary: `${request.action} completed.`, ...result };
  }
  if (request.action.startsWith("git_")) {
    const workspaceId = await workspaceAccess(auth, request);
    const result = await executor({ action: "git", operation: request.action.slice(4), workspaceId, runId: request.sourceRun, revision: request.revision, message: request.message, maximumBytes: request.maximumBytes }, signal);
    if (request.action === "git_export_patch" && typeof result.content === "string") {
      const artifact = await repository.createArtifact(auth, { workspaceId, title: "Git patch", mediaType: "text/x-diff", content: Buffer.from(result.content), metadata: { sourceRun: request.sourceRun ?? null } });
      return { summary: "Git patch exported.", artifact };
    }
    return { summary: `${request.action} completed.`, ...result };
  }
  if (request.action.startsWith("process_")) {
    const workspaceId = await workspaceAccess(auth, request);
    if (request.action !== "process_start" && request.action !== "process_run" && request.action !== "process_list") {
      await repository.process(auth, workspaceId, required(request.processId, "processId"));
    }
    const secretValues = request.action === "process_start" || request.action === "process_run"
      ? await resolveSecrets(auth, (await repository.workspace(auth, workspaceId)).runtime.secretRefs, signal) : [];
    const result = await executor({ action: "process", operation: request.action.slice(8), workspaceId, processId: request.processId,
      runId: request.sourceRun, executable: request.executable, args: request.args, cwd: request.cwd, stdin: request.stdin,
      mode: request.processMode, timeoutMs: request.timeoutMs, cursor: request.cursor, environment: request.environment, secretValues }, signal);
    if (request.action === "process_start" && typeof result.processId === "string") {
      await repository.recordProcess(auth, { id: result.processId, workspaceId,
        runId: required(request.sourceRun, "sourceRun"), executable: required(request.executable, "executable"),
        args: request.args ?? [], cwd: request.cwd ?? ".", mode: request.processMode === "pty" ? "pty" : "background",
        ...(typeof result.timeoutAt === "string" ? { timeoutAt: result.timeoutAt } : {}) });
    } else if (request.action === "process_read" && typeof request.processId === "string") {
      const state = result.state === "exited" ? (result.exitCode === 0 ? "exited" : "failed")
        : result.state === "timed_out" ? "timed_out" : undefined;
      await repository.updateProcess(auth, workspaceId, request.processId, {
        ...(state ? { status: state } : {}),
        ...(typeof result.exitCode === "number" ? { exitCode: result.exitCode } : {}),
        ...(typeof result.cursor === "number" ? { outputCursor: result.cursor } : {}),
      });
    } else if (request.action === "process_stop" && typeof request.processId === "string") {
      await repository.updateProcess(auth, workspaceId, request.processId, { status: "cancelled" });
    } else if (request.action === "process_list") {
      const live = new Set(Array.isArray(result.processes) ? (result.processes as Array<{ processId?: unknown }>).map((item) => item.processId).filter((id): id is string => typeof id === "string") : []);
      const recorded = await repository.processes(auth, workspaceId);
      for (const process of recorded) if (["starting", "running"].includes(process.status) && !live.has(process.id)) {
        await repository.updateProcess(auth, workspaceId, process.id, { status: process.timeoutAt && Date.parse(process.timeoutAt) <= Date.now() ? "timed_out" : "interrupted" });
      }
      return { summary: "process_list completed.", processes: await repository.processes(auth, workspaceId) };
    }
    return { summary: `${request.action} completed.`, ...result };
  }
  if (request.action === "artifact_create") {
    const workspaceId = await workspaceAccess(auth, request);
    const exported = await executor({ action: "workspace_prepare", operation: "snapshot", workspaceId }, signal);
    const snapshot = await repository.recordSnapshot(auth, workspaceId, Array.isArray(exported.entries) ? exported.entries as WorkspaceEntry[] : []);
    const artifactPath = required(request.path, "path"); const entry = snapshot.entries.find(item => item.path === artifactPath);
    if (!entry || entry.kind !== "file") throw new ResourceError("ARTIFACT_CONTENT_INVALID", "Artifact path must be a regular file in the captured snapshot.", 422);
    const artifactContent = await content.read(entry.blobHash, 128 * 1024 * 1024);
    const artifact = await repository.createArtifact(auth, { workspaceId, snapshotId: snapshot.id,
      title: required(request.title, "title"), mediaType: required(request.mediaType, "mediaType"), content: artifactContent, metadata: request.metadata as JsonValue });
    return { summary: "Artifact created.", artifact };
  }
  if (request.action === "artifact_read") {
    const artifactId = required(request.artifactId, "artifactId"); const artifact = await repository.artifact(auth, artifactId);
    await repository.authorizeAttached(auth, required(request.sessionId, "sessionId"), artifact.workspaceId);
    const value = await repository.artifactContent(auth, artifactId, Math.min(request.maximumBytes ?? 1_000_000, 1_000_000));
    return { summary: "Artifact read.", artifact: value.artifact, contentBase64: value.content.toString("base64") };
  }
  if (request.action === "artifact_list") {
    const workspaceId = await workspaceAccess(auth, request);
    return { summary: "Artifacts listed.", artifacts: await repository.artifacts(auth, workspaceId) };
  }
  if (request.action === "deployment_create") {
    if (process.env.HARNESS_DEPLOYMENT_EXECUTOR_ENABLED !== "1") throw new ResourceError("DEPLOYMENT_UNAVAILABLE", "The generic deployment executor is not enabled.", 503);
    const workspaceId = await workspaceAccess(auth, request); const operationId = required(request.requestId, "requestId");
    const existing = await repository.deploymentByOperation(auth, workspaceId, operationId);
    if (existing) return { summary: "Deployment request already processed.", deployment: existing };
    const endpoint = managedEndpoint(required(request.endpoint, "endpoint")); await repository.claimDeploymentEndpoint(auth, workspaceId, endpoint);
    const artifact = await repository.artifact(auth, required(request.artifactId, "artifactId"));
    if (artifact.workspaceId !== workspaceId || !artifact.snapshotId) throw new ResourceError("DEPLOYMENT_ARTIFACT_INVALID", "Deployment artifact must belong to a durable workspace snapshot.", 422);
    const snapshot = await repository.snapshotById(auth, workspaceId, artifact.snapshotId); const workspace = await repository.workspace(auth, workspaceId);
    const spec = deploymentMetadata(artifact.metadata);
    const bindings = await repository.resolveBindings(auth, required(request.sessionId, "sessionId"), spec.resourceIds);
    const previous = await repository.healthyDeploymentAt(auth, endpoint);
    const deployment = await repository.createDeployment(auth, { workspaceId, artifactId: artifact.id, operationId, endpoint,
      ...(previous ? { previousDeploymentId: previous.id } : {}) });
    await repository.setDeploymentStatus(auth, deployment.id, "starting");
    try {
      const result = await deployer({ action: "deploy", deploymentId: deployment.id, workspaceId, endpoint,
        runtime: workspace.runtime, entries: [...snapshot.entries], spec, bindings,
        secretValues: await resolveSecrets(auth, workspace.runtime.secretRefs, signal),
        ...(previous ? { previousDeploymentId: previous.id } : {}) }, signal);
      const active = await repository.activateDeployment(auth, deployment.id, previous?.id);
      return { summary: "Deployment is healthy and the route was switched.", deployment: active, result };
    } catch (error) {
      // The worker may have switched its route even when the control response was lost.
      // Always make the old route authoritative again before marking the request failed.
      if (previous) {
        const restored = await deployer({ action: "rollback", deploymentId: deployment.id, previousDeploymentId: previous.id }, signal)
          .then(() => true, () => false);
        if (!restored) await deployer({ action: "deactivate", deploymentId: deployment.id }, signal).catch(() => undefined);
      } else {
        await deployer({ action: "deactivate", deploymentId: deployment.id }, signal).catch(() => undefined);
      }
      await repository.setDeploymentStatus(auth, deployment.id, "failed").catch(() => undefined); throw error;
    }
  }
  if (request.action === "deployment_status") {
    const deployment = await repository.deployment(auth, required(request.deploymentId, "deploymentId"));
    await repository.authorizeAttached(auth, required(request.sessionId, "sessionId"), deployment.workspaceId);
    const runtime = process.env.HARNESS_DEPLOYMENT_EXECUTOR_ENABLED === "1"
      ? await deployer({ action: "status", deploymentId: deployment.id }, signal).catch(() => ({ known: false, running: false, active: false })) : null;
    return { summary: "Deployment status read.", deployment, runtime };
  }
  if (request.action === "deployment_rollback") {
    if (process.env.HARNESS_DEPLOYMENT_EXECUTOR_ENABLED !== "1") throw new ResourceError("DEPLOYMENT_UNAVAILABLE", "The generic deployment executor is not enabled.", 503);
    const deployment = await repository.deployment(auth, required(request.deploymentId, "deploymentId"));
    await repository.authorizeAttached(auth, required(request.sessionId, "sessionId"), deployment.workspaceId);
    return repository.serializeWorkspace(deployment.workspaceId, async () => {
      const current = await repository.deployment(auth, deployment.id);
      if (!current.previousDeploymentId) throw new ResourceError("DEPLOYMENT_ROLLBACK_UNAVAILABLE", "Deployment has no previous healthy version.", 409);
      const result = await deployer({ action: "rollback", deploymentId: current.id, previousDeploymentId: current.previousDeploymentId }, signal);
      return { summary: "Previous deployment restored and the route was switched.",
        deployment: await repository.activateRollback(auth, current.id, current.previousDeploymentId), result };
    });
  }
  if (!RESOURCE_TOOL_NAMES.includes(request.action as never)) throw new ResourceError("RESOURCE_ACTION_DENIED", "Resource operation is not allowed.", 403);
  throw new ResourceError("RESOURCE_ACTION_UNAVAILABLE", "Resource operation is not available.", 501);
}

const serializedActions = new Set<string>([
  "workspace_snapshot", "workspace_restore", "file_write", "file_patch", "file_mkdir", "file_move", "file_remove",
  "git_branch", "git_checkout", "git_commit", "process_run", "process_start", "process_write", "process_stop",
  "artifact_create", "deployment_create",
]);

async function dispatch(request: ResourceControlRequest, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (request.workspaceId && serializedActions.has(request.action)) {
    identity(request);
    return repository.serializeWorkspace(request.workspaceId, () => dispatchUnlocked(request, signal));
  }
  return dispatchUnlocked(request, signal);
}

await pool.query("SELECT 1 FROM harness_resources LIMIT 0");
if (process.env.HARNESS_DEPLOYMENT_EXECUTOR_ENABLED === "1") {
  for (const pending of await repository.pendingDeployments()) {
    await deployer(pending.previousDeploymentId ? { action: "rollback", deploymentId: pending.id, previousDeploymentId: pending.previousDeploymentId }
      : { action: "deactivate", deploymentId: pending.id }).catch(() => undefined);
    await repository.failPendingDeployment(pending.id);
  }
}
await mkdir("/run/daoyin-resources", { recursive: true, mode: 0o750 });
await unlink(SOCKET).catch(() => undefined);
const server = http.createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/control") { response.writeHead(404).end(); return; }
  const controller = new AbortController(); request.once("close", () => controller.abort()); let body = "";
  request.on("data", chunk => { body += chunk.toString(); if (Buffer.byteLength(body) > 2_000_000) request.destroy(); });
  request.on("end", () => { void (async () => {
    let parsed: ResourceControlRequest | undefined;
    let auditIdentity: ExecutionIdentity | undefined;
    let resourceId: string | undefined;
    try {
      parsed = JSON.parse(body) as ResourceControlRequest;
      if (parsed.action !== "readiness") {
        auditIdentity = identity(parsed);
        resourceId = parsed.workspaceId ?? parsed.resourceId ?? parsed.artifactId ?? parsed.deploymentId ?? parsed.processId;
        await repository.appendEvent(auditIdentity, { eventType: "operation.requested",
          ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}), ...(parsed.sourceRun ? { runId: parsed.sourceRun } : {}),
          ...(parsed.requestId ? { requestId: parsed.requestId } : {}), ...(resourceId ? { resourceId } : {}),
          payload: requestedAudit(parsed) });
      }
      const value = await dispatch(parsed, controller.signal);
      if (auditIdentity) await repository.appendEvent(auditIdentity, { eventType: "operation.completed",
        ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}), ...(parsed.sourceRun ? { runId: parsed.sourceRun } : {}),
        ...(parsed.requestId ? { requestId: parsed.requestId } : {}), ...(resourceId ? { resourceId } : {}),
        payload: await completedAudit(auditIdentity, parsed, value) });
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    } catch (error) {
      const failure = error instanceof ResourceError ? error : new ResourceError("RESOURCE_SERVICE_FAILED", "Resource service operation failed.", 503);
      if (auditIdentity && parsed) await repository.appendEvent(auditIdentity, { eventType: "operation.failed",
        ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}), ...(parsed.sourceRun ? { runId: parsed.sourceRun } : {}),
        ...(parsed.requestId ? { requestId: parsed.requestId } : {}), ...(resourceId ? { resourceId } : {}),
        payload: { action: parsed.action, code: failure.code } }).catch(() => undefined);
      response.writeHead(failure.status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { code: failure.code, message: failure.message } }));
    }
  })(); });
});
server.listen(SOCKET, () => {
  const gid = Number(process.env.HARNESS_RESOURCE_GID);
  if (Number.isSafeInteger(gid) && gid > 0) void chown(SOCKET, -1, gid).then(() => chmod(SOCKET, 0o660));
});

async function close(): Promise<void> { await new Promise<void>(resolve => server.close(() => resolve())); await pool.end(); }
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void close(); });
