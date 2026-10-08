// Exact server-built runtime only. Never reload systemd or alter other components.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readlink, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const revision = process.argv[process.argv.indexOf('--apply') + 1];
if (!process.argv.includes('--apply') || !/^[a-f0-9]{40}$/.test(revision ?? '') ||
    process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('Use independent Linux root: --apply <exact-40-character-revision>.');
const root = '/opt/daoyin-harness', service = 'daoyin-harness-cloud.service';
const node = join(root, 'node/bin/node'), link = join(root, 'current');
const source = resolve('.cache/cloud-release', revision), destination = join(root, 'releases', revision);
const journal = join(root, 'deployments', new Date().toISOString().replaceAll(':', '-') + '-runtime-only-' + revision.slice(0, 12) + '.json');
const digest = value => createHash('sha256').update(value).digest('hex');
const run = (file, args, options = {}) => {
  try { return execFileSync(file, args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'], ...options }); }
  catch (error) {
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`Command failed: ${file}; exit ${error.status ?? 'unknown'}; raw output withheld.`);
  }
};
const report = { revision, startedAt: new Date().toISOString(), environment: 'independent-linux-server',
  scope: 'runtime-only', uiChanged: false, resourceChanged: false, platformChanged: false,
  dockerRestarted: false, dataMigration: false, realModelValidation: 'not-run' };
const save = () => writeFile(journal, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
async function verify(path) {
  const manifest = JSON.parse(await readFile(join(path, 'release.json'), 'utf8'));
  if (manifest.revision !== revision || manifest.preview || manifest.baseRevision || manifest.entry !== 'main.mjs' ||
      !manifest.files?.['main.mjs'] || !manifest.files?.['package-lock.json']) throw new Error('Artifact revision or source scope mismatch.');
  for (const [name, hash] of Object.entries(manifest.files)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || !/^[a-f0-9]{64}$/.test(hash) ||
        digest(await readFile(join(path, name))) !== hash) throw new Error('Artifact integrity mismatch.');
  }
  return manifest;
}
async function replaceLink(target) {
  if (!(await lstat(link)).isSymbolicLink()) throw new Error('Expected runtime release symlink.');
  const temporary = link + '.next-' + randomUUID();
  await symlink(target, temporary); await rename(temporary, link);
}
async function configHashes(path, values = {}) {
  const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (!info) return values;
  if (info.isDirectory()) for (const name of (await readdir(path)).sort()) await configHashes(join(path, name), values);
  else if (info.isSymbolicLink()) values[path] = digest(await readlink(path));
  else if (info.isFile()) values[path] = digest(await readFile(path));
  return values;
}
async function protectedState() {
  const listed = run('systemctl', ['list-units', '--type=service', '--all', '--no-legend', '--plain']).split('\n')
    .map(line => line.trim().split(/\s+/)[0]).filter(name => name.startsWith('daoyin-') && name !== service).sort();
  const units = {};
  for (const unit of [...new Set(['docker.service', 'nginx.service', ...listed])].sort()) {
    const properties = run('systemctl', ['show', unit, '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID',
      '-p', 'ExecMainStartTimestampMonotonic', '-p', 'ActiveEnterTimestampMonotonic', '-p', 'ExecStart']);
    // ExecStart may hold configuration; retain only its digest.
    units[unit] = digest(properties);
  }
  const ids = run('docker', ['ps', '-q']).trim().split(/\s+/).filter(Boolean).sort();
  const format = '{"id":{{json .Id}},"image":{{json .Image}},"startedAt":{{json .State.StartedAt}},"pid":{{json .State.Pid}}}';
  const containers = ids.length ? run('docker', ['inspect', '--format', format, ...ids]).trim().split('\n')
    .map(line => JSON.parse(line)).sort((a, b) => a.id.localeCompare(b.id)) : [];
  const links = {};
  for (const path of [join(root, 'node'), join(root, 'workbench/current'), '/opt/daoyin-resources/current']) links[path] = await readlink(path);
  const configs = {};
  for (const path of ['/etc/daoyin-harness', '/etc/daoyin-resources', '/etc/nginx/nginx.conf',
    '/etc/nginx/conf.d', '/etc/nginx/sites-enabled']) await configHashes(path, configs);
  for (const unit of [...listed, service]) {
    await configHashes('/etc/systemd/system/' + unit, configs);
    await configHashes('/etc/systemd/system/' + unit + '.d', configs);
  }
  return { units, containers, links, configs };
}
function equalProtected(before, after) {
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Protected service, container, configuration or release changed.');
}
async function environment(path) {
  return Object.fromEntries((await readFile(path, 'utf8')).split('\n').filter(line => line.trim() && !line.trim().startsWith('#')).map(line => {
    const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')];
  }));
}
const { Pool } = createRequire(join(root, 'current/package.json'))('pg');
async function count(connectionString, query) {
  if (!connectionString) throw new Error('Required existing database configuration missing.');
  const database = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  try { return (await database.query(query)).rows[0]; }
  catch {
    throw new Error('Read-only idle query failed; database diagnostics withheld.');
  } finally { await database.end(); }
}
async function assertIdle() {
  const cloud = await environment('/etc/daoyin-harness/cloud.env');
  const resources = await environment('/etc/daoyin-resources/service.env');
  const calls = await count(cloud.DAOYIN_CLOUD_POSTGRES_URL, "SELECT count(*)::integer AS runs FROM cloud_runs WHERE status IN ('running','queued')");
  const jobs = await count(resources.HARNESS_RESOURCES_DATABASE_URL, `SELECT
    (SELECT count(*)::integer FROM harness_workspaces WHERE state='creating') AS workspaces,
    (SELECT count(*)::integer FROM harness_process_sessions WHERE status IN ('starting','running')) AS processes,
    (SELECT count(*)::integer FROM harness_deployments WHERE status IN ('queued','starting')) AS deployments`);
  if (Object.values({ ...calls, ...jobs }).some(value => value !== 0)) throw new Error('Active Harness runs or resource jobs exist.');
  if (run('docker', ['ps', '--filter', 'label=daoyin.harness.resource=1', '-q']).trim()) throw new Error('Active workspace containers exist.');
  for (const unit of ['daoyin-resource-builder.service', 'daoyin-resource-executor.service', 'daoyin-resource-deployer.service']) {
    const group = run('systemctl', ['show', unit, '-p', 'ControlGroup', '--value']).trim();
    if (!group.startsWith('/system.slice/') || !/^\/system\.slice\/[A-Za-z0-9_.-]+$/.test(group)) throw new Error('Unexpected resource cgroup.');
    const pids = new Set();
    async function readProcesses(path) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isDirectory()) await readProcesses(join(path, entry.name));
        else if (entry.name === 'cgroup.procs') for (const pid of (await readFile(join(path, entry.name), 'utf8')).trim().split(/\s+/).filter(Boolean)) pids.add(pid);
      }
    }
    await readProcesses('/sys/fs/cgroup' + group);
    if (pids.size !== 1) throw new Error('Resource service has active children or is not running.');
  }
  return { ...calls, ...jobs, workspaceContainers: 0, resourceChildren: 0 };
}
async function ready(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:4700/health/ready', { redirect: 'error', signal: AbortSignal.timeout(Math.min(3000, Math.max(1, deadline - Date.now()))) });
      if (response.status === 200 && (await response.json()).status === 'ready') return true;
    } catch { /* Bounded startup readiness wait. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}
if (run('git', ['rev-parse', 'HEAD']).trim() !== revision || run('git', ['rev-parse', 'origin/main']).trim() !== revision ||
    run('git', ['branch', '--show-current']).trim() !== 'main' || run('git', ['status', '--porcelain']).trim()) throw new Error('Server main must be clean at the exact pushed revision.');
if (run('systemctl', ['is-active', service]).trim() !== 'active' || !await ready(5000)) throw new Error('Previous runtime is not active and ready.');
const previous = await readlink(link);
if (!new RegExp('^' + root + '/releases/[a-f0-9]{40}$').test(previous) || previous === destination) throw new Error('Unexpected previous runtime or already deployed.');
const manifest = await verify(source);
const before = await protectedState();
report.previousRuntime = previous; report.artifacts = manifest.files; report.protectedBefore = before;
report.preflight = await assertIdle();
await mkdir(dirname(journal), { recursive: true, mode: 0o700 }); await save();
let destinationExists = true;
try { await lstat(destination); }
catch (error) { if (error.code !== 'ENOENT') throw error; destinationExists = false; }
if (destinationExists) await verify(destination);
else await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
run(node, [join(root, 'node/lib/node_modules/npm/bin/npm-cli.js'), 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
  { cwd: destination, timeout: 180000, env: { ...process.env, PATH: join(root, 'node/bin') + ':' + process.env.PATH } });
await verify(destination);
let stopped = false;
try {
  await assertIdle(); equalProtected(before, await protectedState());
  stopped = true; run('systemctl', ['stop', service]);
  await assertIdle(); equalProtected(before, await protectedState());
  await replaceLink(destination); run('systemctl', ['start', service]);
  if (!await ready()) throw new Error('Candidate runtime did not become ready.');
  if (run('systemctl', ['is-active', service]).trim() !== 'active') throw new Error('Candidate runtime inactive.');
  const pid = run('systemctl', ['show', service, '-p', 'MainPID', '--value']).trim();
  const command = (await readFile('/proc/' + pid + '/cmdline')).toString().split('\0').filter(Boolean);
  if (command.length !== 2 || command[0] !== node || command[1] !== join(root, 'current/main.mjs') ||
      await readlink(link) !== destination) throw new Error('Running entrypoint does not match candidate.');
  await verify(destination);
  report.protectedAfter = await protectedState(); equalProtected(before, report.protectedAfter);
  const anonymous = await fetch('https://harness.daoyintech.com/api/v1/cloud/runtime', { redirect: 'error', signal: AbortSignal.timeout(7000), headers: { 'cache-control': 'no-cache' } });
  if (anonymous.status !== 401) throw new Error('Public authenticated runtime boundary changed.');
  report.phase = 'deployed'; report.health = { readiness: 'ready', anonymousPublicRuntime: 401,
    candidateManifestAndRunningEntrypoint: 'verified', authenticatedPublicRevision: 'requires-existing-account-BFF-check' };
  report.runtimePid = Number(pid); report.completedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({ revision, phase: report.phase, journal, previousRuntime: previous }));
} catch (error) {
  report.phase = 'failed'; report.failure = error.message;
  if (stopped) {
    try {
      run('systemctl', ['stop', service]); await replaceLink(previous); run('systemctl', ['start', service]);
      const restored = await ready(); report.protectedAfterRollback = await protectedState(); equalProtected(before, report.protectedAfterRollback);
      report.rollback = restored ? 'previous-runtime-restored-and-ready' : 'previous-runtime-restored-readiness-unconfirmed';
    } catch (rollback) { report.rollback = rollback.message; }
  }
  await save(); console.error(JSON.stringify({ revision, phase: report.phase, failure: report.failure, rollback: report.rollback, journal })); process.exitCode = 1;
}
