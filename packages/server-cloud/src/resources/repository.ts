import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import type { Pool, PoolClient } from "pg";
import {
  assertResourceId, assertSha256Digest, assertWorkspacePath, type Artifact, type Deployment,
  type ExecutionIdentity, type ProcessSession, type ResourceRef, type RuntimeSpec, type Workspace, type WorkspaceEntry,
  type WorkspaceSnapshot, type WorkspaceSource,
} from "@daoyin/harness-contracts";
import type { JsonValue } from "@daoyin/harness-protocol";
import type { ContentStore } from "./content-store.js";
import type { ResolvedResourceBinding } from "./contracts.js";

export class ResourceError extends Error {
  public constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); }
}

export interface SnapshotInputEntry {
  path: string;
  mode?: number;
  content?: Uint8Array;
  symlinkTarget?: string;
}

const resourceColumns = `id,kind,title,version,capabilities,created_at AS "createdAt",updated_at AS "updatedAt"`;
const workspaceColumns = `${resourceColumns},w.source,w.runtime,w.active_snapshot_id AS "activeSnapshotId",w.state`;
const id = (prefix: "wsp" | "snp" | "art" | "dep" | "prc" | "op"): string => `${prefix}_${randomBytes(12).toString("hex")}`;
// Resources belong to an authenticated account and space, rather than one app installation.
// This matches the legacy project owner key so one-time migration preserves ownership.
const ownerKey = (identity: ExecutionIdentity): string => createHash("sha256")
  .update(JSON.stringify([String(identity.actorUserId), JSON.stringify(identity.space)]))
  .digest("hex");
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value !== null && typeof value === "object" ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
    : JSON.stringify(value) ?? "null";

function safeSymlink(entryPath: string, target: string): void {
  if (!target || target.includes("\0") || path.posix.isAbsolute(target)) throw new ResourceError("WORKSPACE_SYMLINK_INVALID", "Symbolic link target must be workspace-relative.");
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entryPath), target));
  if (resolved === ".." || resolved.startsWith("../")) throw new ResourceError("WORKSPACE_SYMLINK_ESCAPE", "Symbolic link escapes the workspace.");
}

function safeEntryPath(value: string): void {
  assertWorkspacePath(value);
  if (/^(?:\.harness(?:\/|$)|\.harness-restore-|lost\+found(?:\/|$))/u.test(value)) throw new ResourceError("WORKSPACE_PATH_RESERVED", "Snapshot contains a reserved workspace path.");
}

function runtime(runtime: RuntimeSpec): RuntimeSpec {
  if (!runtime || !["public", "none"].includes(runtime.network) || !runtime.image || !["builtin", "dockerfile"].includes(runtime.image.kind)) {
    throw new ResourceError("WORKSPACE_RUNTIME_INVALID", "Workspace runtime specification is invalid.");
  }
  if (!runtime.environment || typeof runtime.environment !== "object" || Array.isArray(runtime.environment) ||
      !Array.isArray(runtime.secretRefs) || runtime.secretRefs.some((item) => typeof item !== "string")) {
    throw new ResourceError("WORKSPACE_RUNTIME_INVALID", "Workspace environment or secret references are invalid.");
  }
  if (Object.entries(runtime.environment).some(([key, value]) => !/^[A-Z_][A-Z0-9_]{0,79}$/u.test(key) ||
      /(?:TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|AUTH|API_KEY|ACCESS_KEY)/u.test(key) || typeof value !== "string" || value.includes("\0") || value.length > 16_000)) {
    throw new ResourceError("WORKSPACE_ENVIRONMENT_INVALID", "Workspace environment contains a denied key or value.", 403);
  }
  if (runtime.image.kind === "builtin") {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/u.test(runtime.image.id)) throw new ResourceError("WORKSPACE_IMAGE_INVALID", "Built-in runtime image id is invalid.");
    try { assertSha256Digest(runtime.image.digest); } catch { throw new ResourceError("WORKSPACE_IMAGE_INVALID", "Built-in runtime image digest is invalid."); }
  } else {
    try { assertWorkspacePath(runtime.image.path); assertWorkspacePath(runtime.image.context === "." ? "workspace" : runtime.image.context); }
    catch { throw new ResourceError("WORKSPACE_IMAGE_INVALID", "Dockerfile path or context is invalid."); }
    if (runtime.image.imageDigest !== undefined) try { assertSha256Digest(runtime.image.imageDigest); }
    catch { throw new ResourceError("WORKSPACE_IMAGE_INVALID", "Built image digest is invalid."); }
  }
  const limits = runtime.limits;
  if (!limits || limits.cpu <= 0 || limits.cpu > 8 || limits.memoryMiB < 128 || limits.memoryMiB > 16_384 ||
      limits.pids < 16 || limits.pids > 4096 || limits.diskMiB < 128 || limits.diskMiB > 102_400 ||
      limits.timeoutSeconds < 1 || limits.timeoutSeconds > 3600 || limits.maxOutputBytes < 1024 || limits.maxOutputBytes > 16_000_000) {
    throw new ResourceError("WORKSPACE_LIMIT_INVALID", "Workspace resource limits are outside the allowed range.");
  }
  if (runtime.secretRefs.some(item => !/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,159}$/u.test(item))) {
    throw new ResourceError("WORKSPACE_SECRET_REF_INVALID", "Workspace secret reference is invalid.");
  }
  return structuredClone(runtime);
}

function source(value: WorkspaceSource): WorkspaceSource {
  if (!value || typeof value !== "object") throw new ResourceError("WORKSPACE_SOURCE_INVALID", "Workspace source is invalid.");
  if (value.kind === "empty" && Object.keys(value).length === 1) return structuredClone(value);
  if (value.kind === "git" && Object.keys(value).every((key) => ["kind", "url", "revision"].includes(key)) &&
      typeof value.url === "string" && typeof value.revision === "string" && value.revision.length >= 1 && value.revision.length <= 200) {
    let url: URL; try { url = new URL(value.url); } catch { throw new ResourceError("WORKSPACE_GIT_URL_INVALID", "Git source URL is invalid."); }
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname) throw new ResourceError("WORKSPACE_GIT_URL_INVALID", "Git source must use credential-free HTTPS.");
    return structuredClone(value);
  }
  if (value.kind === "upload" && Object.keys(value).every((key) => ["kind", "artifactId"].includes(key))) { assertResourceId(value.artifactId, "art"); return structuredClone(value); }
  if (value.kind === "snapshot" && Object.keys(value).every((key) => ["kind", "snapshotId"].includes(key))) { assertResourceId(value.snapshotId, "snp"); return structuredClone(value); }
  throw new ResourceError("WORKSPACE_SOURCE_INVALID", "Workspace source is invalid.");
}

export class ResourceRepository {
  public constructor(private readonly pool: Pool, private readonly content: ContentStore) {}

  public async serializeWorkspace<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    assertResourceId(workspaceId, "wsp"); const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [workspaceId]);
      return await operation();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [workspaceId]).catch(() => undefined);
      client.release();
    }
  }

  public async list(identity: ExecutionIdentity): Promise<ResourceRef[]> {
    return (await this.pool.query<ResourceRef>(`SELECT ${resourceColumns} FROM harness_resources WHERE owner_key=$1 ORDER BY updated_at DESC,id`, [ownerKey(identity)])).rows;
  }

  public async appendEvent(identity: ExecutionIdentity, input: {
    eventType: string; sessionId?: string; runId?: string; requestId?: string;
    resourceId?: string; payload: JsonValue;
  }): Promise<number> {
    if (!/^[a-z][a-z0-9_.-]{1,79}$/u.test(input.eventType)) throw new ResourceError("RESOURCE_EVENT_INVALID", "Resource event type is invalid.");
    const row = (await this.pool.query<{ sequence: string }>(`INSERT INTO harness_resource_events
      (owner_key,session_id,run_id,request_id,resource_id,event_type,payload)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING sequence`, [ownerKey(identity), input.sessionId ?? null,
      input.runId ?? null, input.requestId ?? null, input.resourceId ?? null, input.eventType, JSON.stringify(input.payload)])).rows[0];
    if (!row) throw new ResourceError("RESOURCE_EVENT_FAILED", "Resource event could not be persisted.", 503);
    return Number(row.sequence);
  }

  public async attached(identity: ExecutionIdentity, sessionId: string): Promise<ResourceRef[]> {
    return (await this.pool.query<ResourceRef>(`SELECT ${resourceColumns.replaceAll(/\b(?:id|kind|title|version|capabilities|created_at|updated_at)\b/gu, token => `r.${token}`)}
      FROM harness_resources r JOIN harness_session_resources s ON s.resource_id=r.id
      WHERE s.owner_key=$1 AND s.session_id=$2 ORDER BY s.attached_at,r.id`, [ownerKey(identity), sessionId])).rows;
  }

  public async attach(identity: ExecutionIdentity, sessionId: string, resourceId: string): Promise<void> {
    await this.get(identity, resourceId);
    await this.pool.query(`INSERT INTO harness_session_resources(owner_key,session_id,resource_id) VALUES($1,$2,$3)
      ON CONFLICT(owner_key,session_id,resource_id) DO NOTHING`, [ownerKey(identity), sessionId, resourceId]);
  }

  public async detach(identity: ExecutionIdentity, sessionId: string, resourceId: string): Promise<void> {
    const result = await this.pool.query("DELETE FROM harness_session_resources WHERE owner_key=$1 AND session_id=$2 AND resource_id=$3", [ownerKey(identity), sessionId, resourceId]);
    if (!result.rowCount) throw new ResourceError("RESOURCE_NOT_ATTACHED", "Resource is not attached to this session.", 404);
  }

  public async resolveBindings(identity: ExecutionIdentity, sessionId: string, resourceIds: readonly string[]): Promise<ResolvedResourceBinding[]> {
    if (resourceIds.length > 16 || new Set(resourceIds).size !== resourceIds.length) throw new ResourceError("RESOURCE_BINDINGS_INVALID", "Deployment resource bindings are invalid.", 422);
    const result: ResolvedResourceBinding[] = [];
    for (const resourceId of resourceIds) {
      await this.authorizeAttached(identity, sessionId, resourceId);
      const row = (await this.pool.query<ResolvedResourceBinding>(`SELECT b.resource_id AS "resourceId",b.host_path AS "hostPath",
        b.target_path AS "targetPath",b.read_only AS "readOnly" FROM harness_runtime_bindings b
        JOIN harness_resources r ON r.id=b.resource_id WHERE b.resource_id=$1 AND r.owner_key=$2`, [resourceId, ownerKey(identity)])).rows[0];
      if (!row) throw new ResourceError("RESOURCE_BINDING_UNAVAILABLE", "Attached resource does not provide a runtime binding.", 422);
      result.push(row);
    }
    return result;
  }

  public async get(identity: ExecutionIdentity, resourceId: string, db: Pool | PoolClient = this.pool): Promise<ResourceRef> {
    assertResourceId(resourceId);
    const row = (await db.query<ResourceRef>(`SELECT ${resourceColumns} FROM harness_resources WHERE id=$1 AND owner_key=$2`, [resourceId, ownerKey(identity)])).rows[0];
    if (!row) throw new ResourceError("RESOURCE_NOT_FOUND", "Resource does not exist or is not available to this account.", 404);
    return row;
  }

  public async authorizeAttached(identity: ExecutionIdentity, sessionId: string, resourceId: string): Promise<void> {
    await this.get(identity, resourceId);
    const row = await this.pool.query("SELECT 1 FROM harness_session_resources WHERE owner_key=$1 AND session_id=$2 AND resource_id=$3", [ownerKey(identity), sessionId, resourceId]);
    if (!row.rowCount) throw new ResourceError("RESOURCE_NOT_ATTACHED", "Attach the resource to this session before using it.", 403);
  }

  public async createWorkspace(identity: ExecutionIdentity, input: { title: string; source: WorkspaceSource; runtime: RuntimeSpec }): Promise<Workspace> {
    if (!input.title.trim() || input.title.length > 120) throw new ResourceError("WORKSPACE_TITLE_INVALID", "Workspace title is invalid.");
    const workspaceId = id("wsp"); const spec = runtime(input.runtime); const workspaceSource = source(input.source); const key = ownerKey(identity);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO harness_resources(id,owner_key,kind,title,capabilities) VALUES($1,$2,'workspace',$3,$4)`,
        [workspaceId, key, input.title.trim(), JSON.stringify(["file", "git", "process", "artifact"])]);
      await client.query("INSERT INTO harness_workspaces(resource_id,source,runtime) VALUES($1,$2,$3)", [workspaceId, JSON.stringify(workspaceSource), JSON.stringify(spec)]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    return this.workspace(identity, workspaceId);
  }

  public async workspace(identity: ExecutionIdentity, workspaceId: string, db: Pool | PoolClient = this.pool): Promise<Workspace> {
    assertResourceId(workspaceId, "wsp");
    const row = (await db.query<Workspace>(`SELECT ${workspaceColumns} FROM harness_resources r JOIN harness_workspaces w ON w.resource_id=r.id
      WHERE r.id=$1 AND r.owner_key=$2`, [workspaceId, ownerKey(identity)])).rows[0];
    if (!row) throw new ResourceError("WORKSPACE_NOT_FOUND", "Workspace does not exist or is not available to this account.", 404);
    return row;
  }

  public async setWorkspaceState(identity: ExecutionIdentity, workspaceId: string, state: Workspace["state"], error?: string): Promise<Workspace> {
    await this.workspace(identity, workspaceId);
    await this.pool.query(`UPDATE harness_workspaces SET state=$1,error=$2 WHERE resource_id=$3`, [state, error?.slice(0, 1000) ?? null, workspaceId]);
    await this.pool.query("UPDATE harness_resources SET version=version+1,updated_at=now() WHERE id=$1", [workspaceId]);
    return this.workspace(identity, workspaceId);
  }

  public async setWorkspaceRuntime(identity: ExecutionIdentity, workspaceId: string, value: RuntimeSpec): Promise<Workspace> {
    await this.workspace(identity, workspaceId); const spec = runtime(value);
    await this.pool.query("UPDATE harness_workspaces SET runtime=$1 WHERE resource_id=$2", [JSON.stringify(spec), workspaceId]);
    await this.pool.query("UPDATE harness_resources SET version=version+1,updated_at=now() WHERE id=$1", [workspaceId]);
    return this.workspace(identity, workspaceId);
  }

  public async snapshot(identity: ExecutionIdentity, workspaceId: string, entries: readonly SnapshotInputEntry[]): Promise<WorkspaceSnapshot> {
    const workspace = await this.workspace(identity, workspaceId);
    if (workspace.state !== "ready" && workspace.state !== "creating") throw new ResourceError("WORKSPACE_NOT_READY", "Workspace is not ready for snapshots.", 409);
    if (entries.length > 100_000) throw new ResourceError("WORKSPACE_ENTRY_LIMIT", "Workspace contains too many entries.", 413);
    const seen = new Set<string>(); const manifest: WorkspaceEntry[] = []; let total = 0;
    for (const input of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
      const normalized = input.path.replaceAll("\\", "/"); safeEntryPath(normalized);
      if (seen.has(normalized)) throw new ResourceError("WORKSPACE_ENTRY_DUPLICATE", "Workspace snapshot contains a duplicate path.");
      seen.add(normalized); const mode = input.mode ?? 0o644;
      if (input.symlinkTarget !== undefined) {
        safeSymlink(normalized, input.symlinkTarget);
        manifest.push({ path: normalized, kind: "symlink", mode, size: Buffer.byteLength(input.symlinkTarget), target: input.symlinkTarget });
        continue;
      }
      if (input.content === undefined) throw new ResourceError("WORKSPACE_ENTRY_INVALID", "File content is required.");
      total += input.content.byteLength;
      if (total > 2 * 1024 * 1024 * 1024) throw new ResourceError("WORKSPACE_SNAPSHOT_LIMIT", "Workspace snapshot exceeds 2 GiB.", 413);
      const blob = await this.content.put(input.content);
      manifest.push({ path: normalized, kind: "file", mode, size: blob.size, blobHash: blob.digest });
    }
    return this.recordSnapshot(identity, workspaceId, manifest);
  }

  public async recordSnapshot(identity: ExecutionIdentity, workspaceId: string, manifestInput: readonly WorkspaceEntry[]): Promise<WorkspaceSnapshot> {
    const workspace = await this.workspace(identity, workspaceId);
    const manifest = [...manifestInput].sort((left, right) => left.path.localeCompare(right.path));
    if (manifest.length > 100_000) throw new ResourceError("WORKSPACE_ENTRY_LIMIT", "Workspace contains too many entries.", 413);
    const seen = new Set<string>(); let total = 0;
    for (const entry of manifest) {
      safeEntryPath(entry.path);
      if (seen.has(entry.path)) throw new ResourceError("WORKSPACE_ENTRY_DUPLICATE", "Workspace snapshot contains a duplicate path.");
      seen.add(entry.path); total += entry.size;
      if (entry.kind === "file") {
        if (!await this.content.has(entry.blobHash)) throw new ResourceError("CONTENT_BLOB_MISSING", "Snapshot references missing content.", 409);
      } else safeSymlink(entry.path, entry.target);
    }
    if (total > 2 * 1024 * 1024 * 1024) throw new ResourceError("WORKSPACE_SNAPSHOT_LIMIT", "Workspace snapshot exceeds 2 GiB.", 413);
    const digest = `sha256:${createHash("sha256").update(canonical(manifest)).digest("hex")}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = (await client.query<WorkspaceSnapshot>(`SELECT id,workspace_id AS "workspaceId",parent_snapshot_id AS "parentSnapshotId",digest,manifest AS entries,created_at AS "createdAt"
        FROM harness_workspace_snapshots WHERE workspace_id=$1 AND digest=$2`, [workspaceId, digest])).rows[0];
      if (existing) { await client.query("ROLLBACK"); return existing; }
      const snapshotId = id("snp");
      await client.query(`INSERT INTO harness_workspace_snapshots(id,workspace_id,parent_snapshot_id,digest,manifest)
        VALUES($1,$2,$3,$4,$5)`, [snapshotId, workspaceId, workspace.activeSnapshotId, digest, JSON.stringify(manifest)]);
      await client.query("UPDATE harness_workspaces SET active_snapshot_id=$1,state='ready',error=NULL WHERE resource_id=$2", [snapshotId, workspaceId]);
      await client.query("UPDATE harness_resources SET version=version+1,updated_at=now() WHERE id=$1", [workspaceId]);
      await client.query("COMMIT");
      return { id: snapshotId, workspaceId, parentSnapshotId: workspace.activeSnapshotId, digest, entries: manifest, createdAt: new Date().toISOString() };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  public async snapshots(identity: ExecutionIdentity, workspaceId: string): Promise<WorkspaceSnapshot[]> {
    await this.workspace(identity, workspaceId);
    return (await this.pool.query<WorkspaceSnapshot>(`SELECT id,workspace_id AS "workspaceId",parent_snapshot_id AS "parentSnapshotId",digest,manifest AS entries,created_at AS "createdAt"
      FROM harness_workspace_snapshots WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100`, [workspaceId])).rows;
  }

  public async snapshotById(identity: ExecutionIdentity, workspaceId: string, snapshotId: string): Promise<WorkspaceSnapshot> {
    assertResourceId(snapshotId, "snp"); await this.workspace(identity, workspaceId);
    const row = (await this.pool.query<WorkspaceSnapshot>(`SELECT id,workspace_id AS "workspaceId",parent_snapshot_id AS "parentSnapshotId",digest,manifest AS entries,created_at AS "createdAt"
      FROM harness_workspace_snapshots WHERE id=$1 AND workspace_id=$2`, [snapshotId, workspaceId])).rows[0];
    if (!row) throw new ResourceError("SNAPSHOT_NOT_FOUND", "Snapshot does not belong to this workspace.", 404);
    return row;
  }

  public async snapshotOwned(identity: ExecutionIdentity, snapshotId: string): Promise<WorkspaceSnapshot> {
    assertResourceId(snapshotId, "snp");
    const row = (await this.pool.query<WorkspaceSnapshot>(`SELECT s.id,s.workspace_id AS "workspaceId",s.parent_snapshot_id AS "parentSnapshotId",
      s.digest,s.manifest AS entries,s.created_at AS "createdAt" FROM harness_workspace_snapshots s
      JOIN harness_resources r ON r.id=s.workspace_id WHERE s.id=$1 AND r.owner_key=$2`, [snapshotId, ownerKey(identity)])).rows[0];
    if (!row) throw new ResourceError("SNAPSHOT_NOT_FOUND", "Snapshot does not exist or is not available to this account.", 404);
    return row;
  }

  public async restore(identity: ExecutionIdentity, workspaceId: string, snapshotId: string): Promise<Workspace> {
    assertResourceId(snapshotId, "snp"); await this.workspace(identity, workspaceId);
    const row = await this.pool.query("SELECT 1 FROM harness_workspace_snapshots WHERE id=$1 AND workspace_id=$2", [snapshotId, workspaceId]);
    if (!row.rowCount) throw new ResourceError("SNAPSHOT_NOT_FOUND", "Snapshot does not belong to this workspace.", 404);
    await this.pool.query("UPDATE harness_workspaces SET active_snapshot_id=$1,state='ready',error=NULL WHERE resource_id=$2", [snapshotId, workspaceId]);
    await this.pool.query("UPDATE harness_resources SET version=version+1,updated_at=now() WHERE id=$1", [workspaceId]);
    return this.workspace(identity, workspaceId);
  }

  public async createArtifact(identity: ExecutionIdentity, input: { workspaceId: string; snapshotId?: string; title: string; mediaType: string; content: Uint8Array; metadata?: JsonValue }): Promise<Artifact> {
    await this.workspace(identity, input.workspaceId); const blob = await this.content.put(input.content); const artifactId = id("art");
    const key = ownerKey(identity);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO harness_resources(id,owner_key,kind,title,capabilities) VALUES($1,$2,'artifact',$3,'["read"]')`, [artifactId, key, input.title.slice(0, 120)]);
      await client.query(`INSERT INTO harness_artifacts(resource_id,workspace_id,snapshot_id,media_type,size_bytes,blob_hash,metadata)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [artifactId, input.workspaceId, input.snapshotId ?? null, input.mediaType, blob.size, blob.digest, JSON.stringify(input.metadata ?? {})]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    const resource = await this.get(identity, artifactId);
    return { ...resource, kind: "artifact", workspaceId: input.workspaceId, snapshotId: input.snapshotId ?? null, mediaType: input.mediaType, size: blob.size, blobHash: blob.digest, metadata: input.metadata ?? {} };
  }

  public async artifact(identity: ExecutionIdentity, artifactId: string): Promise<Artifact> {
    assertResourceId(artifactId, "art");
    const row = (await this.pool.query<Artifact>(`SELECT ${resourceColumns},a.workspace_id AS "workspaceId",a.snapshot_id AS "snapshotId",
      a.media_type AS "mediaType",a.size_bytes AS size,a.blob_hash AS "blobHash",a.metadata
      FROM harness_resources r JOIN harness_artifacts a ON a.resource_id=r.id WHERE r.id=$1 AND r.owner_key=$2`, [artifactId, ownerKey(identity)])).rows[0];
    if (!row) throw new ResourceError("ARTIFACT_NOT_FOUND", "Artifact does not exist or is not available to this account.", 404);
    return row;
  }

  public async artifactContent(identity: ExecutionIdentity, artifactId: string, maximumBytes: number): Promise<{ artifact: Artifact; content: Buffer }> {
    const artifact = await this.artifact(identity, artifactId);
    return { artifact, content: await this.content.read(artifact.blobHash, maximumBytes) };
  }

  public async artifacts(identity: ExecutionIdentity, workspaceId: string): Promise<Artifact[]> {
    await this.workspace(identity, workspaceId);
    return (await this.pool.query<Artifact>(`SELECT ${resourceColumns},a.workspace_id AS "workspaceId",a.snapshot_id AS "snapshotId",
      a.media_type AS "mediaType",a.size_bytes AS size,a.blob_hash AS "blobHash",a.metadata
      FROM harness_resources r JOIN harness_artifacts a ON a.resource_id=r.id
      WHERE r.owner_key=$1 AND a.workspace_id=$2 ORDER BY r.created_at DESC,r.id DESC LIMIT 100`, [ownerKey(identity), workspaceId])).rows;
  }

  public async createDeployment(identity: ExecutionIdentity, input: { workspaceId: string; artifactId: string; operationId: string; endpoint?: string; previousDeploymentId?: string }): Promise<Deployment> {
    await this.workspace(identity, input.workspaceId); const artifact = await this.artifact(identity, input.artifactId);
    if (artifact.workspaceId !== input.workspaceId) throw new ResourceError("ARTIFACT_WORKSPACE_MISMATCH", "Deployment artifact belongs to another workspace.", 403);
    const deploymentId = id("dep"); const key = ownerKey(identity); const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO harness_resources(id,owner_key,kind,title,capabilities) VALUES($1,$2,'deployment',$3,'["status","rollback"]')`, [deploymentId, key, `Deployment ${deploymentId.slice(4, 12)}`]);
      await client.query(`INSERT INTO harness_deployments(resource_id,workspace_id,artifact_id,status,endpoint,previous_deployment_id,operation_id)
        VALUES($1,$2,$3,'queued',$4,$5,$6)`, [deploymentId, input.workspaceId, input.artifactId, input.endpoint ?? null, input.previousDeploymentId ?? null, input.operationId]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    const resource = await this.get(identity, deploymentId);
    return { ...resource, kind: "deployment", workspaceId: input.workspaceId, artifactId: input.artifactId, status: "queued", endpoint: input.endpoint ?? null, previousDeploymentId: input.previousDeploymentId ?? null };
  }

  public async deployment(identity: ExecutionIdentity, deploymentId: string): Promise<Deployment> {
    assertResourceId(deploymentId, "dep");
    const row = (await this.pool.query<Deployment>(`SELECT ${resourceColumns},d.workspace_id AS "workspaceId",d.artifact_id AS "artifactId",
      d.status,d.endpoint,d.previous_deployment_id AS "previousDeploymentId"
      FROM harness_resources r JOIN harness_deployments d ON d.resource_id=r.id WHERE r.id=$1 AND r.owner_key=$2`, [deploymentId, ownerKey(identity)])).rows[0];
    if (!row) throw new ResourceError("DEPLOYMENT_NOT_FOUND", "Deployment does not exist or is not available to this account.", 404);
    return row;
  }

  public async setDeploymentStatus(identity: ExecutionIdentity, deploymentId: string, status: Deployment["status"], endpoint?: string): Promise<Deployment> {
    await this.deployment(identity, deploymentId);
    await this.pool.query("UPDATE harness_deployments SET status=$1,endpoint=COALESCE($2,endpoint) WHERE resource_id=$3", [status, endpoint ?? null, deploymentId]);
    await this.pool.query("UPDATE harness_resources SET version=version+1,updated_at=now() WHERE id=$1", [deploymentId]);
    return this.deployment(identity, deploymentId);
  }

  public async deployments(identity: ExecutionIdentity, workspaceId: string): Promise<Deployment[]> {
    await this.workspace(identity, workspaceId);
    return (await this.pool.query<Deployment>(`SELECT ${resourceColumns},d.workspace_id AS "workspaceId",d.artifact_id AS "artifactId",
      d.status,d.endpoint,d.previous_deployment_id AS "previousDeploymentId"
      FROM harness_resources r JOIN harness_deployments d ON d.resource_id=r.id
      WHERE r.owner_key=$1 AND d.workspace_id=$2 ORDER BY r.created_at DESC,r.id DESC LIMIT 100`,
      [ownerKey(identity), workspaceId])).rows;
  }

  public async deploymentByOperation(identity: ExecutionIdentity, workspaceId: string, operationId: string): Promise<Deployment | null> {
    await this.workspace(identity, workspaceId);
    const row = (await this.pool.query<Deployment>(`SELECT ${resourceColumns},d.workspace_id AS "workspaceId",d.artifact_id AS "artifactId",
      d.status,d.endpoint,d.previous_deployment_id AS "previousDeploymentId"
      FROM harness_resources r JOIN harness_deployments d ON d.resource_id=r.id
      WHERE r.owner_key=$1 AND d.workspace_id=$2 AND d.operation_id=$3`, [ownerKey(identity), workspaceId, operationId])).rows[0];
    return row ?? null;
  }

  public async claimDeploymentEndpoint(identity: ExecutionIdentity, workspaceId: string, endpoint: string): Promise<void> {
    await this.workspace(identity, workspaceId); const key = ownerKey(identity);
    await this.pool.query(`INSERT INTO harness_deployment_endpoints(endpoint,owner_key,workspace_id) VALUES($1,$2,$3)
      ON CONFLICT(endpoint) DO NOTHING`, [endpoint, key, workspaceId]);
    const claim = (await this.pool.query<{ ownerKey: string; workspaceId: string }>(`SELECT owner_key AS "ownerKey",workspace_id AS "workspaceId"
      FROM harness_deployment_endpoints WHERE endpoint=$1`, [endpoint])).rows[0];
    if (!claim || claim.ownerKey !== key || claim.workspaceId !== workspaceId) {
      throw new ResourceError("DEPLOYMENT_ENDPOINT_UNAVAILABLE", "Deployment endpoint is already assigned to another workspace.", 409);
    }
  }

  public async pendingDeployments(): Promise<Array<{ id: string; previousDeploymentId: string | null }>> {
    return (await this.pool.query<{ id: string; previousDeploymentId: string | null }>(`SELECT resource_id AS id,
      previous_deployment_id AS "previousDeploymentId" FROM harness_deployments WHERE status IN ('queued','starting') ORDER BY resource_id`)).rows;
  }

  public async failPendingDeployment(deploymentId: string): Promise<void> {
    assertResourceId(deploymentId, "dep");
    await this.pool.query("UPDATE harness_deployments SET status='failed' WHERE resource_id=$1 AND status IN ('queued','starting')", [deploymentId]);
    await this.pool.query("UPDATE harness_resources SET version=version+1,updated_at=now() WHERE id=$1", [deploymentId]);
  }

  public async healthyDeploymentAt(identity: ExecutionIdentity, endpoint: string): Promise<Deployment | null> {
    const row = (await this.pool.query<Deployment>(`SELECT ${resourceColumns},d.workspace_id AS "workspaceId",d.artifact_id AS "artifactId",
      d.status,d.endpoint,d.previous_deployment_id AS "previousDeploymentId"
      FROM harness_resources r JOIN harness_deployments d ON d.resource_id=r.id
      WHERE r.owner_key=$1 AND d.endpoint=$2 AND d.status='healthy' ORDER BY r.updated_at DESC LIMIT 1`,
    [ownerKey(identity), endpoint])).rows[0];
    return row ?? null;
  }

  public async activateDeployment(identity: ExecutionIdentity, deploymentId: string, previousDeploymentId?: string): Promise<Deployment> {
    const deployment = await this.deployment(identity, deploymentId); const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (previousDeploymentId) {
        const previous = await this.deployment(identity, previousDeploymentId);
        if (previous.endpoint !== deployment.endpoint) throw new ResourceError("DEPLOYMENT_ROUTE_MISMATCH", "Previous deployment uses a different endpoint.", 409);
        await client.query("UPDATE harness_deployments SET status='rolled_back' WHERE resource_id=$1", [previousDeploymentId]);
        await client.query("UPDATE harness_resources SET version=version+1,updated_at=now() WHERE id=$1", [previousDeploymentId]);
      }
      await client.query("UPDATE harness_deployments SET status='healthy',previous_deployment_id=$1 WHERE resource_id=$2", [previousDeploymentId ?? null, deploymentId]);
      await client.query("UPDATE harness_resources SET version=version+1,updated_at=now() WHERE id=$1", [deploymentId]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    return this.deployment(identity, deploymentId);
  }

  public async activateRollback(identity: ExecutionIdentity, deploymentId: string, targetDeploymentId: string): Promise<Deployment> {
    const deployment = await this.deployment(identity, deploymentId); const target = await this.deployment(identity, targetDeploymentId);
    if (deployment.endpoint !== target.endpoint || deployment.workspaceId !== target.workspaceId) {
      throw new ResourceError("DEPLOYMENT_ROLLBACK_MISMATCH", "Rollback target does not belong to the same workspace route.", 409);
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE harness_deployments SET status='rolled_back' WHERE resource_id=$1", [deploymentId]);
      await client.query("UPDATE harness_deployments SET status='healthy' WHERE resource_id=$1", [targetDeploymentId]);
      await client.query("UPDATE harness_resources SET version=version+1,updated_at=now() WHERE id=ANY($1::text[])", [[deploymentId, targetDeploymentId]]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    return this.deployment(identity, targetDeploymentId);
  }

  public async networkActivity(identity: ExecutionIdentity, workspaceId: string): Promise<Array<Record<string, unknown>>> {
    await this.workspace(identity, workspaceId);
    return (await this.pool.query<Record<string, unknown>>(`SELECT id,run_id AS "runId",process_id AS "processId",hostname,port,method,
      bytes_sent AS "bytesSent",bytes_received AS "bytesReceived",decision,reason,occurred_at AS "occurredAt"
      FROM harness_network_audit WHERE owner_key=$1 AND workspace_id=$2 ORDER BY id DESC LIMIT 200`,
      [ownerKey(identity), workspaceId])).rows;
  }

  public async events(identity: ExecutionIdentity, workspaceId: string): Promise<Array<Record<string, unknown>>> {
    await this.workspace(identity, workspaceId);
    return (await this.pool.query<Record<string, unknown>>(`SELECT sequence,session_id AS "sessionId",run_id AS "runId",request_id AS "requestId",
      event_type AS "eventType",payload,occurred_at AS "occurredAt" FROM harness_resource_events
      WHERE owner_key=$1 AND resource_id=$2 ORDER BY sequence DESC LIMIT 500`, [ownerKey(identity), workspaceId])).rows;
  }

  public async recordProcess(identity: ExecutionIdentity, input: {
    id: string; workspaceId: string; runId: string; executable: string; args: readonly string[];
    cwd: string; mode: "foreground" | "background" | "pty"; timeoutAt?: string;
  }): Promise<ProcessSession> {
    assertResourceId(input.id, "prc");
    await this.workspace(identity, input.workspaceId);
    await this.pool.query(`INSERT INTO harness_process_sessions
      (id,owner_key,workspace_id,run_id,executable,args,cwd,mode,status,timeout_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'running',$9) ON CONFLICT(id) DO NOTHING`,
      [input.id, ownerKey(identity), input.workspaceId, input.runId, input.executable,
        JSON.stringify(input.args), input.cwd, input.mode, input.timeoutAt ?? null]);
    return this.process(identity, input.workspaceId, input.id);
  }

  public async process(identity: ExecutionIdentity, workspaceId: string, processId: string): Promise<ProcessSession> {
    assertResourceId(processId, "prc");
    await this.workspace(identity, workspaceId);
    const row = (await this.pool.query<ProcessSession>(`SELECT id,workspace_id AS "workspaceId",run_id AS "runId",
      executable,args,cwd,mode,status,exit_code AS "exitCode",output_cursor AS "outputCursor",
      started_at AS "startedAt",timeout_at AS "timeoutAt",finished_at AS "finishedAt"
      FROM harness_process_sessions WHERE id=$1 AND workspace_id=$2 AND owner_key=$3`,
      [processId, workspaceId, ownerKey(identity)])).rows[0];
    if (!row) throw new ResourceError("PROCESS_NOT_FOUND", "Process is not available in this workspace.", 404);
    return row;
  }

  public async updateProcess(identity: ExecutionIdentity, workspaceId: string, processId: string, input: {
    status?: ProcessSession["status"]; exitCode?: number | null; outputCursor?: number;
  }): Promise<ProcessSession> {
    await this.process(identity, workspaceId, processId);
    await this.pool.query(`UPDATE harness_process_sessions SET
      status=COALESCE($1,status),exit_code=CASE WHEN $2::boolean THEN $3 ELSE exit_code END,
      output_cursor=GREATEST(output_cursor,COALESCE($4,output_cursor)),
      finished_at=CASE WHEN $1 IN ('exited','failed','cancelled','timed_out','interrupted')
        THEN COALESCE(finished_at,now()) ELSE finished_at END
      WHERE id=$5 AND workspace_id=$6 AND owner_key=$7`, [input.status ?? null,
      input.exitCode !== undefined, input.exitCode ?? null, input.outputCursor ?? null,
      processId, workspaceId, ownerKey(identity)]);
    return this.process(identity, workspaceId, processId);
  }

  public async processes(identity: ExecutionIdentity, workspaceId: string): Promise<ProcessSession[]> {
    await this.workspace(identity, workspaceId);
    return (await this.pool.query<ProcessSession>(`SELECT id,workspace_id AS "workspaceId",run_id AS "runId",
      executable,args,cwd,mode,status,exit_code AS "exitCode",output_cursor AS "outputCursor",
      started_at AS "startedAt",timeout_at AS "timeoutAt",finished_at AS "finishedAt"
      FROM harness_process_sessions WHERE workspace_id=$1 AND owner_key=$2
      ORDER BY started_at DESC,id DESC LIMIT 100`, [workspaceId, ownerKey(identity)])).rows;
  }

  public async runningProcessesForRun(identity: ExecutionIdentity, runId: string): Promise<ProcessSession[]> {
    return (await this.pool.query<ProcessSession>(`SELECT id,workspace_id AS "workspaceId",run_id AS "runId",
      executable,args,cwd,mode,status,exit_code AS "exitCode",output_cursor AS "outputCursor",
      started_at AS "startedAt",timeout_at AS "timeoutAt",finished_at AS "finishedAt" FROM harness_process_sessions
      WHERE owner_key=$1 AND run_id=$2 AND status IN ('starting','running') ORDER BY started_at,id`,
      [ownerKey(identity), runId])).rows;
  }
}
