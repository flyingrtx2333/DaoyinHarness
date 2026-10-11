// Three bounded actual model runs. Each assertion is backed by the actual account, tools and persistent receipts.
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, join, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createCloudAccountClient, readHiddenCredentials, requestCloudObservation, sanitizeEvidence } from './cloud-live-client.mjs';
import { validationBudget } from './validation-budget.mjs';

const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
const reusePrepared = args.includes('--resume-prepared-report');
const resuming = args.includes('--resume-report') || reusePrepared;
const repairOnly = args.includes('--repair-only');
const completedSwe = args.includes('--completed-swe-report');
if (args.length !== (resuming ? 7 : 5) + (repairOnly ? 1 : 0) + (completedSwe ? 2 : 0) || !args.includes('--run') || !args.includes('--budget-dir') || !/^[a-f0-9]{40}$/u.test(value('--expected-revision') ?? '') ||
    (repairOnly || completedSwe) && !reusePrepared || completedSwe && typeof value('--completed-swe-report') !== 'string' ||
    args.includes('--resume-report') && reusePrepared || resuming && typeof value(reusePrepared ? '--resume-prepared-report' : '--resume-report') !== 'string')
  throw new Error('Use --run --expected-revision FULL_COMMIT --budget-dir TRUSTED_DIRECTORY [--resume-report PATH | --resume-prepared-report PATH [--repair-only] [--completed-swe-report PATH]].');
let sourceReport;
let sourceCase;
let sourceRun;
let sourceReceipt;
if (resuming) {
  const path = resolve(value(reusePrepared ? '--resume-prepared-report' : '--resume-report'));
  const raw = await readFile(path);
  sourceReport = JSON.parse(raw);
  sourceCase = sourceReport.cases?.find(item => item.failedOperation?.status === 'failed' &&
    (reusePrepared ? item.completedOperation?.status === 'completed' : !item.completedOperation));
  sourceRun = sourceReport.runs?.find(run => run.runId === sourceCase?.runId);
  const requirement = sourceCase?.cacheBefore?.declarations?.find(item => item.path === 'requirements.txt');
  if (sourceReport.status !== 'incomplete' || !Number.isSafeInteger(sourceReport.modelCalls) || sourceReport.modelCalls < 1 || sourceReport.modelCalls > 8 || sourceReport.runs?.length !== 1 ||
      !/^ses_[a-f0-9-]{36}$/u.test(sourceReport.fixture?.sessionId ?? '') ||
      !/^wsp_[a-f0-9]{24}$/u.test(sourceReport.fixture?.originalWorkspaceId ?? '') ||
      !/^run_[a-f0-9-]{36}$/u.test(sourceRun?.runId ?? '') ||
      !/^op_[a-f0-9]{24}$/u.test(sourceCase?.failedOperation?.id ?? '') ||
      sourceCase.sessionId !== sourceReport.fixture.sessionId || sourceCase.failedOperation.workspaceId !== sourceReport.fixture.originalWorkspaceId ||
      sourceCase.failedOperation.error !== 'ENVIRONMENT_DECLARATION_MISSING' || !['completed', 'failed'].includes(sourceRun.status) ||
      !/^sha256:[a-f0-9]{64}$/u.test(requirement?.digest ?? '') || typeof requirement.content !== 'string' || requirement.truncated ||
      sourceReport.budgetDirectory && sourceReport.budgetDirectory !== value('--budget-dir') ||
      reusePrepared && (!/^op_[a-f0-9]{24}$/u.test(sourceCase.completedOperation.id) ||
        !/^wsp_[a-f0-9]{24}$/u.test(sourceCase.completedOperation.result?.workspace?.id ?? '') ||
        sourceCase.completedOperation.sourceRun !== sourceRun.runId || sourceCase.completedOperation.workspaceId !== sourceReport.fixture.originalWorkspaceId || sourceRun.status !== 'completed')) {
    throw new Error('Resume requires a bounded, terminal previous run and known declaration failure; no fixture or operation will be replayed.');
  }
  sourceReceipt = { path, sha256: createHash('sha256').update(raw).digest('hex'), revision: sourceReport.revision,
    modelCalls: sourceReport.modelCalls, status: sourceReport.status, priorRunId: sourceRun.runId,
    priorSessionId: sourceReport.fixture.sessionId, priorWorkspaceId: sourceReport.fixture.originalWorkspaceId,
    failedOperationId: sourceCase.failedOperation.id, requirementsDigest: requirement.digest,
    ...(reusePrepared ? { preparedOperationId: sourceCase.completedOperation.id, preparedWorkspaceId: sourceCase.completedOperation.result.workspace.id } : {}),
    cumulativePreviousModelCalls: sourceReport.modelCalls + (sourceReport.resume?.cumulativePreviousModelCalls ?? sourceReport.resume?.modelCalls ?? 0),
    ...(sourceReport.resume ? { previousSource: { path: sourceReport.resume.path, sha256: sourceReport.resume.sha256, priorRunId: sourceReport.resume.priorRunId } } : {}) };
}
const revision = value('--expected-revision');
const terminalStatuses = ['completed', 'failed', 'cancelled', 'interrupted'];
async function completedSweReceipt(path) {
  const ids = ['pytest-dev__pytest-5787', 'pytest-dev__pytest-5631', 'sympy__sympy-12481'];
  const exactIds = list => Array.isArray(list) && list.length === ids.length && new Set(list).size === ids.length && list.every(id => ids.includes(id));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const cache = await realpath(resolve(import.meta.dirname, '../.cache'));
  async function document(file, digest, initial = false) {
    if (typeof file !== 'string') throw new Error('Completed SWE evidence file is missing.');
    if (!initial && (typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest))) throw new Error('Completed SWE evidence checksum is missing.');
    const actual = await realpath(resolve(file));
    const rel = relative(cache, actual);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) throw new Error('Completed SWE evidence must be retained in repository .cache.');
    const raw = await readFile(actual);
    if (raw.length > 32000000 || digest !== undefined && hash(raw) !== digest) throw new Error('Completed SWE evidence checksum or size is invalid.');
    return { path: actual, sha256: hash(raw), value: JSON.parse(raw) };
  }
  const grade = await document(path, undefined, true);
  const grading = grade.value;
  if (grading.kind !== 'swebench-cloud-inference-official-grading' || grading.status !== 'graded-small-sample' ||
      grading.gradingComplete !== true || grading.lifecycleComplete !== true || grading.inferenceLifecycleIncomplete === true ||
      grading.graderVersion !== '3.0.15' || !exactIds(grading.selectedIds) || !exactIds(grading.submittedIds) ||
      !Array.isArray(grading.containerCleanup?.errors) || grading.containerCleanup.errors.length ||
      typeof grading.finishedAt !== 'string' || !Number.isFinite(Date.parse(grading.finishedAt))) {
    throw new Error('All three official SWE evaluations and their cleanup must be complete before releasing the reservation.');
  }
  const inferred = await document(grading.inferenceReport, grading.inferenceReportSha256);
  const inference = inferred.value;
  if (inference.kind !== 'swebench-verified-cloud-harness-inference' || inference.mode !== 'real' || inference.fakeModels !== false ||
      inference.fabricatedBusinessResponses !== false || !exactIds(inference.selectedIds) || !exactIds(inference.cases?.map(item => item.instance_id)) ||
      inference.expectedRuntimeRevision !== revision || inference.runtime?.build?.revision !== revision || inference.lifecycleIncomplete === true ||
      inference.datasetRevision !== 'c104f840cc67f8b6eec6f759ebc8b2693d585d4a' || grading.datasetRevision !== inference.datasetRevision ||
      inference.status !== 'cloud-inference-exported-awaiting-official-grading' || typeof inference.finishedAt !== 'string' ||
      !Number.isFinite(Date.parse(inference.finishedAt)) || Date.parse(inference.finishedAt) > Date.parse(grading.finishedAt)) {
    throw new Error('Completed SWE inference does not match all fixed samples and the current exact runtime.');
  }
  const runtime = await document(inference.runtimeEvidence?.file, inference.runtimeEvidence?.sha256);
  if (inference.runtimeEvidence?.source !== 'ordinary-cloud-runtime-API' || runtime.value.build?.revision !== revision) throw new Error('SWE runtime receipt is missing or changed.');
  const official = await document(grading.official?.file, grading.official?.sha256);
  const aggregate = official.value;
  if (aggregate.total_instances !== 3 || !exactIds(aggregate.submitted_ids) ||
      !Array.isArray(aggregate.error_ids) || aggregate.error_ids.length || !Array.isArray(aggregate.incomplete_ids) || aggregate.incomplete_ids.length ||
      !exactIds([...(aggregate.resolved_ids ?? []), ...(aggregate.unresolved_ids ?? []), ...(aggregate.empty_patch_ids ?? [])])) {
    throw new Error('Official aggregate does not account for all three fixed samples.');
  }
  const runs = [];
  for (const item of inference.cases) {
    if (!terminalStatuses.includes(item.runStatus) || !/^run_[a-f0-9-]{36}$/u.test(item.runId ?? '') ||
        !/^ses_[a-f0-9-]{36}$/u.test(item.sessionId ?? '') || !Number.isSafeInteger(item.sharedModelCalls) || item.sharedModelCalls < 1 ||
        item.runEvidence?.source !== 'ordinary-cloud-runs-API' || item.persisted?.source !== 'ordinary-cloud-session-events-API') {
      throw new Error('Every SWE sample needs a known terminal run and actual shared-call evidence.');
    }
    const run = await document(item.runEvidence.file, item.runEvidence.sha256);
    const transcript = await document(item.persisted.file, item.persisted.sha256);
    if (run.value.id !== item.runId || run.value.sessionId !== item.sessionId || run.value.status !== item.runStatus ||
        !Array.isArray(transcript.value) || transcript.value.some(event => event.sessionId !== item.sessionId || event.turnId !== item.runId) ||
        !transcript.value.some(event => ['turn.completed', 'turn.failed', 'turn.cancelled', 'turn.interrupted'].includes(event.type))) {
      throw new Error('SWE terminal receipt or persisted transcript identity changed.');
    }
    runs.push({ instanceId: item.instance_id, runId: item.runId, sessionId: item.sessionId, status: item.runStatus,
      sharedModelCalls: item.sharedModelCalls, runEvidenceSha256: run.sha256, persistedSha256: transcript.sha256 });
  }
  return { evidence: { gradingReport: grade.path, gradingReportSha256: grade.sha256, inferenceReport: inferred.path,
    inferenceReportSha256: inferred.sha256, officialFile: official.path, officialSha256: official.sha256, revision, selectedIds: ids, runs },
    configuration: inference.finalBudget?.configuration ?? inference.budget?.configuration };
}
const completedSweSource = completedSwe ? await completedSweReceipt(value('--completed-swe-report')) : undefined;
const driverRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' }).trim();
const driverSha256 = createHash('sha256').update(await readFile(import.meta.filename)).digest('hex');
const budget = validationBudget(value('--budget-dir'));
const output = resolve('.cache/execution-architecture-live', new Date().toISOString().replaceAll(':', '-') + '_' + randomUUID().slice(0, 8));
await mkdir(output, { recursive: true, mode: 0o700 });
const report = { revision, driverRevision, driverSha256, environment: 'server-hosted cloud / authenticated daoyintech account', mode: 'real', fakeModels: false,
  cases: [], runs: [], ...(sourceReceipt ? { resume: sourceReceipt } : {}), budgetDirectory: budget.directory,
  ...(completedSweSource ? { completedSwe: completedSweSource.evidence } : {}),
  ...(repairOnly ? { independentTaskValidation: 'not_run_budget_reserved' } : {}),
  startedAt: new Date().toISOString(), status: 'preflight', modelCalls: 0, cost: 'unknown', limits: {
    maxScenarioRequests: repairOnly ? 4 : reusePrepared ? 10 : resuming ? 15 : 20, reservedSweRequests: completedSwe ? 0 : 72,
    requiredRemainingRequests: completedSwe ? (repairOnly ? 4 : 10) : repairOnly ? 76 : reusePrepared ? 82 : resuming ? 87 : 92,
    runCalls: repairOnly ? [0, 4, 0] : reusePrepared ? [0, 6, 4] : resuming ? [5, 6, 4] : [8, 8, 4], maxToolCalls: 96, maxActiveMs: 600000, externalObservationMs: 420000 } };
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
  report.fixture = { name, operations: item.operations }; await save();
  item.sessionId = (await call('/sessions', { title: '真实通用架构验证 · ' + name })).session.id;
  item.budget = await budget.registerSession(item.sessionId);
  item.workspaceId = (await control(item, 'workspace_create', { title: name, source: { kind: 'empty' }, runtimeId: 'python313' })).workspace.id;
  item.originalWorkspaceId = item.workspaceId; report.fixture.sessionId = item.sessionId; report.fixture.originalWorkspaceId = item.workspaceId;
  for (const [path, content] of Object.entries(files)) await control(item, 'file_write', { path, ...(typeof content === 'string' ? { content } : content) });
  return item;
}
async function run(item, message, maxModelCalls, { continueFromRunId, cancelWhen } = {}) {
  const current = await call('/runtime');
  if (current.build?.revision !== revision) throw new Error('Runtime revision drifted; no further model run admitted.');
  await budget.registerSession(item.sessionId);
  const input = { requestId: randomUUID(), message, limits: { maxModelCalls, maxToolCalls: 96, maxActiveMs: 600000 }, ...(continueFromRunId ? { continueFromRunId } : {}) };
  const evidence = { input, modelCalls: 0, startedAt: new Date().toISOString(), events: [], status: 'admitting' };
  item.runs.push(evidence); report.runs.push(evidence); await save();
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
    report.modelCalls = report.runs.reduce((sum, run) => sum + run.modelCalls, 0);
    await save();
    evidence.costAdmission = await budget.settleRun(admitted.id);
    evidence.modelCalls = Math.max(evidence.events.filter(event => ['model.requested', 'capability.model.requested'].includes(event.type)).length, evidence.costAdmission.requestsReservedForRun);
    report.modelCalls = report.runs.reduce((sum, run) => sum + run.modelCalls, 0);
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
  report.modelCalls = report.runs.reduce((sum, run) => sum + run.modelCalls, 0);
  await save();
  evidence.costAdmission = await budget.settleRun(admitted.id);
  evidence.modelCalls = Math.max(evidence.events.filter(event => ['model.requested', 'capability.model.requested'].includes(event.type)).length, evidence.costAdmission.requestsReservedForRun);
  report.modelCalls = report.runs.reduce((sum, run) => sum + run.modelCalls, 0);
  if (evidence.modelCalls > maxModelCalls || report.modelCalls > report.limits.maxScenarioRequests) throw new Error('Final persisted model attempts exceeded the small-sample bound.');
  for (const event of evidence.events.filter(event => event.type === 'tool.completed' && ['environment_prepare', 'environment_read'].includes(event.payload.toolName))) {
    const operation = event.payload.evidence?.result?.operation;
    if (operation?.status === 'completed' && /^wsp_[a-f0-9]{24}$/u.test(operation.result?.workspace?.id ?? '')) item.workspaceId = operation.result.workspace.id;
  }
  await save(); return evidence;
}
const results = (run, name) => run.events.filter(event => event.type === 'tool.completed' && event.payload.toolName === name).map(event => event.payload.evidence?.result);
const outcome = run => run.events.findLast(event => event.type === 'turn.completed')?.payload.taskOutcome;
const plan = run => {
  const observed = run.events.findLast(event => event.type === 'task_plan.updated' || event.type === 'tool.completed' &&
    event.payload.toolName === 'task_plan' && event.payload.evidence?.result?.plan);
  return observed?.type === 'task_plan.updated' ? observed.payload.plan : observed?.payload.evidence?.result?.plan;
};
const invariant = (condition, message) => { if (!condition) throw new Error(message); };
// An independently authored, genuine installable package fixture. No network or fabricated tool response.
const wheel = () => execFileSync('python3', ['-c', String.raw`import io,zipfile,base64,csv,hashlib
files={'architecture_dependency.py': 'from decimal import Decimal\nFACTOR = Decimal("1.1")\n',
'architecture_dependency-0.1.0.dist-info/METADATA': 'Metadata-Version: 2.1\nName: architecture-dependency\nVersion: 0.1.0\n',
'architecture_dependency-0.1.0.dist-info/WHEEL': 'Wheel-Version: 1.0\nGenerator: independently-authored-fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n'}
record=io.StringIO(); writer=csv.writer(record,lineterminator='\n')
for name,body in files.items():
 raw=body.encode(); writer.writerow([name,'sha256='+base64.urlsafe_b64encode(hashlib.sha256(raw).digest()).decode().rstrip('='),len(raw)])
writer.writerow(['architecture_dependency-0.1.0.dist-info/RECORD','','']); files['architecture_dependency-0.1.0.dist-info/RECORD']=record.getvalue()
output=io.BytesIO()
with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED) as archive:
 for name,body in files.items(): archive.writestr(name,body)
print(base64.b64encode(output.getvalue()).decode())`], { encoding: 'utf8' }).trim();
let item;
try {
  report.authentication = await client.login(await readHiddenCredentials());
  report.budget = await budget.inspect(); report.model = report.budget.configuration;
  report.limits.maxTotalSharedRequests = report.budget.maxRequests;
  report.limits.maxCny = report.budget.maxMicroCny / 1000000;
  invariant(report.budget.maxRequests === 100 && report.budget.maxMicroCny === 5000000, 'The separately authorized 100-request / 5-CNY ledger is required.');
  invariant(report.model.provider === 'deepseek' && report.model.model === 'deepseek-flash', 'Frozen actual model differs from the authorized model.');
  invariant(report.budget.maxRequests - report.budget.requestsReserved >= report.limits.requiredRemainingRequests, 'Insufficient request allowance for the bounded mechanisms and remaining SWE reservation.');
  invariant((await call('/runtime')).build?.revision === revision, 'Expected cloud revision not deployed.');
  if (completedSweSource) {
    invariant(completedSweSource.configuration && ['provider', 'model', 'modelConfigurationSha256', 'pricingSha256'].every(key =>
      completedSweSource.configuration[key] === report.model[key]), 'Completed SWE uses another frozen model or pricing configuration.');
    report.completedSwe.budgetDirectory = budget.directory;
    for (const recorded of report.completedSwe.runs) {
      const actual = (await call(`/runs/${recorded.runId}`)).run;
      invariant(actual.id === recorded.runId && actual.sessionId === recorded.sessionId && terminalStatuses.includes(actual.status) && actual.status === recorded.status,
        'SWE run is not actually in its recorded terminal state; no further model run admitted.');
      const admission = await budget.settleRun(recorded.runId);
      invariant(admission.requestsReservedForRun === recorded.sharedModelCalls, 'Completed SWE was not reserved in this active validation ledger.');
      recorded.ledgerProof = { requestsReservedForRun: admission.requestsReservedForRun, ledgerSha256: admission.ledgerSha256 };
    }
  }
  report.status = 'running'; await save();
  const originalExport = 'import sys\nfrom decimal import Decimal\nif sys.version_info[:2] != (3, 11):\n    raise RuntimeError("project requires Python 3.11")\nfrom architecture_dependency import FACTOR\ndef total():\n    return sum([Decimal("3"), Decimal("4")])\nif __name__ == "__main__":\n    print(total())\n';
  const check = 'from decimal import Decimal\nfrom export import total\nassert total() == Decimal("7.7"), ("service-fee total", total())\nprint("focused-check-passed")\n';
  let observedOriginalFailure;
  let first;
  let observedPreparedOperation;
  let continuationRunId;
  if (reusePrepared) {
    item = { name: '复用已成功环境并继续验证', sessionId: sourceReceipt.priorSessionId,
      workspaceId: sourceReceipt.preparedWorkspaceId, originalWorkspaceId: sourceReceipt.priorWorkspaceId,
      operations: [], runs: [], status: 'resuming-prepared' };
    report.fixture = { name: item.name, sessionId: item.sessionId, originalWorkspaceId: item.originalWorkspaceId,
      preparedWorkspaceId: item.workspaceId, operations: item.operations };
    const prior = (await call(`/runs/${sourceReceipt.priorRunId}`)).run;
    invariant(prior.id === sourceReceipt.priorRunId && prior.sessionId === item.sessionId && prior.status === 'completed', 'Prepared run is not actually completed.');
    observedOriginalFailure = (await control(item, 'environment_read', { workspaceId: item.originalWorkspaceId, operationId: sourceReceipt.failedOperationId, waitMs: 0 })).operation;
    observedPreparedOperation = (await control(item, 'environment_read', { workspaceId: item.originalWorkspaceId, operationId: sourceReceipt.preparedOperationId, waitMs: 0 })).operation;
    invariant(observedOriginalFailure?.status === 'failed' && observedOriginalFailure.id === sourceReceipt.failedOperationId &&
      observedPreparedOperation?.status === 'completed' && observedPreparedOperation.id === sourceReceipt.preparedOperationId &&
      observedPreparedOperation.result?.workspace?.id === item.workspaceId && observedPreparedOperation.sourceRun === prior.id,
      'Previously prepared candidate no longer matches the real operation receipt.');
    // Retained actual evidence has an explicit source report; it is never submitted to the Agent as a replay.
    first = sourceRun;
    report.referencedRuns = [{ sourceReportSha256: sourceReceipt.sha256, revision: sourceReport.revision, ...sourceRun }];
    // A failed validation may have created a later, genuine continuation. Resume
    // the current tip only if its trusted admission chain reaches this preparation.
    const history = (await call(`/sessions/${item.sessionId}/runs`)).runs;
    invariant(Array.isArray(history) && history.length > 0, 'Current session run history is unavailable.');
    let tip = history[0];
    continuationRunId = tip.id;
    const seen = new Set();
    const chain = [];
    while (tip.id !== prior.id) {
      invariant(tip.sessionId === item.sessionId && !['running', 'queued'].includes(tip.status) &&
        !seen.has(tip.id) && typeof tip.admission?.continueFromRunId === 'string' && seen.size < 32,
      'Current task tip is unrelated, active or has no trusted continuation ancestry.');
      seen.add(tip.id); chain.push({ runId: tip.id, continueFromRunId: tip.admission.continueFromRunId, status: tip.status });
      tip = (await call(`/runs/${tip.admission.continueFromRunId}`)).run;
    }
    report.resumedTaskTip = { runId: continuationRunId, preparedRunId: prior.id, chain }; await save();
  } else if (resuming) {
    item = { name: '原会话环境准备修复与继续验证', sessionId: sourceReceipt.priorSessionId,
      workspaceId: sourceReceipt.priorWorkspaceId, originalWorkspaceId: sourceReceipt.priorWorkspaceId,
      operations: [], runs: [], status: 'resuming' };
    report.fixture = { name: item.name, sessionId: item.sessionId, originalWorkspaceId: item.originalWorkspaceId, operations: item.operations };
    const prior = (await call(`/runs/${sourceReceipt.priorRunId}`)).run;
    invariant(prior.id === sourceReceipt.priorRunId && prior.sessionId === item.sessionId && !['running', 'queued'].includes(prior.status), 'Original run has not reached a known terminal state.');
    observedOriginalFailure = (await control(item, 'environment_read', { operationId: sourceReceipt.failedOperationId, waitMs: 0 })).operation;
    invariant(observedOriginalFailure?.id === sourceReceipt.failedOperationId && observedOriginalFailure.status === 'failed' && observedOriginalFailure.workspaceId === item.originalWorkspaceId &&
      observedOriginalFailure.error === 'ENVIRONMENT_DECLARATION_MISSING', 'Original preparation no longer matches the observed declaration failure.');
    report.resume.requirements = await control(item, 'file_read', { path: 'requirements.txt' });
    const requirements = report.resume.requirements.content ?? report.resume.requirements.text;
    invariant(typeof requirements === 'string' && 'sha256:' + createHash('sha256').update(requirements).digest('hex') === sourceReceipt.requirementsDigest,
      'Existing declaration differs from its actual previous digest; do not overwrite it or repeat the previous task.');
    first = await run(item, `继续原任务。原工作区是 ${item.originalWorkspaceId}；之前实际失败的环境操作 ${sourceReceipt.failedOperationId} 仅因缺少依赖声明失败。requirements.txt 已正确写入，保留它和其他产物，不重建工作区、不重复之前失败请求、不再次写 requirements.txt。先读取保存的计划、现有声明和原 operation 实际结果，再从 runtime_list 选择项目声明的 Python 3.11。environment_prepare 必须显式传 retryFromOperationId="${sourceReceipt.failedOperationId}"、installDependencies=true，源 workspaceId="${item.originalWorkspaceId}"，以新请求创建候选。观察同一新 operation，成功后在新工作区真实核对 Python 3.11、architecture_dependency 导入位置和 cacheKey。保留 export.py 修改和 focused check 为下一轮未完成项，如实报告 partial。`, report.limits.runCalls[0], { continueFromRunId: sourceReceipt.priorRunId });
  } else {
    item = await fixture('准备重试、环境缓存与任务边界', { '.python-version': '3.11\n', 'export.py': originalExport,
    'check_export.py': check, 'CONTRIBUTING.md': 'Declared runtime: .python-version. Focused check: python check_export.py. Keep interpreter constraints and assertions unchanged.\n',
    'vendor/architecture_dependency-0.1.0-py3-none-any.whl': { contentBase64: wheel() } });
    first = await run(item, `工作区 ${item.workspaceId} 的长期目标是让 export.py 输出含 10% 服务费的总额并实际验证。本轮只做环境准备，保留代码修改与 focused check 为未完成步骤并报告 partial。先用 task_plan 保存长期目标和两个阶段，检查真实运行时和项目声明，用 runtime_list 选择 Python 3.11。先请求一次 installDependencies=true 的 environment_prepare，验证缺少依赖声明时会得到真实失败回执；观察同一 operation，不重放请求。随后从现有 vendor 文件确定本项目唯一依赖，在原工作区创建 requirements.txt 指向实际 wheel。用真实失败 operationId 作为 retryFromOperationId 明确重试，等待新候选成功，实际确认 Python 3.11 和 architecture_dependency 导入成功，记录 environment_inspect 的 cacheKey 与真实证据。不要修改 export.py 或 check_export.py；代码修复与验证在下一轮继续。`, 8);
  }
  const firstCase = { name: '环境声明失败后显式修复重试', sessionId: item.sessionId, workspaceId: item.workspaceId, runId: first.runId,
    ...(reusePrepared ? { reusedExistingRun: true, sourceReportSha256: sourceReceipt.sha256, newModelCalls: 0 } : {}), status: 'failed' };
  report.cases.push(firstCase);
  const operations = [...results(first, 'environment_prepare'), ...results(first, 'environment_read')].map(result => result?.operation).filter(Boolean);
  const failed = observedOriginalFailure ?? operations.find(operation => operation.status === 'failed');
  const completed = observedPreparedOperation ?? operations.find(operation => operation.status === 'completed');
  const started = first.events.filter(event => event.type === 'tool.started' && event.payload.toolName === 'environment_prepare');
  firstCase.failedOperation = failed; firstCase.completedOperation = completed;
  firstCase.explicitRetry = started.some(event => event.payload.input?.retryFromOperationId === failed?.id);
  firstCase.cacheBefore = await control(item, 'environment_inspect');
  firstCase.dependency = await control(item, 'process_run', { executable: 'python', args: ['-c', 'import sys,site,architecture_dependency; assert sys.version_info[:2]==(3,11); print(architecture_dependency.FACTOR); print(site.getusersitepackages()); print(architecture_dependency.__file__)'], cwd: '.', timeoutMs: 30000 });
  firstCase.originalSource = await control(item, 'file_read', { workspaceId: item.originalWorkspaceId, path: 'export.py' });
  invariant(failed && completed && failed.id !== completed.id && firstCase.explicitRetry && item.workspaceId !== item.originalWorkspaceId, 'Known failure and new successful candidate were not both observed.');
  invariant((firstCase.originalSource.content ?? firstCase.originalSource.text) === originalExport, 'A failed or successful preparation modified original source code.');
  invariant(firstCase.dependency.exitCode === 0 && /1\.1/.test(firstCase.dependency.stdout ?? '') && (firstCase.dependency.stdout ?? '').includes(firstCase.cacheBefore.cacheKey), 'Prepared dependency is not actually loaded from the selected environment cache.');
  firstCase.savedPlan = plan(first);
  invariant(outcome(first) === 'partial' && firstCase.savedPlan?.steps.some(step => ['pending', 'in_progress'].includes(step.status)) &&
    firstCase.savedPlan.steps.every(step => ['pending', 'in_progress', 'completed', 'blocked'].includes(step.status)), 'Preparation did not retain a valid partial plan for the actual unfinished code task.');
  firstCase.status = 'passed'; await save();

  const resumed = await run(item, `继续原任务，使用已成功准备的工作区 ${item.workspaceId}，复用实际环境，不重新准备候选或安装依赖。先读保存的计划与产物。按 CONTRIBUTING.md 先实际运行 focused check，用稳定 verification 名称 price-export；根据真实失败输出修复 export.py，使总额含 10% 服务费，保留解释器约束和测试断言。更新 CONTRIBUTING.md 说明已验证的用法，并创建 pytest.ini 仅保存测试选择声明。环境依赖与版本声明不改变。修改后用相同 verification 名称重跑同一 focused check，实际检查导入的依赖位置和 environment_inspect cacheKey，再完成计划。如实区分最初失败、修复和最终验证。`, report.limits.runCalls[1], { continueFromRunId: continuationRunId ?? first.runId });
  const secondCase = { name: '继续任务、失败验证修复与诊断编辑保留缓存', sessionId: item.sessionId, workspaceId: item.workspaceId, runId: resumed.runId, status: 'failed' };
  report.cases.push(secondCase);
  secondCase.cacheAfter = await control(item, 'environment_inspect');
  secondCase.actual = await control(item, 'process_run', { executable: 'python', args: ['check_export.py'], cwd: '.', timeoutMs: 30000 });
  secondCase.caller = await control(item, 'process_run', { executable: 'python', args: ['export.py'], cwd: '.', timeoutMs: 30000 });
  secondCase.checkSource = await control(item, 'file_read', { path: 'check_export.py' });
  secondCase.versionDeclaration = await control(item, 'file_read', { path: '.python-version' });
  secondCase.dependency = await control(item, 'process_run', { executable: 'python', args: ['-c', 'import architecture_dependency; print(architecture_dependency.__file__)'], cwd: '.', timeoutMs: 30000 });
  const checks = resumed.events.filter(event => event.type === 'tool.completed').map(event => event.payload.evidence?.processObservation).filter(observation => observation?.verification === 'price-export' && observation.exitCode !== null);
  secondCase.checks = checks;
  invariant(checks.some(observation => observation.exitCode !== 0) && checks.at(-1)?.exitCode === 0, 'The actual named failing check and repaired rerun were not both observed.');
  invariant(secondCase.actual.exitCode === 0 && /focused-check-passed/.test(secondCase.actual.stdout ?? ''), 'Final actual focused check did not pass.');
  invariant(secondCase.caller.exitCode === 0 && (secondCase.caller.stdout ?? '').trim() === '7.7' &&
    (secondCase.checkSource.content ?? secondCase.checkSource.text) === check && (secondCase.versionDeclaration.content ?? secondCase.versionDeclaration.text) === '3.11\n', 'Caller compatibility, original assertion or declared runtime was weakened.');
  invariant(firstCase.cacheBefore.cacheKey === secondCase.cacheAfter.cacheKey && secondCase.dependency.exitCode === 0 && (secondCase.dependency.stdout ?? '').includes(firstCase.cacheBefore.cacheKey), 'Source or diagnostic edits invalidated the unchanged dependency cache.');
  invariant(outcome(resumed) === 'completed' && plan(resumed)?.steps.length > 0 && plan(resumed).steps.every(step => step.status === 'completed'), 'Successful repair did not clear the task-scoped unfinished work.');
  secondCase.status = 'passed'; await save();

  if (repairOnly) {
    report.cases.push({ name: '同会话独立任务的计划和验证隔离', sessionId: item.sessionId, workspaceId: item.workspaceId,
      status: 'not_run_budget_reserved', reason: completedSwe ? 'Only the four-call repair scope was admitted from the remaining allowance.'
        : 'Remaining 72 shared requests reserved for the fixed SWE sample.' });
    item.status = 'passed-repair-only'; report.status = 'passed-repair-only';
  } else {
  const independent = await run(item, `这是同会话中的独立新任务，不是上一任务续跑。第一步用 task_plan read 读取本任务状态，确认初始版本为 0；随后在工作区 ${item.workspaceId} 读取 .python-version，生成 runtime-audit.txt，内容只包含当前声明的版本和工作区编号，不修改现有源代码。创建并完成本任务自己的计划，引用真实文件证据。`, 4);
  const thirdCase = { name: '同会话独立任务的计划和验证隔离', sessionId: item.sessionId, workspaceId: item.workspaceId, runId: independent.runId, status: 'failed' };
  report.cases.push(thirdCase);
  thirdCase.initialPlanRead = results(independent, 'task_plan').find(result => result?.currentVersion === 0 && result?.plan === null);
  thirdCase.artifact = await control(item, 'file_read', { path: 'runtime-audit.txt' });
  const audit = thirdCase.artifact.content ?? thirdCase.artifact.text ?? '';
  invariant(thirdCase.initialPlanRead && plan(independent)?.version >= 1, 'An independent run inherited the preceding task plan.');
  invariant(/3\.11/.test(audit) && audit.includes(item.workspaceId) && outcome(independent) === 'completed', 'Independent task artifact or truthful completion was not observed.');
  thirdCase.status = 'passed'; item.status = 'passed'; report.status = 'passed-small-sample';
  }
} catch (error) {
  report.status = 'incomplete'; report.failure = { code: error.code ?? error.name, message: String(error.message).slice(0, 600), ...(error.publicFailure ? { publicFailure: error.publicFailure } : {}) };
  if (active) { try { await call(`/runs/${active}/cancel`, {}); report.cancelRequested = active; } catch { report.cancelUnconfirmed = active; } }
} finally {
  try { report.finalBudget = await budget.inspect(); report.cost = { settledCny: report.finalBudget.settledMicroCny / 1000000, conservativeCommittedCny: report.finalBudget.committedMicroCny / 1000000, unknownReservations: report.finalBudget.unsettledReservations }; } catch { report.cost = 'unknown'; }
  client.close(); report.finishedAt = new Date().toISOString(); await save();
}
console.log(JSON.stringify({ output, status: report.status, modelCalls: report.modelCalls, cases: report.cases.map(item => ({ name: item.name, status: item.status })), cost: report.cost }));
process.exitCode = ['passed-small-sample', 'passed-repair-only'].includes(report.status) ? 0 : 1;
