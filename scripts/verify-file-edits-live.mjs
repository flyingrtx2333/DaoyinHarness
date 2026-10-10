// Small actual account/Agent/tool/storage scenarios. No fabricated model/API replies.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createCloudAccountClient, readHiddenCredentials, requestCloudObservation, sanitizeEvidence } from './cloud-live-client.mjs';

const revision = process.argv[process.argv.indexOf('--expected-revision') + 1];
const selected = process.argv.includes('--case') ? process.argv[process.argv.indexOf('--case') + 1] : undefined;
if (!process.argv.includes('--run') || !/^[a-f0-9]{40}$/u.test(revision ?? '')) throw new Error('Use --run --expected-revision EXACT_DEPLOYED_COMMIT; hidden account credentials on stdin.');
const output = resolve('.cache/file-edits-live', new Date().toISOString().replaceAll(':', '-') + '_' + randomUUID().slice(0, 8));
await mkdir(output, { recursive: true, mode: 0o700 });
const controller = new AbortController();
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => controller.abort(new Error('Stopped by operator.')));
const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12 * 60_000)]);
const client = createCloudAccountClient({ signal });
const report = { kind: 'real-cloud-file-edit-contracts', revision, environment: 'ordinary-account-cloud', startedAt: new Date().toISOString(),
  driverSha256: createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'),
  limits: { cases: 3, totalSharedModelCalls: 36, perCaseMs: 180_000 }, status: 'preflight', cases: [] };
const save = () => writeFile(join(output, 'report.json'), JSON.stringify(sanitizeEvidence(report), null, 2) + '\n', { mode: 0o600 });
const request = async (path, body, options) => (await client.request(path, body, options)).result;
const observe = async path => (await requestCloudObservation(client, path, { signal })).result;
const scenarios = [
  { name: 'edit-and-idempotence', calls: 12, files: { 'invoice.py': 'quantity = 2\nunit_price = 7\nprint(quantity * unit_price)\n' },
    message: '把 invoice.py 的 quantity 改为 3。先读取文件，使用 file_patch 精确替换，随后再次用同样的目标值 3 做一次幂等替换（expected 和 replacement 均为当前 quantity = 3）。依据每次真实回执区分发生修改和无变化。最后执行 invoice.py 检查实际金额并核对修改范围。',
    expected: { 'invoice.py': 'quantity = 3\nunit_price = 7\nprint(quantity * unit_price)\n' } },
  { name: 'stale-version-recovery', calls: 12, files: { 'settings.json': '{"quantity":2,"note":"initial"}\n' },
    message: '验证当前文件工具如何保护协作修改：先用 file_read 读取 settings.json；再用一次 process_run 在真实文件中把 note 改为 collaborator，保留 quantity=2。接着不重读，尝试用 file_patch 将 quantity 从 2 改为 3。预期旧版本保护拒绝该操作；若拒绝，重新读取当前文件，再用 file_patch 修改 quantity 为 3，保留 collaborator。最后读取文件并如实说明实际拒绝和恢复结果。不做外部操作。',
    expected: { 'settings.json': { quantity: 3, note: 'collaborator' } } },
  { name: 'unified-multi-file-edit', calls: 12, files: { 'first.txt': 'environment=DEV\nowner=one\n', 'second.txt': 'environment=DEV\nowner=two\n' },
    message: '先读取 first.txt 和 second.txt，然后用一次 file_patch 的统一差异补丁（patch 参数）将两个文件的 environment=DEV 改成 environment=TEST，保留各自 owner。不要用进程或整文件重写绕过文件工具。查看实际回执的两个修改路径和差异，再读取结果确认。',
    expected: { 'first.txt': 'environment=TEST\nowner=one\n', 'second.txt': 'environment=TEST\nowner=two\n' } },
];
if (selected && !scenarios.some(scenario => scenario.name === selected)) throw new Error('Unknown real scenario.');
const cases = scenarios.filter(scenario => selected === undefined || scenario.name === selected);
report.limits.cases = cases.length; report.limits.totalSharedModelCalls = cases.reduce((total, scenario) => total + scenario.calls, 0);
let active;
try {
  console.log(JSON.stringify({ ready: true, input: 'hidden-credential-json', output }));
  await client.login(await readHiddenCredentials({ signal }));
  report.runtime = await observe('/runtime');
  if (report.runtime.build?.revision !== revision) throw new Error('RUNTIME_REVISION_MISMATCH');
  for (const scenario of cases) {
    const item = { name: scenario.name, startedAt: new Date().toISOString(), input: scenario.message, events: [], status: 'preparing' };
    report.cases.push(item); await save();
    const sessionId = (await request('/sessions', { title: 'Real file edits: ' + scenario.name })).session.id;
    item.sessionId = sessionId;
    const control = (action, input = {}) => request('/resources/control', { action, sessionId, requestId: randomUUID(),
      ...(item.workspaceId ? { workspaceId: item.workspaceId } : {}), ...input }, { timeoutMs: 120_000 });
    item.workspaceId = (await control('workspace_create', { title: scenario.name, source: { kind: 'empty' }, runtimeId: 'python313' })).workspace.id;
    for (const [path, content] of Object.entries(scenario.files)) await control('file_write', { path, content });
    const requestId = randomUUID(); item.requestId = requestId; await save();
    const accepted = await request(`/sessions/${sessionId}/runs`, { requestId,
      message: `只操作当前挂载的工作区 ${item.workspaceId}。${scenario.message}不要委派子任务、写记忆或操作工作区之外的业务。` });
    active = accepted.run.id; item.runId = active; item.status = 'running'; await save();
    const deadline = Date.now() + 180_000; let cursor = 0;
    while (true) {
      const page = await observe(`/sessions/${sessionId}/events?after=${cursor}`);
      for (const event of page.events) {
        if (event.eventSeq !== cursor + 1) throw new Error('EVENT_CURSOR_GAP');
        cursor = event.eventSeq; item.events.push(event);
      }
      item.run = (await observe(`/runs/${active}`)).run; await save();
      if (!['running', 'queued'].includes(item.run.status) && !page.hasMore) break;
      if (Date.now() >= deadline) throw new Error('REAL_CASE_DEADLINE');
      await delay(800, undefined, { signal });
    }
    active = undefined;
    item.actualFiles = {};
    for (const path of Object.keys(scenario.expected)) item.actualFiles[path] = await control('file_read', { path });
    const completed = item.events.filter(event => event.type === 'tool.completed');
    const patches = completed.filter(event => event.payload.toolName === 'file_patch');
    item.sharedModelCalls = item.events.filter(event => ['model.requested', 'capability.model.requested'].includes(event.type)).length;
    item.checks = { terminalCompleted: item.run.status === 'completed', withinBudget: item.sharedModelCalls <= scenario.calls,
      persistedContent: Object.entries(scenario.expected).every(([path, value]) => typeof value === 'string'
        ? item.actualFiles[path].content === value : Object.keys(JSON.parse(item.actualFiles[path].content)).length === Object.keys(value).length && Object.entries(value).every(([key, expected]) => JSON.parse(item.actualFiles[path].content)[key] === expected)),
      actualMutationEvidence: patches.some(event => event.payload.evidence.result.mutation?.changed === true),
      readVersions: completed.filter(event => event.payload.toolName === 'file_read').every(event => /^sha256:[a-f0-9]{64}$/u.test(event.payload.evidence.result.digest)),
    };
    if (scenario.name === 'edit-and-idempotence') {
      item.checks.noOpExplicit = patches.some(event => event.payload.evidence.result.mutation?.changed === false && !event.payload.evidence.verificationHint);
      item.checks.amountExecuted = completed.some(event => event.payload.toolName === 'process_run' && event.payload.evidence.result.exitCode === 0 && /\b21\b/u.test(event.payload.evidence.result.stdout ?? ''));
    }
    if (scenario.name === 'stale-version-recovery') item.checks.actualStaleRejection = item.events.some(event => event.type === 'tool.failed' && event.payload.code === 'FILE_STALE_VERSION');
    if (scenario.name === 'unified-multi-file-edit') item.checks.twoActualChanges = patches.some(event => event.payload.evidence.result.mutation?.changes?.filter(change => change.changed).length === 2);
    item.status = Object.values(item.checks).every(Boolean) ? 'passed' : 'failed'; item.finishedAt = new Date().toISOString(); await save();
    console.log(JSON.stringify({ name: item.name, status: item.status, runId: item.runId, checks: item.checks, sharedModelCalls: item.sharedModelCalls }));
    if (item.status !== 'passed') throw new Error('REAL_CASE_FAILED');
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failureCode = error.publicFailure?.code ?? error.code ?? error.message ?? error.name; report.failureStage = error.publicFailure?.path;
  if (active) { try { await request(`/runs/${active}/cancel`, {}, { signal: null, timeoutMs: 15_000 }); report.cancelledRun = active; } catch { report.cancelStatus = 'unconfirmed'; } }
} finally { report.finishedAt = new Date().toISOString(); await save(); client.close(); }
console.log(JSON.stringify({ status: report.status, output, failureCode: report.failureCode }));
process.exitCode = report.status === 'passed' ? 0 : 1;
