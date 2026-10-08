// Exact committed runtime/resource artifacts only; no UI, daemon, platform or data migration.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readlink, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import http from 'node:http';

const revision = process.argv.find(arg => /^[a-f0-9]{40}$/.test(arg));
const poolIndex = process.argv.indexOf('--pool');
const subnetPool = process.argv[poolIndex + 1];
if (!process.argv.includes('--apply') || !revision || poolIndex < 0 ||
    !/^10\.(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\.0\.0\/16$/.test(subnetPool ?? '') ||
    process.platform !== 'linux' || process.getuid?.() !== 0) {
  throw new Error('Use independent Linux root: --apply <exact-revision> --pool <reserved-private-/16>.');
}
const run = (file, args, options = {}) => {
  try { return execFileSync(file, args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'], ...options }); }
  catch (error) {
    // Child command diagnostics can contain configuration; never retain them in
    // a top-level exception that Node could print during preflight failure.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`Command failed: ${file}; exit ${error.status ?? 'unknown'}; raw output withheld.`);
  }
};
const node = '/opt/daoyin-harness/node/bin/node';
const root = '/opt/daoyin-harness';
const runtimeSource = resolve('.cache/cloud-release', revision);
const runtimeDestination = join(root, 'releases', revision);
const resourceDestination = join('/opt/daoyin-resources/releases', revision);
const runtimeLink = join(root, 'current');
const units = ['daoyin-resource-executor.service', 'daoyin-resource-deployer.service'];
const overrides = units.map(unit => `/etc/systemd/system/${unit}.d/90-harness-kernel.conf`);
const poolConfiguration = '/etc/daoyin-resources/workspace-subnet-pool.env';
const changedFiles = [...overrides, poolConfiguration];
const journal = join(root, 'deployments', new Date().toISOString().replaceAll(':', '-') + '-kernel-' + revision.slice(0, 7) + '.json');
const report = { revision, subnetPool, startedAt: new Date().toISOString(), environment: 'independent-linux-server',
  uiChanged: false, dockerRestarted: false, platformChanged: false, dataMigration: false, realModelValidation: 'not-run' };
const digest = value => createHash('sha256').update(value).digest('hex');
async function verify(path, resource = false) {
  const manifest = JSON.parse(await readFile(join(path, 'release.json'), 'utf8'));
  if ((resource ? manifest.sourceRevision : manifest.revision) !== revision || manifest.preview || manifest.baseRevision ||
      (resource && manifest.sourceState !== 'committed-resource-sources')) throw new Error('Artifact source revision mismatch.');
  for (const [name, expected] of Object.entries(manifest.files ?? {})) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || digest(await readFile(join(path, name))) !== expected) throw new Error('Artifact integrity mismatch.');
  }
  if (!manifest.files?.[resource ? 'executor.mjs' : 'main.mjs'] || (resource && !manifest.files['deployment.mjs'])) throw new Error('Missing release entry.');
  return manifest;
}
async function replaceLink(path, target) {
  if (!(await lstat(path)).isSymbolicLink()) throw new Error('Expected a release symlink.');
  const temporary = path + '.next-' + randomUUID();
  await symlink(target, temporary); await rename(temporary, path);
}
async function atomicFile(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.next-' + randomUUID();
  await writeFile(temporary, text, { mode: 0o600, flag: 'wx' }); await rename(temporary, path);
}
const save = () => writeFile(journal, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
async function health() {
  const response = await fetch('http://127.0.0.1:4700/health/ready', { redirect: 'error', signal: AbortSignal.timeout(5000) });
  return response.status === 200 && (await response.json()).status === 'ready';
}
async function resourceHealth() {
  for (const unit of [...units, 'daoyin-resources.service']) {
    if (run('systemctl', ['is-active', unit]).trim() !== 'active') throw new Error('Resource control service is inactive.');
  }
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: '/run/daoyin-resources/control.sock', path: '/control', method: 'POST',
      headers: { 'Content-Type': 'application/json' } }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; if (body.length > 100000) request.destroy(new Error('Readiness output limit')); });
      response.on('end', () => { try { const value = JSON.parse(body); if (response.statusCode !== 200 || value.ready !== true) throw new Error('Resource readiness failed.'); resolve(true); } catch { reject(new Error('Resource readiness failed.')); } });
      response.on('error', reject);
    });
    request.setTimeout(60000, () => request.destroy(new Error('Resource readiness timeout.')));
    request.on('error', reject); request.end(JSON.stringify({ action: 'readiness' }));
  });
}
function range(cidr) {
  const [address, prefix = '32'] = cidr.split('/');
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) return undefined;
  const size = 2 ** (32 - Number(prefix));
  const number = address.split('.').reduce((sum, part) => sum * 256 + Number(part), 0);
  const start = Math.floor(number / size) * size;
  return { start, end: start + size - 1 };
}

if (run('git', ['rev-parse', 'HEAD']).trim() !== revision || run('git', ['rev-parse', 'origin/main']).trim() !== revision ||
    run('git', ['status', '--porcelain']).trim()) throw new Error('Server checkout must be clean at the exact pushed revision.');
const runtimeManifest = await verify(runtimeSource);
const resourceManifest = await verify(resourceDestination, true);
const previousRuntime = await readlink(runtimeLink);
if (!previousRuntime.startsWith(root + '/releases/')) throw new Error('Unexpected current runtime layout.');
const previousOverrides = await Promise.all(changedFiles.map(async path => {
  try { return await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}));
for (const unit of ['daoyin-harness-cloud.service', ...units]) {
  if (run('systemctl', ['is-active', unit]).trim() !== 'active') throw new Error('A required Harness service is not active.');
}
const subnetRange = range(subnetPool);
const routes = JSON.parse(run('ip', ['-json', '-4', 'route', 'show', 'table', 'all']));
const networkIds = run('docker', ['network', 'ls', '-q']).trim().split(/\s+/).filter(Boolean);
const networks = networkIds.length ? JSON.parse(run('docker', ['network', 'inspect', ...networkIds])) : [];
for (const cidr of [...routes.map(item => item.dst).filter(value => value && value !== 'default'),
  ...networks.flatMap(item => (item.IPAM.Config ?? []).map(config => config.Subnet).filter(Boolean))]) {
  const occupied = range(cidr);
  if (occupied && subnetRange.start <= occupied.end && subnetRange.end >= occupied.start) throw new Error('Dedicated pool overlaps an existing route or network.');
}
if (run('docker', ['ps', '--filter', 'label=daoyin.harness.resource=1', '--format', '{{.Names}}']).trim()) {
  throw new Error('Active Harness sandbox processes exist; no switch performed.');
}
const raw = await readFile('/etc/daoyin-harness/cloud.env', 'utf8');
const environment = Object.fromEntries(raw.split('\n').filter(line => line.trim() && !line.trim().startsWith('#')).map(line => {
  const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')];
}));
const { Pool } = createRequire(join(root, 'current/package.json'))('pg');
async function assertIdle() {
  if (run('docker', ['ps', '--filter', 'label=daoyin.harness.resource=1', '--format', '{{.Names}}']).trim()) throw new Error('Active workspace processes exist.');
  const database = new Pool({ connectionString: environment.DAOYIN_CLOUD_POSTGRES_URL, max: 1, connectionTimeoutMillis: 5000 });
  try {
    if ((await database.query("SELECT count(*)::integer AS n FROM cloud_runs WHERE status IN ('running','queued')")).rows[0].n !== 0) throw new Error('Active cloud tasks exist; no worker switch permitted.');
  } finally { await database.end(); }
}
await assertIdle();
report.previous = { runtime: previousRuntime, resourceCurrent: await readlink('/opt/daoyin-resources/current'), overridesExisted: previousOverrides.map(value => value !== null) };
report.artifacts = { runtime: runtimeManifest.files, resources: resourceManifest.files };
report.preflight = { activeRuns: 0, activeWorkspaceProcesses: 0, poolOverlap: false };
await mkdir(dirname(journal), { recursive: true, mode: 0o700 }); await save();
const backupDirectory = journal + '.rollback'; await mkdir(backupDirectory, { mode: 0o700 });
for (let index = 0; index < previousOverrides.length; index++) {
  if (previousOverrides[index] !== null) await writeFile(join(backupDirectory, String(index)), previousOverrides[index], { mode: 0o600 });
}
try { await lstat(runtimeDestination); await verify(runtimeDestination); }
catch (error) { if (error.code !== 'ENOENT') throw error; await cp(runtimeSource, runtimeDestination, { recursive: true, errorOnExist: true, force: false }); }
run(node, ['/opt/daoyin-harness/node/lib/node_modules/npm/bin/npm-cli.js', 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
  { cwd: runtimeDestination, timeout: 180000, env: { ...process.env, PATH: '/opt/daoyin-harness/node/bin:' + process.env.PATH } });
await verify(runtimeDestination);
try { await lstat(join(resourceDestination, 'node_modules')); throw new Error('Unexpected existing resource dependency path.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; await symlink(join(runtimeDestination, 'node_modules'), join(resourceDestination, 'node_modules')); }
let switched = false;
try {
  // Prevent task admission during the coordinated component switch. Dependencies
  // of these units and the old proxy/current mount are deliberately untouched.
  await assertIdle(); switched = true;
  run('systemctl', ['stop', 'daoyin-harness-cloud.service']);
  await assertIdle();
  await atomicFile(poolConfiguration, `HARNESS_WORKSPACE_SUBNET_POOL=${subnetPool}\n`);
  for (let index = 0; index < units.length; index++) {
    const entry = index === 0 ? 'executor.mjs' : 'deployment.mjs';
    await atomicFile(overrides[index], `[Service]\nExecStart=\nExecStart=${node} ${resourceDestination}/${entry}\nEnvironmentFile=${poolConfiguration}\n`);
  }
  run('systemctl', ['daemon-reload']);
  run('systemctl', ['restart', ...units]);
  run('systemctl', ['start', 'daoyin-resources.service']);
  for (const unit of units) if (run('systemctl', ['is-active', unit]).trim() !== 'active') throw new Error('Resource service failed to start.');
  await resourceHealth();
  await replaceLink(runtimeLink, runtimeDestination);
  run('systemctl', ['start', 'daoyin-harness-cloud.service']);
  let ready = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { if (await health()) { ready = true; break; } } catch { /* Bounded startup readiness polling. */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error('Candidate runtime failed readiness.');
  if (await readlink('/opt/daoyin-resources/current') !== report.previous.resourceCurrent) throw new Error('Unexpected resource proxy release change.');
  report.phase = 'deployed'; report.completedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({ ...report, journal }));
} catch (error) {
  report.phase = 'failed'; report.failure = error.message;
  if (switched) {
    try {
      run('systemctl', ['stop', 'daoyin-harness-cloud.service']);
      for (let index = 0; index < changedFiles.length; index++) {
        if (previousOverrides[index] === null) await unlink(changedFiles[index]).catch(cause => { if (cause.code !== 'ENOENT') throw cause; });
        else await atomicFile(changedFiles[index], previousOverrides[index]);
      }
      run('systemctl', ['daemon-reload']); run('systemctl', ['restart', ...units]);
      run('systemctl', ['start', 'daoyin-resources.service']);
      await replaceLink(runtimeLink, previousRuntime); run('systemctl', ['start', 'daoyin-harness-cloud.service']);
      report.rollback = await health() ? 'previous-components-restored-and-ready' : 'previous-components-restored-readiness-unconfirmed';
    } catch (rollback) { report.rollback = rollback.message; }
  }
  await save(); console.error(JSON.stringify({ ...report, journal })); process.exitCode = 1;
}
