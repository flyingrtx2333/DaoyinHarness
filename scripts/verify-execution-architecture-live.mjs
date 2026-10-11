// Four bounded actual account/model/tool/storage scenarios. No fabricated model or business responses.
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createCloudAccountClient, readHiddenCredentials, requestCloudObservation, sanitizeEvidence } from './cloud-live-client.mjs';
import { validationBudget } from './validation-budget.mjs';

const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
if (![5, 7].includes(args.length) || !args.includes('--run') || !/^[a-f0-9]{40}$/u.test(value('--expected-revision') ?? '') || !args.includes('--budget-dir') ||
    args.length === 7 && !args.includes('--scenarios')) throw new Error('Use --run --expected-revision FULL_COMMIT --budget-dir TRUSTED_DIRECTORY [--scenarios 1,2,3,4].');
const selectedScenarios = args.includes('--scenarios') ? value('--scenarios').split(',').map(Number) : [1, 2, 3, 4];
if (!selectedScenarios.length || new Set(selectedScenarios).size !== selectedScenarios.length || selectedScenarios.some(index => ![1, 2, 3, 4].includes(index))) throw new Error('Select unique scenario numbers 1 through 4.');
const revision = value('--expected-revision');
const driverRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' }).trim();
const budget = validationBudget(value('--budget-dir'));
const output = resolve('.cache/execution-architecture-live', new Date().toISOString().replaceAll(':', '-') + '_' + randomUUID().slice(0, 8));
await mkdir(output, { recursive: true, mode: 0o700 });
const report = { revision, driverRevision, environment: 'server-hosted cloud / authenticated daoyintech account', mode: 'real', fakeModels: false,
  cases: [], selectedScenarios, startedAt: new Date().toISOString(), status: 'preflight', modelCalls: 0, cost: 'unknown', limits: { maxScenarioRequests: 52, maxTotalSharedRequests: 160, maxCny: 10 } };
const save = () => writeFile(join(output, 'report.json'), JSON.stringify(sanitizeEvidence(report), null, 2) + '\n', { mode: 0o600 });
const client = createCloudAccountClient();
const call = async (path, body, options = {}) => (body === undefined ? await requestCloudObservation(client, path, options) : await client.request(path, body, options)).result;
let active;
let operations = 0;
async function control(item, action, input = {}) {
  const request = { action, sessionId: item.sessionId, ...(item.workspaceId ? { workspaceId: item.workspaceId } : {}), requestId: 'real_' + randomUUID().replaceAll('-', ''), ...input };
  const file = join(output, `${String(++operations).padStart(4, '0')}-${action}.json`);
  await writeFile(file, JSON.stringify(sanitizeEvidence({ request }), null, 2), { mode: 0o600, flag: 'wx' });
  const result = await call('/resources/control', request, { timeoutMs: 90000 });
  await writeFile(file, JSON.stringify(sanitizeEvidence({ request, result }), null, 2), { mode: 0o600 });
  item.operations.push({ action, file, sha256: createHash('sha256').update(JSON.stringify(result)).digest('hex') });
  return result;
}
async function fixture(name, files) {
  const item = { name, operations: [], runs: [], status: 'initializing' };
  report.cases.push(item); await save();
  item.sessionId = (await call('/sessions', { title: '真实通用架构验证 · ' + name })).session.id;
  item.budget = await budget.registerSession(item.sessionId);
  item.workspaceId = (await control(item, 'workspace_create', { title: name, source: { kind: 'empty' }, runtimeId: 'python313' })).workspace.id;
  item.originalWorkspaceId = item.workspaceId;
  for (const [path, content] of Object.entries(files)) await control(item, 'file_write', { path, content });
  return item;
}
async function run(item, message, maxModelCalls, { continueFromRunId, cancelWhen } = {}) {
  const current = await call('/runtime');
  if (current.build?.revision !== revision) throw new Error('Runtime revision drifted; no further model run admitted.');
  await budget.registerSession(item.sessionId);
  const input = { requestId: randomUUID(), message, limits: { maxModelCalls, maxToolCalls: 24, maxActiveMs: 600000 }, ...(continueFromRunId ? { continueFromRunId } : {}) };
  const evidence = { input, modelCalls: 0, startedAt: new Date().toISOString(), events: [], status: 'admitting' };
  item.runs.push(evidence); await save();
  const admitted = (await call(`/sessions/${item.sessionId}/runs`, input)).run;
  active = evidence.runId = admitted.id;
  let observed = admitted;
  const started = performance.now();
  const deadline = started + 420000;
  let cancelled = false;
  let cursor = 0;
  async function collect(deadline) {
    for (let page = 0; page < 256; page += 1) {
      const observed = await call(`/sessions/${item.sessionId}/events?after=${cursor}`, undefined, { deadline });
      if (!Array.isArray(observed.events) || typeof observed.hasMore !== 'boolean' || !Number.isSafeInteger(observed.nextEventSeq)) throw new Error('Cloud event page protocol mismatch.');
      for (const event of observed.events) {
        if (event.sessionId !== item.sessionId || event.eventSeq !== cursor + 1) throw new Error('Cloud event sequence or session mismatch.');
        cursor = event.eventSeq;
        if (event.turnId === admitted.id) evidence.events.push(event);
      }
      if (observed.nextEventSeq !== cursor || observed.hasMore && !observed.events.length) throw new Error('Cloud event cursor did not advance.');
      if (!observed.hasMore) return;
    }
    throw new Error('Cloud event page limit exceeded.');
  }
  while (true) {
    await collect(deadline);
    evidence.modelCalls = Math.max(evidence.modelCalls, evidence.events.filter(event => ['model.requested', 'capability.model.requested'].includes(event.type)).length);
    report.modelCalls = report.cases.flatMap(item => item.runs).reduce((sum, run) => sum + run.modelCalls, 0);
    await save();
    evidence.costAdmission = await budget.settleRun(admitted.id);
    evidence.modelCalls = Math.max(evidence.events.filter(event => ['model.requested', 'capability.model.requested'].includes(event.type)).length, evidence.costAdmission.requestsReservedForRun);
    report.modelCalls = report.cases.flatMap(item => item.runs).reduce((sum, run) => sum + run.modelCalls, 0);
    if (evidence.modelCalls > maxModelCalls || report.modelCalls > report.limits.maxScenarioRequests) throw new Error('Persisted model attempts exceeded the small-sample bound.');
    if (cancelWhen && !cancelled && evidence.events.some(cancelWhen)) {
      await call(`/runs/${admitted.id}/cancel`, {}); cancelled = true; evidence.cancelRequested = true;
    }
    observed = (await call(`/runs/${admitted.id}`, undefined, { deadline })).run;
    evidence.status = observed.status;
    await save();
    if (!['running', 'queued'].includes(observed.status)) break;
    if (performance.now() >= deadline - 1000) throw new Error('External observation deadline reached.');
    await delay(1000);
  }
  active = undefined;
  await collect(performance.now() + 30000);
  evidence.run = observed; evidence.durationMs = Math.round(performance.now() - started);
  evidence.modelCalls = Math.max(evidence.modelCalls, evidence.events.filter(event => ['model.requested', 'capability.model.requested'].includes(event.type)).length);
  report.modelCalls = report.cases.flatMap(item => item.runs).reduce((sum, run) => sum + run.modelCalls, 0);
  await save();
  evidence.costAdmission = await budget.settleRun(admitted.id);
  evidence.modelCalls = Math.max(evidence.events.filter(event => ['model.requested', 'capability.model.requested'].includes(event.type)).length, evidence.costAdmission.requestsReservedForRun);
  report.modelCalls = report.cases.flatMap(item => item.runs).reduce((sum, run) => sum + run.modelCalls, 0);
  if (evidence.modelCalls > maxModelCalls || report.modelCalls > report.limits.maxScenarioRequests) throw new Error('Final persisted model attempts exceeded the small-sample bound.');
  for (const event of evidence.events.filter(event => event.type === 'tool.completed' && ['environment_prepare', 'environment_read'].includes(event.payload.toolName))) {
    const operation = event.payload.evidence?.result?.operation;
    if (operation?.status === 'completed' && /^wsp_[a-f0-9]{24}$/u.test(operation.result?.workspace?.id ?? '')) item.workspaceId = operation.result.workspace.id;
  }
  await save(); return evidence;
}
let scenarioIndex = 0;
async function scenario(body) {
  if (!selectedScenarios.includes(++scenarioIndex)) return;
  try { await body(); }
  catch (error) {
    const item = report.cases.at(-1);
    if (item) { item.status = 'failed'; item.failure = { code: error.code ?? error.name, message: String(error.message).slice(0, 600), ...(error.publicFailure ? { publicFailure: error.publicFailure } : {}) }; }
    if (active) {
      const runId = active;
      try {
        await call(`/runs/${runId}/cancel`, {});
        const until = performance.now() + 30000;
        while (performance.now() < until) {
          const observed = (await call(`/runs/${runId}`)).run;
          if (!['queued', 'running'].includes(observed.status)) { active = undefined; break; }
          await delay(1000);
        }
      } catch { /* Never replay an uncertain cancellation. */ }
      if (active) throw new Error('Original scenario run could not be settled; no further admission.');
    }
    await save();
    if ([401, 402, 403].includes(error.publicFailure?.status) || /revision|budget audit|admission|model configuration/i.test(error.message)) throw error;
  }
}
const partial = evidence => evidence.events.some(event => event.type === 'turn.completed' && event.payload.taskOutcome === 'partial');
const currentPlan = item => item.runs.flatMap(run => run.events).filter(event => event.type === 'task_plan.updated').at(-1)?.payload.plan;
try {
  report.authentication = await client.login(await readHiddenCredentials());
  report.budget = await budget.inspect(); report.model = report.budget.configuration;
  if ((await call('/runtime')).build?.revision !== revision) throw new Error('Expected cloud revision not deployed.');
  report.status = 'running'; await save();

  await scenario(async () => {
  const multi = await fixture('多步产物与计划恢复', { 'orders.csv': 'name,quantity,price\nalpha,2,3\nbeta,1,4\n' });
  const first = await run(multi, `在工作区 ${multi.workspaceId} 完成两阶段任务。用 task_plan 保存目标、步骤和真实证据引用。第一阶段读取 orders.csv，生成 totals.csv（name,total），总和写入 summary.txt。第二阶段生成说明文件 README.md 并实际核对产物。本轮仅完成第一阶段，然后保存第二阶段为未完成并如实报告 partial，等待我下一轮继续。`, 4);
  const resumed = await run(multi, '继续保存的两阶段任务。先读取当前计划和实际产物，复用已完成写入，再完成剩余步骤与实际验证。', 8, { continueFromRunId: first.runId });
  multi.receipt = await control(multi, 'file_read', { path: 'summary.txt' });
  multi.totals = await control(multi, 'file_read', { path: 'totals.csv' });
  multi.documentation = await control(multi, 'file_read', { path: 'README.md' });
  const totals = (multi.totals.content ?? multi.totals.text ?? '').trim().split(/\r?\n/u).map(row => row.split(',').map(cell => cell.trim()));
  const summaryNumbers = (multi.receipt.content ?? multi.receipt.text ?? '').match(/[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/gu) ?? [];
  const actualTotals = totals.length === 3 && totals[0].join(',') === 'name,total' && totals.slice(1).every(row => row.length === 2) &&
    totals.slice(1).filter(row => row[0] === 'alpha' && Number(row[1]) === 6).length === 1 &&
    totals.slice(1).filter(row => row[0] === 'beta' && Number(row[1]) === 4).length === 1;
  const savedPlan = first.events.filter(event => event.type === 'task_plan.updated').at(-1)?.payload.plan;
  const resumedPlan = currentPlan(multi);
  const restoredPlan = savedPlan !== undefined && resumed.events.some(event => event.type === 'model.requested' &&
    event.payload.systemPrompt?.dynamicText.includes(JSON.stringify(savedPlan)));
  multi.status = partial(first) && savedPlan?.steps.some(step => step.status !== 'completed') &&
    restoredPlan && resumedPlan?.version > savedPlan.version &&
    savedPlan.steps.every(step => resumedPlan.steps.some(current => current.id === step.id && current.status === 'completed')) &&
    resumedPlan.steps.length > 0 && resumedPlan.steps.every(step => step.status === 'completed') && actualTotals &&
    summaryNumbers.length === 1 && Number(summaryNumbers[0]) === 10 && resumed.events.some(event => event.type === 'tool.completed') ? 'passed' : 'failed';

  });
  await scenario(async () => {
  const originalExport = 'import sys\nif sys.version_info[:2] != (3, 11):\n    raise RuntimeError("project requires Python 3.11")\nprices = [3, 4]\nprint(sum(prices))\n';
  const environment = await fixture('声明运行时适配', { '.python-version': '3.11\n', 'pyproject.toml': '[project]\nname="price-export"\nversion="0.1.0"\nrequires-python=">=3.11,<3.12"\n', 'export.py': originalExport });
  await run(environment, `在工作区 ${environment.workspaceId} 把 export.py 改为输出价格含 10% 服务费的总额，保留项目声明的解释器约束。先检查真实环境和项目声明，使用 runtime_list 与 environment_prepare 准备兼容环境，观察同一 operation，成功后在新工作区修改并实际运行验证，应输出 7.7。保存计划与证据。`, 12);
  environment.actual = await control(environment, 'environment_inspect');
  environment.verification = await control(environment, 'process_run', { executable: 'python', args: ['export.py'], cwd: '.', timeoutMs: 30000 });
  environment.original = await control(environment, 'file_read', { workspaceId: environment.originalWorkspaceId, path: 'export.py' });
  const actualTotal = (environment.verification.stdout ?? '').trim();
  environment.status = environment.workspaceId !== environment.originalWorkspaceId && environment.verification.exitCode === 0 &&
    /^\d+(?:\.\d+)?$/u.test(actualTotal) && Math.abs(Number(actualTotal) - 7.7) <= 1e-10 &&
    (environment.original.content ?? environment.original.text) === originalExport ? 'passed' : 'failed';

  });
  await scenario(async () => {
  const long = await fixture('单次长进程与清理后回执', { 'job.py': 'import time\nfrom pathlib import Path\ntime.sleep(65)\np=Path("launches.txt")\np.write_text((p.read_text() if p.exists() else "") + "one\\n")\nprint("job-finished", flush=True)\n' });
  const longRun = await run(long, `工作区 ${long.workspaceId} 的 job.py 是真实 65 秒工作。只启动一次，用 process_run 的前台等待 1000ms 和总期限 120000ms；获得运行中的 processId 后只观察这个编号。等真实退出码与输出，再报告结果。不要重新启动，不要修改脚本以缩短等待。`, 12);
  const launched = longRun.events.find(event => event.type === 'tool.completed' && event.payload.toolName === 'process_run' && event.payload.evidence?.result?.processId);
  long.processId = launched?.payload.evidence.result.processId;
  if (long.processId) long.saved = await control(long, 'process_read', { processId: long.processId, cursor: 0, waitMs: 0 });
  long.launches = await control(long, 'file_read', { path: 'launches.txt' });
  const initial = launched?.payload.evidence.result;
  long.status = initial?.tracked === true && initial.state === 'running' && initial.foregroundWaitMs <= 60000 &&
    long.saved?.terminalReceipt === true && long.saved.cleanupPending === false && long.saved.exitCode === 0 &&
    /^sha256:[a-f0-9]{64}$/u.test(long.saved.digest ?? '') && /job-finished/.test(long.saved.output ?? '') &&
    (long.launches.content ?? long.launches.text) === 'one\n' && longRun.events.filter(event => event.type === 'tool.started' && event.payload.toolName === 'process_run').length === 1 ? 'passed' : 'failed';

  });
  await scenario(async () => {
  const bounded = await fixture('额度保留续跑与取消', { 'ledger.txt': '', 'write_once.py': 'from pathlib import Path\np=Path("ledger.txt")\np.write_text(p.read_text()+"phase-a\\n")\nprint("phase-a-written")\n', 'cancel_job.py': 'import time\ntime.sleep(90)\nprint("unexpected-completion")\n' });
  const limited = await run(bounded, `工作区 ${bounded.workspaceId} 中用 task_plan 保存两个步骤：先运行 write_once.py 写入 phase-a（只允许执行一次），再生成 result.txt 并实际核对。额度不足时保存进展，不能宣称验证完成。`, 6);
  bounded.beforeContinuation = await control(bounded, 'file_read', { path: 'ledger.txt' });
  const continued = await run(bounded, '继续原任务。先核对已保存计划及 ledger.txt；已经有 phase-a 就不要再执行 write_once.py，再生成 result.txt 说明实际已完成的操作，并验证。', 6, { continueFromRunId: limited.runId });
  bounded.ledger = await control(bounded, 'file_read', { path: 'ledger.txt' });
  bounded.result = await control(bounded, 'file_read', { path: 'result.txt' });
  const cancelled = await run(bounded, `在工作区 ${bounded.workspaceId} 只运行 cancel_job.py，process_run 等待1000ms，进程总期限120000ms，然后观察真实结果。`, 4, { cancelWhen: event => event.type === 'tool.completed' && event.payload.toolName === 'process_run' && event.payload.evidence?.result?.state === 'running' });
  const cancelledProcess = cancelled.events.find(event => event.type === 'process.completed');
  bounded.status = partial(limited) && (bounded.beforeContinuation.content ?? bounded.beforeContinuation.text) === 'phase-a\n' && continued.run.status === 'completed' &&
    continued.events.some(event => event.type === 'turn.completed' && event.payload.taskOutcome === 'completed') &&
    (bounded.result.content ?? bounded.result.text ?? '').trim().length > 0 &&
    (bounded.ledger.content ?? bounded.ledger.text) === 'phase-a\n' && cancelled.run.status === 'cancelled' && cancelledProcess?.payload.status === 'cancelled' ? 'passed' : 'failed';
  });
  report.status = report.cases.length === selectedScenarios.length && report.cases.every(item => item.status === 'passed') ? 'passed-small-sample' : 'failed-small-sample';
} catch (error) {
  report.status = 'incomplete'; report.failure = { code: error.code ?? error.name, message: String(error.message).slice(0, 600), ...(error.publicFailure ? { publicFailure: error.publicFailure } : {}) };
  if (active) { try { await call(`/runs/${active}/cancel`, {}); report.cancelRequested = active; } catch { report.cancelUnconfirmed = active; } }
} finally {
  try { report.finalBudget = await budget.inspect(); report.cost = { settledCny: report.finalBudget.settledMicroCny / 1000000, conservativeCommittedCny: report.finalBudget.committedMicroCny / 1000000, unknownReservations: report.finalBudget.unsettledReservations }; } catch { report.cost = 'unknown'; }
  client.close(); report.finishedAt = new Date().toISOString(); await save();
}
console.log(JSON.stringify({ output, status: report.status, modelCalls: report.modelCalls, cases: report.cases.map(item => ({ name: item.name, status: item.status })), cost: report.cost }));
process.exitCode = report.status === 'passed-small-sample' ? 0 : 1;
