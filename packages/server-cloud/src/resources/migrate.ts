import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Pool } from "pg";
import type { DeploymentSpec, RuntimeSpec, WorkspaceEntry } from "@daoyin/harness-contracts";
import { FileContentStore } from "./content-store.js";
import { unixJson } from "../projects/wire.js";
import type { DeploymentWorkerRequest, ExecutorProcessRequest, ResolvedResourceBinding } from "./contracts.js";

type LegacyFile = { path: string; content: string };
type LegacyProject = { id: string; owner_key: string; title: string; slug: string; active_version: string | null; created_at: Date; updated_at: Date };
type LegacyVersion = { id: string; revision: number; digest: string; files: LegacyFile[]; created_at: Date };

const databaseUrl = process.env.HARNESS_RESOURCES_DATABASE_URL ?? "";
const contentRoot = process.env.HARNESS_CONTENT_STORE_ROOT ?? "";
const command = process.argv[2] ?? "--plan";
if (!databaseUrl || !contentRoot) throw new Error("HARNESS_RESOURCES_DATABASE_URL and HARNESS_CONTENT_STORE_ROOT are required.");
if (!["--schema", "--plan", "--apply", "--verify", "--stage-deployments"].includes(command)) throw new Error("Use --schema, --plan, --apply, --verify or --stage-deployments.");
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const content = await FileContentStore.open(contentRoot);
const legacyArtifactRoot = path.resolve(process.env.HARNESS_LEGACY_PROJECT_ARTIFACT_ROOT ?? "/var/lib/daoyin-projects/artifacts");

const deterministicId = (prefix: string, kind: string, legacyId: string): string => `${prefix}_${createHash("sha256").update(`${kind}\0${legacyId}`).digest("hex").slice(0, 24)}`;
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value !== null && typeof value === "object" ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
    : JSON.stringify(value) ?? "null";
const digestOf = (manifest: readonly WorkspaceEntry[]): string => `sha256:${createHash("sha256").update(canonical(manifest)).digest("hex")}`;

async function schema(): Promise<void> {
  const schemaPath = process.env.HARNESS_RESOURCES_SCHEMA ?? fileURLToPath(new URL("./schema.sql", import.meta.url));
  await pool.query(await readFile(schemaPath, "utf8"));
}

async function legacyCounts(): Promise<Record<string, number>> {
  const names = ["harness_projects", "harness_project_versions", "harness_project_sessions", "harness_project_deployments", "harness_project_concepts"];
  const result: Record<string, number> = {};
  for (const name of names) result[name] = Number((await pool.query<{ count: string }>(`SELECT count(*) AS count FROM ${name}`)).rows[0]?.count ?? 0);
  return result;
}

async function manifest(files: readonly LegacyFile[]): Promise<WorkspaceEntry[]> {
  const entries: WorkspaceEntry[] = [];
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    const data = Buffer.from(file.content, "utf8"); const blob = await content.put(data);
    entries.push({ path: file.path.replaceAll("\\", "/"), kind: "file", mode: 0o644, size: data.byteLength, blobHash: blob.digest });
  }
  return entries;
}

async function legacyBuildManifest(projectId: string, versionId: string): Promise<WorkspaceEntry[] | null> {
  const root = path.join(legacyArtifactRoot, projectId, versionId);
  try {
    if (!(await lstat(root)).isDirectory()) return null;
    const markers = [`${root}.complete`, path.join(root, ".complete")]; let complete = false;
    for (const marker of markers) try { if ((await lstat(marker)).isFile()) complete = true; } catch { /* Try the other historical marker layout. */ }
    if (!complete) return null;
  } catch { return null; }
  const entries: WorkspaceEntry[] = []; let count = 0; let total = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      if (directory === root && name === ".complete") continue;
      const absolute = path.join(directory, name); const info = await lstat(absolute);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) || (info.isFile() && info.nlink !== 1)) throw new Error(`Unsafe legacy build artifact: ${projectId}/${versionId}`);
      if (info.isDirectory()) { await walk(absolute); continue; }
      if (++count > 10_000 || (total += info.size) > 20 * 1024 * 1024) throw new Error(`Legacy build artifact exceeds migration limits: ${projectId}/${versionId}`);
      const data = await readFile(absolute); const blob = await content.put(data); const relative = path.relative(root, absolute).split(path.sep).join("/");
      entries.push({ path: `dist/${relative}`, kind: "file", mode: 0o644, size: data.byteLength, blobHash: blob.digest });
    }
  };
  await walk(root); const sorted = entries.sort((left, right) => left.path.localeCompare(right.path));
  return sorted.length ? sorted : null;
}
function expectedManifest(files: readonly LegacyFile[]): WorkspaceEntry[] {
  return [...files].sort((left, right) => left.path.localeCompare(right.path)).map((file) => {
    const data = Buffer.from(file.content, "utf8");
    return { path: file.path.replaceAll("\\", "/"), kind: "file" as const, mode: 0o644, size: data.byteLength,
      blobHash: `sha256:${createHash("sha256").update(data).digest("hex")}` };
  });
}

function runtime(): RuntimeSpec {
  const id = process.env.HARNESS_MIGRATION_RUNTIME_IMAGE_ID ?? "";
  const digest = process.env.HARNESS_MIGRATION_RUNTIME_IMAGE_DIGEST ?? "";
  if (!id || !/^sha256:[a-f0-9]{64}$/u.test(digest)) throw new Error("Set the signed migration runtime image id and digest before --apply.");
  return { image: { kind: "builtin", id, digest }, environment: {}, secretRefs: [], network: "public",
    limits: { cpu: 1, memoryMiB: 1536, pids: 256, diskMiB: 4096, timeoutSeconds: 600, maxOutputBytes: 1_000_000 } };
}

async function applyProject(project: LegacyProject, spec: RuntimeSpec): Promise<void> {
  const workspaceId = deterministicId("wsp", "project", project.id);
  const dataResourceId = deterministicId("res", "project-data", project.id);
  const currentFiles = (await pool.query<LegacyFile>("SELECT path,content FROM harness_project_files WHERE project_id=$1 ORDER BY path", [project.id])).rows;
  const versions = (await pool.query<LegacyVersion>(`SELECT id,revision,digest,files,created_at FROM harness_project_versions
    WHERE project_id=$1 ORDER BY revision,created_at,id`, [project.id])).rows;
  const currentManifest = await manifest(currentFiles); const currentDigest = digestOf(currentManifest);
  const currentSnapshotId = deterministicId("snp", "project-current", project.id);
  const preparedVersions: Array<{ version: LegacyVersion; id: string; manifest: WorkspaceEntry[]; digest: string; build: WorkspaceEntry[] | null }> = [];
  for (const version of versions) {
    const entries = await manifest(version.files); preparedVersions.push({ version, id: deterministicId("snp", "project-version", version.id), manifest: entries,
      digest: digestOf(entries), build: await legacyBuildManifest(project.id, version.id) });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO harness_resources(id,owner_key,kind,title,capabilities,created_at,updated_at)
      VALUES($1,$2,'workspace',$3,'["file","git","process","artifact"]',$4,$5) ON CONFLICT(id) DO NOTHING`,
      [workspaceId, project.owner_key, project.title, project.created_at, project.updated_at]);
    await client.query(`INSERT INTO harness_workspaces(resource_id,source,runtime,state)
      VALUES($1,$2,$3,'ready') ON CONFLICT(resource_id) DO NOTHING`, [workspaceId, JSON.stringify({ kind: "snapshot", snapshotId: currentSnapshotId }), JSON.stringify(spec)]);
    await client.query(`INSERT INTO harness_resources(id,owner_key,kind,title,capabilities,created_at,updated_at)
      VALUES($1,$2,'business',$3,'["bind"]',$4,$5) ON CONFLICT(id) DO NOTHING`,
    [dataResourceId, project.owner_key, `${project.title} data`, project.created_at, project.updated_at]);
    await client.query(`INSERT INTO harness_runtime_bindings(resource_id,host_path,target_path,read_only)
      VALUES($1,$2,'/run/broker',true) ON CONFLICT(resource_id) DO NOTHING`,
    [dataResourceId, `/run/daoyin-projects/brokers/${project.id}/production`]);
    await client.query(`INSERT INTO harness_resource_migrations(legacy_kind,legacy_id,resource_id,digest)
      VALUES('project_data',$1,$2,$3) ON CONFLICT(legacy_kind,legacy_id) DO UPDATE SET digest=EXCLUDED.digest`,
    [project.id, dataResourceId, `sha256:${createHash("sha256").update(`/run/daoyin-projects/brokers/${project.id}/production`).digest("hex")}`]);
    let parent: string | null = null;
    for (const item of preparedVersions) {
      await client.query(`INSERT INTO harness_workspace_snapshots(id,workspace_id,parent_snapshot_id,digest,manifest,created_at)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,digest) DO NOTHING`,
        [item.id, workspaceId, parent, item.digest, JSON.stringify(item.manifest), item.version.created_at]);
      const actual = (await client.query<{ id: string }>("SELECT id FROM harness_workspace_snapshots WHERE workspace_id=$1 AND digest=$2", [workspaceId, item.digest])).rows[0]?.id;
      if (!actual) throw new Error(`Version snapshot missing for ${item.version.id}`);
      item.id = actual; parent = actual;
    }
    await client.query(`INSERT INTO harness_workspace_snapshots(id,workspace_id,parent_snapshot_id,digest,manifest)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,digest) DO NOTHING`,
      [currentSnapshotId, workspaceId, parent, currentDigest, JSON.stringify(currentManifest)]);
    const actualCurrent = (await client.query<{ id: string }>("SELECT id FROM harness_workspace_snapshots WHERE workspace_id=$1 AND digest=$2", [workspaceId, currentDigest])).rows[0]?.id;
    if (!actualCurrent) throw new Error(`Current snapshot missing for ${project.id}`);
    await client.query("UPDATE harness_workspaces SET active_snapshot_id=$1,source=$2,state='ready',error=NULL WHERE resource_id=$3",
      [actualCurrent, JSON.stringify({ kind: "snapshot", snapshotId: actualCurrent }), workspaceId]);
    await client.query(`INSERT INTO harness_resource_migrations(legacy_kind,legacy_id,resource_id,digest)
      VALUES('project',$1,$2,$3) ON CONFLICT(legacy_kind,legacy_id) DO UPDATE SET digest=EXCLUDED.digest`,
      [project.id, workspaceId, currentDigest]);
    await client.query(`INSERT INTO harness_session_resources(owner_key,session_id,resource_id)
      SELECT owner_key,session_id,$1 FROM harness_project_sessions WHERE project_id=$2
      ON CONFLICT(owner_key,session_id,resource_id) DO NOTHING`, [workspaceId, project.id]);
    await client.query(`INSERT INTO harness_session_resources(owner_key,session_id,resource_id)
      SELECT owner_key,session_id,$1 FROM harness_project_sessions WHERE project_id=$2
      ON CONFLICT(owner_key,session_id,resource_id) DO NOTHING`, [dataResourceId, project.id]);

for (const item of preparedVersions) {
 const artifactId = deterministicId("art", "project-version", item.version.id);
 let artifactSnapshotId = item.id;
 if (item.build) {
      const merged = new Map(item.manifest.map(entry => [entry.path, entry]));
      for (const entry of item.build) merged.set(entry.path, entry);
      const deploymentManifest = [...merged.values()].sort((left, right) => left.path.localeCompare(right.path));
  const deploymentDigest = digestOf(deploymentManifest); const requested = deterministicId("snp", "project-deployment-version", item.version.id);
  await client.query(`INSERT INTO harness_workspace_snapshots(id,workspace_id,parent_snapshot_id,digest,manifest,created_at)
  VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,digest) DO NOTHING`,
  [requested, workspaceId, item.id, deploymentDigest, JSON.stringify(deploymentManifest), item.version.created_at]);
  artifactSnapshotId = (await client.query<{ id: string }>("SELECT id FROM harness_workspace_snapshots WHERE workspace_id=$1 AND digest=$2",
   [workspaceId, deploymentDigest])).rows[0]?.id ?? requested;
 }
 const body = Buffer.from(JSON.stringify({ workspaceId, snapshotId: artifactSnapshotId, digest: item.digest }), "utf8");
 const blob = await content.put(body);
 await client.query(`INSERT INTO harness_resources(id,owner_key,kind,title,capabilities,created_at)
 VALUES($1,$2,'artifact',$3,'["read"]',$4) ON CONFLICT(id) DO NOTHING`,
 [artifactId, project.owner_key, `${project.title} r${item.version.revision}`, item.version.created_at]);
 const deployment = item.build ? { version: 1, kind: "web-service", command: { executable: "/opt/node_modules/.bin/tsx", args: ["server.ts"], cwd: "." },
  transport: { kind: "unix", path: "/run/app/app.sock" }, health: { path: "/health", timeoutSeconds: 15 }, environment: {}, resourceIds: [dataResourceId] } : null;
 await client.query(`INSERT INTO harness_artifacts(resource_id,workspace_id,snapshot_id,media_type,size_bytes,blob_hash,metadata)
 VALUES($1,$2,$3,'application/vnd.daoyin.workspace-snapshot+json',$4,$5,$6) ON CONFLICT(resource_id) DO NOTHING`,
 [artifactId, workspaceId, artifactSnapshotId, blob.size, blob.digest, JSON.stringify({ legacyVersionId: item.version.id, legacyDigest: item.version.digest,
  ...(deployment ? { deployment } : { migrationBlocked: "legacy-build-artifact-missing" }) })]);
 await client.query(`INSERT INTO harness_resource_migrations(legacy_kind,legacy_id,resource_id,digest)
 VALUES('project_version',$1,$2,$3) ON CONFLICT(legacy_kind,legacy_id) DO UPDATE SET digest=EXCLUDED.digest`,
 [item.version.id, artifactId, item.digest]);
 }
    const concepts = (await client.query<{ id: string; direction: string; title: string; mime_type: string; content: Buffer; sha256: string | null; created_at: Date }>(
      `SELECT id,direction,title,mime_type,content,sha256,created_at FROM harness_project_concepts
       WHERE project_id=$1 AND status='completed' AND content IS NOT NULL AND mime_type IS NOT NULL ORDER BY created_at,id`, [project.id])).rows;
    for (const concept of concepts) {
      const artifactId = deterministicId("art", "project-concept", concept.id); const blob = await content.put(concept.content);
      await client.query(`INSERT INTO harness_resources(id,owner_key,kind,title,capabilities,created_at)
        VALUES($1,$2,'artifact',$3,'["read"]',$4) ON CONFLICT(id) DO NOTHING`,
        [artifactId, project.owner_key, concept.title, concept.created_at]);
      await client.query(`INSERT INTO harness_artifacts(resource_id,workspace_id,snapshot_id,media_type,size_bytes,blob_hash,metadata)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(resource_id) DO NOTHING`,
        [artifactId, workspaceId, actualCurrent, concept.mime_type, blob.size, blob.digest,
          JSON.stringify({ legacyConceptId: concept.id, direction: concept.direction, legacySha256: concept.sha256 })]);
      await client.query(`INSERT INTO harness_resource_migrations(legacy_kind,legacy_id,resource_id,digest)
        VALUES('project_concept',$1,$2,$3) ON CONFLICT(legacy_kind,legacy_id) DO UPDATE SET digest=EXCLUDED.digest`,
        [concept.id, artifactId, blob.digest]);
    }
    const deployments = (await client.query<{ id: string; version_id: string; operation_id: string; created_at: Date }>(
      "SELECT id,version_id,operation_id,created_at FROM harness_project_deployments WHERE project_id=$1 ORDER BY created_at,id", [project.id])).rows;
    const activeDeploymentId = [...deployments].reverse().find(item => item.version_id === project.active_version)?.id ?? null;
    let previous: string | null = null;
    for (const deployment of deployments) {
      const deploymentId = deterministicId("dep", "project-deployment", deployment.id);
      const artifactId = deterministicId("art", "project-version", deployment.version_id);
      await client.query(`INSERT INTO harness_resources(id,owner_key,kind,title,capabilities,created_at)
        VALUES($1,$2,'deployment',$3,'["status","rollback"]',$4) ON CONFLICT(id) DO NOTHING`,
        [deploymentId, project.owner_key, `${project.title} deployment`, deployment.created_at]);
      await client.query(`INSERT INTO harness_deployments(resource_id,workspace_id,artifact_id,status,endpoint,previous_deployment_id,operation_id)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(resource_id) DO UPDATE SET artifact_id=EXCLUDED.artifact_id,
        status=EXCLUDED.status,endpoint=EXCLUDED.endpoint,previous_deployment_id=EXCLUDED.previous_deployment_id,operation_id=EXCLUDED.operation_id`, [deploymentId, workspaceId, artifactId,
        deployment.id === activeDeploymentId ? "healthy" : "rolled_back", `https://${project.slug}.demo.daoyintech.com`, previous, deployment.operation_id]);
      await client.query(`INSERT INTO harness_deployment_endpoints(endpoint,owner_key,workspace_id)
        VALUES($1,$2,$3) ON CONFLICT(endpoint) DO NOTHING`, [`https://${project.slug}.demo.daoyintech.com`, project.owner_key, workspaceId]);
      await client.query(`INSERT INTO harness_resource_migrations(legacy_kind,legacy_id,resource_id,digest)
        VALUES('project_deployment',$1,$2,$3) ON CONFLICT(legacy_kind,legacy_id) DO NOTHING`,
        [deployment.id, deploymentId, currentDigest]);
      previous = deploymentId;
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  await unixJson("/run/daoyin-resource-executor/control.sock", "/execute", {
    action: "workspace_prepare", workspaceId, runtime: spec,
    source: { kind: "snapshot", snapshotId: currentSnapshotId }, entries: currentManifest,
  } satisfies ExecutorProcessRequest, undefined, 180_000);
}

async function apply(): Promise<void> {
  await pool.query("SELECT pg_advisory_lock(hashtext('daoyin-harness-resource-migration-v1'))");
  try {
    const spec = runtime();
    const projects = (await pool.query<LegacyProject>("SELECT id,owner_key,title,slug,active_version,created_at,updated_at FROM harness_projects ORDER BY id")).rows;
    for (const project of projects) await applyProject(project, spec);
  } finally { await pool.query("SELECT pg_advisory_unlock(hashtext('daoyin-harness-resource-migration-v1'))"); }
}

async function verify(): Promise<Record<string, unknown>> {
  const legacy = await legacyCounts();
 const mappedProjects = Number((await pool.query<{ count: string }>("SELECT count(*) AS count FROM harness_resource_migrations WHERE legacy_kind='project'")).rows[0]?.count ?? 0);
 const mappedDataResources = Number((await pool.query<{ count: string }>("SELECT count(*) AS count FROM harness_resource_migrations WHERE legacy_kind='project_data'")).rows[0]?.count ?? 0);
  const missingSessions = Number((await pool.query<{ count: string }>(`SELECT count(*) AS count FROM harness_project_sessions p
    JOIN harness_resource_migrations m ON m.legacy_kind='project' AND m.legacy_id=p.project_id
    LEFT JOIN harness_session_resources r ON r.owner_key=p.owner_key AND r.session_id=p.session_id AND r.resource_id=m.resource_id
    WHERE r.resource_id IS NULL`)).rows[0]?.count ?? 0);
  const missingDataSessions = Number((await pool.query<{ count: string }>(`SELECT count(*) AS count FROM harness_project_sessions p
    JOIN harness_resource_migrations m ON m.legacy_kind='project_data' AND m.legacy_id=p.project_id
    LEFT JOIN harness_session_resources r ON r.owner_key=p.owner_key AND r.session_id=p.session_id AND r.resource_id=m.resource_id
    WHERE r.resource_id IS NULL`)).rows[0]?.count ?? 0);
  const badEndpoints = Number((await pool.query<{ count: string }>(`SELECT count(*) AS count FROM harness_project_deployments d
    JOIN harness_projects p ON p.id=d.project_id JOIN harness_resource_migrations m ON m.legacy_kind='project_deployment' AND m.legacy_id=d.id
    JOIN harness_deployments n ON n.resource_id=m.resource_id WHERE n.endpoint<>('https://'||p.slug||'.demo.daoyintech.com')`)).rows[0]?.count ?? 0);
  const badEndpointOwners = Number((await pool.query<{ count: string }>(`SELECT count(*) AS count FROM harness_projects p
    JOIN harness_resource_migrations m ON m.legacy_kind='project' AND m.legacy_id=p.id
    JOIN harness_deployment_endpoints e ON e.endpoint=('https://'||p.slug||'.demo.daoyintech.com')
    WHERE e.owner_key<>p.owner_key OR e.workspace_id<>m.resource_id`)).rows[0]?.count ?? 0);
  const badHealthyDeployments = Number((await pool.query<{ count: string }>(`SELECT count(*) AS count FROM harness_projects p
    WHERE (SELECT count(*) FROM harness_project_deployments d
      JOIN harness_resource_migrations m ON m.legacy_kind='project_deployment' AND m.legacy_id=d.id
      JOIN harness_deployments n ON n.resource_id=m.resource_id
      WHERE d.project_id=p.id AND n.status='healthy') <> CASE WHEN p.active_version IS NULL THEN 0 ELSE 1 END
    OR EXISTS (SELECT 1 FROM harness_project_deployments d
      JOIN harness_resource_migrations m ON m.legacy_kind='project_deployment' AND m.legacy_id=d.id
      JOIN harness_deployments n ON n.resource_id=m.resource_id
      WHERE d.project_id=p.id AND n.status='healthy' AND d.version_id<>p.active_version)`)).rows[0]?.count ?? 0);
  const mappedVersions = Number((await pool.query<{ count: string }>("SELECT count(*) AS count FROM harness_resource_migrations WHERE legacy_kind='project_version'")).rows[0]?.count ?? 0);
  const mappedConcepts = Number((await pool.query<{ count: string }>("SELECT count(*) AS count FROM harness_resource_migrations WHERE legacy_kind='project_concept'")).rows[0]?.count ?? 0);
  const migratableConcepts = Number((await pool.query<{ count: string }>("SELECT count(*) AS count FROM harness_project_concepts WHERE status='completed' AND content IS NOT NULL AND mime_type IS NOT NULL")).rows[0]?.count ?? 0);
const mappedDeployments = Number((await pool.query<{ count: string }>("SELECT count(*) AS count FROM harness_resource_migrations WHERE legacy_kind='project_deployment'")).rows[0]?.count ?? 0);
 const missingBuildArtifacts = Number((await pool.query<{ count: string }>(`SELECT count(*) AS count FROM harness_project_deployments d
 JOIN harness_resource_migrations m ON m.legacy_kind='project_version' AND m.legacy_id=d.version_id
 JOIN harness_artifacts a ON a.resource_id=m.resource_id WHERE NOT (a.metadata ? 'deployment')`)).rows[0]?.count ?? 0);
  const hashFailures: string[] = [];
  const mutableWorkspaceFailures: string[] = [];
  const mappings = (await pool.query<{ legacy_id: string; resource_id: string; digest: string }>("SELECT legacy_id,resource_id,digest FROM harness_resource_migrations WHERE legacy_kind='project' ORDER BY legacy_id")).rows;
  for (const mapping of mappings) {
    const files = (await pool.query<LegacyFile>("SELECT path,content FROM harness_project_files WHERE project_id=$1 ORDER BY path", [mapping.legacy_id])).rows;
    const expected = expectedManifest(files); const expectedDigest = digestOf(expected);
    const snapshot = (await pool.query<{ digest: string; manifest: WorkspaceEntry[] }>(`SELECT s.digest,s.manifest FROM harness_workspaces w
      JOIN harness_workspace_snapshots s ON s.id=w.active_snapshot_id WHERE w.resource_id=$1`, [mapping.resource_id])).rows[0];
    if (!snapshot || snapshot.digest !== expectedDigest || mapping.digest !== expectedDigest || canonical(snapshot.manifest) !== canonical(expected)) {
      hashFailures.push(mapping.legacy_id); continue;
    }
    for (const entry of snapshot.manifest) if (entry.kind === "file" && !await content.has(entry.blobHash)) { hashFailures.push(mapping.legacy_id); break; }
    try {
      const current = await unixJson("/run/daoyin-resource-executor/control.sock", "/execute",
        { action: "workspace_prepare", operation: "snapshot", workspaceId: mapping.resource_id }, undefined, 180_000) as { entries?: unknown };
      if (!Array.isArray(current.entries) || canonical(current.entries as WorkspaceEntry[]) !== canonical(expected)) mutableWorkspaceFailures.push(mapping.legacy_id);
    } catch { mutableWorkspaceFailures.push(mapping.legacy_id); }
  }
  const versionHashFailures: string[] = [];
  const versionMappings = (await pool.query<{ legacy_id: string; digest: string; files: LegacyFile[]; source_digest: string; source_manifest: WorkspaceEntry[]; deployment_manifest: WorkspaceEntry[] }>(`SELECT m.legacy_id,m.digest,v.files,
    CASE WHEN a.metadata ? 'deployment' THEN parent.digest ELSE s.digest END AS source_digest,
    CASE WHEN a.metadata ? 'deployment' THEN parent.manifest ELSE s.manifest END AS source_manifest,
    s.manifest AS deployment_manifest FROM harness_resource_migrations m
    JOIN harness_project_versions v ON v.id=m.legacy_id
    JOIN harness_artifacts a ON a.resource_id=m.resource_id
    JOIN harness_workspace_snapshots s ON s.id=a.snapshot_id
    LEFT JOIN harness_workspace_snapshots parent ON parent.id=s.parent_snapshot_id
    WHERE m.legacy_kind='project_version' ORDER BY m.legacy_id`)).rows;
  for (const mapping of versionMappings) {
    const expected = expectedManifest(mapping.files); const expectedDigest = digestOf(expected);
    if (mapping.digest !== expectedDigest || mapping.source_digest !== expectedDigest || canonical(mapping.source_manifest) !== canonical(expected)) {
      versionHashFailures.push(mapping.legacy_id); continue;
    }
    for (const entry of mapping.deployment_manifest) if (entry.kind === "file" && !await content.has(entry.blobHash)) { versionHashFailures.push(mapping.legacy_id); break; }
  }
  const conceptHashFailures: string[] = [];
  const conceptMappings = (await pool.query<{ legacy_id: string; digest: string; content: Buffer; blob_hash: string }>(`SELECT m.legacy_id,m.digest,c.content,a.blob_hash
    FROM harness_resource_migrations m JOIN harness_project_concepts c ON c.id=m.legacy_id
    JOIN harness_artifacts a ON a.resource_id=m.resource_id WHERE m.legacy_kind='project_concept' ORDER BY m.legacy_id`)).rows;
  for (const mapping of conceptMappings) {
    const expected = `sha256:${createHash("sha256").update(mapping.content).digest("hex")}`;
    if (mapping.digest !== expected || mapping.blob_hash !== expected || !await content.has(expected)) conceptHashFailures.push(mapping.legacy_id);
  }
  const ready = mappedProjects === legacy.harness_projects && mappedDataResources === legacy.harness_projects && mappedVersions === legacy.harness_project_versions &&
    mappedConcepts === migratableConcepts && mappedDeployments === legacy.harness_project_deployments && missingBuildArtifacts === 0 &&
    missingSessions === 0 && missingDataSessions === 0 && badEndpoints === 0 && badEndpointOwners === 0 && badHealthyDeployments === 0 && hashFailures.length === 0 &&
    mutableWorkspaceFailures.length === 0 && versionHashFailures.length === 0 && conceptHashFailures.length === 0;
  return { legacy, mappedProjects, mappedDataResources, mappedVersions, mappedConcepts, migratableConcepts, mappedDeployments, missingBuildArtifacts,
    missingSessions, missingDataSessions, badEndpoints, badEndpointOwners, badHealthyDeployments, hashFailures, mutableWorkspaceFailures, versionHashFailures, conceptHashFailures, ready,
    externalDataRequiresOperationalVerification: ["published runtime", "project database roles", "uploads", "DNS and TLS"] };
}

async function stageDeployments(): Promise<Record<string, unknown>> {
 const rows = (await pool.query<{
  deploymentId: string; workspaceId: string; endpoint: string; runtime: RuntimeSpec; manifest: WorkspaceEntry[]; metadata: Record<string, unknown>;
 }>(`SELECT d.resource_id AS "deploymentId",d.workspace_id AS "workspaceId",d.endpoint,w.runtime,s.manifest,a.metadata
 FROM harness_deployments d
 JOIN harness_resource_migrations m ON m.legacy_kind='project_deployment' AND m.resource_id=d.resource_id
 JOIN harness_workspaces w ON w.resource_id=d.workspace_id
 JOIN harness_artifacts a ON a.resource_id=d.artifact_id
 JOIN harness_workspace_snapshots s ON s.id=a.snapshot_id
 WHERE d.status='healthy' ORDER BY d.endpoint,d.resource_id`)).rows;
 const staged: string[] = [];
 for (const row of rows) {
  const spec = row.metadata.deployment as DeploymentSpec | undefined;
  if (!spec) throw new Error(`Deployment artifact is not runnable: ${row.deploymentId}`);
  const bindings: ResolvedResourceBinding[] = [];
  for (const resourceId of spec.resourceIds) {
   const binding = (await pool.query<ResolvedResourceBinding>(`SELECT resource_id AS "resourceId",host_path AS "hostPath",
   target_path AS "targetPath",read_only AS "readOnly" FROM harness_runtime_bindings WHERE resource_id=$1`, [resourceId])).rows[0];
   if (!binding) throw new Error(`Deployment resource binding is missing: ${resourceId}`);
   bindings.push(binding);
  }
  const request: DeploymentWorkerRequest = { action: "deploy", deploymentId: row.deploymentId, workspaceId: row.workspaceId,
   endpoint: row.endpoint, runtime: row.runtime, entries: row.manifest, spec, bindings, secretValues: [] };
  await unixJson("/run/daoyin-resource-deployer/control.sock", "/deploy", request, undefined, 180_000);
  staged.push(row.deploymentId);
 }
 return { staged, count: staged.length, publicRouteChanged: false };
}

try {
  if (command === "--schema") { await schema(); process.stdout.write("Resource schema applied.\n"); }
  else if (command === "--plan") process.stdout.write(`${JSON.stringify({ command: "plan", legacy: await legacyCounts() }, null, 2)}\n`);
  else if (command === "--apply") { await apply(); process.stdout.write(`${JSON.stringify(await verify(), null, 2)}\n`); }
  else if (command === "--stage-deployments") process.stdout.write(`${JSON.stringify(await stageDeployments(), null, 2)}\n`);
  else process.stdout.write(`${JSON.stringify(await verify(), null, 2)}\n`);
} finally { await pool.end(); }
