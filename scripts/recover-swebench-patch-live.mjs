// Recover an existing, terminal real-model workspace patch. Never call a model or retry git add.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createCloudAccountClient, readHiddenCredentials, sanitizeEvidence } from './cloud-live-client.mjs';

const root = await realpath(resolve(import.meta.dirname, '..'));
const args = process.argv.slice(2);
if (args.length !== 3 || args[0] !== '--run' || args[1] !== '--report') {
  console.log(JSON.stringify({ status: 'prepared-no-login-no-model', usage: 'node scripts/recover-swebench-patch-live.mjs --run --report ACTUAL_ORIGINAL_REPORT' }));
  process.exit(0);
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = code => Object.assign(new Error('Existing workspace patch recovery did not satisfy its scoped evidence contract.'), { code });
async function cachedFile(path, maximum = 16 * 1024 * 1024) {
  const actual = await realpath(resolve(root, path));
  const scope = relative(join(root, '.cache'), actual);
  const info = await lstat(actual);
  if (isAbsolute(scope) || scope === '..' || scope.startsWith(`..${sep}`) || !info.isFile() || info.size > maximum) throw failure('SWE_RECOVERY_LOCAL_EVIDENCE_INVALID');
  const bytes = await readFile(actual);
  if (bytes.length !== info.size) throw failure('SWE_RECOVERY_LOCAL_EVIDENCE_CHANGED');
  return { file: actual, bytes };
}
const sourceFile = await cachedFile(args[2]);
const sourceReport = JSON.parse(sourceFile.bytes.toString('utf8'));
const sourceCase = sourceReport.cases?.find(item => item.instance_id === 'pytest-dev__pytest-5631');
if (sourceReport.kind !== 'swebench-verified-cloud-harness-inference' || sourceReport.mode !== 'real' ||
    sourceReport.fakeModels !== false || sourceReport.fabricatedBusinessResponses !== false || !sourceCase ||
    !/^run_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(sourceCase.runId ?? '') ||
    !/^wsp_[a-f0-9]{24}$/u.test(sourceCase.workspaceId ?? '') ||
    !/^ses_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(sourceCase.sessionId ?? '') || sourceCase.runStatus !== 'cancelled' ||
    !(sourceCase.modelCalls > 0) || sourceCase.error?.code !== 'SWE_GIT_SETUP_PROCESS_RECOVERY_FAILED' ||
    sourceCase.baseCommit !== 'cb828ebe70b4fa35cd5f9a7ee024272237eab351') throw failure('SWE_RECOVERY_ORIGINAL_CASE_INVALID');
const originalOperation = sourceCase.operations?.findLast(operation => operation.action === 'process_run' &&
  operation.recovery?.status === 'stopped-without-resubmission');
const failedRequestId = originalOperation?.requestId;
if (!/^swe_[a-f0-9]{32}$/u.test(failedRequestId ?? '')) throw failure('SWE_RECOVERY_ORIGINAL_REQUEST_ID_INVALID');
if (originalOperation?.recovery?.mutatingResubmissions !== 0 || originalOperation.recovery.status !== 'stopped-without-resubmission') throw failure('SWE_RECOVERY_ORIGINAL_OPERATION_INVALID');
const originalRequest = await cachedFile(originalOperation.requestEvidence.file, 128 * 1024);
if (hash(originalRequest.bytes) !== originalOperation.requestEvidence.sha256) throw failure('SWE_RECOVERY_ORIGINAL_REQUEST_CHANGED');
const request = JSON.parse(originalRequest.bytes.toString('utf8')).request;
if (request.action !== 'process_run' || request.executable !== 'git' || request.args?.[0] !== 'add' || request.args?.[1] !== '-N' ||
    request.workspaceId !== sourceCase.workspaceId || request.sessionId !== sourceCase.sessionId) throw failure('SWE_RECOVERY_ORIGINAL_COMMAND_INVALID');
const excludedExportFile = sourceCase.excludedRuntimePaths?.at(-1);
if (!/^__harness_prediction_[a-f0-9]{32}\.patch$/u.test(excludedExportFile ?? '') ||
    request.args.at(-1) !== `:(top,exclude,literal)${excludedExportFile}`) throw failure('SWE_RECOVERY_RUNTIME_EXCLUSION_INVALID');

const output = join(root, '.cache/swebench-patch-recovery', new Date().toISOString().replaceAll(':', '-') + '_' + randomUUID().slice(0, 8));
await mkdir(output, { recursive: true, mode: 0o700 });
const report = { kind: 'swebench-existing-cloud-workspace-patch-recovery', mode: 'real', output,
  sourceReport: { file: sourceFile.file, sha256: hash(sourceFile.bytes) },
  originalRequest: { file: originalRequest.file, sha256: hash(originalRequest.bytes), requestId: failedRequestId },
  instance_id: sourceCase.instance_id, repo: sourceCase.source?.repo ?? 'pytest-dev/pytest', baseCommit: sourceCase.baseCommit,
  originalInferenceRevision: sourceReport.expectedRuntimeRevision, originalRunId: sourceCase.runId,
  originalRunStatus: sourceCase.runStatus, originalFailure: sourceCase.error,
  originalModelCalls: sourceCase.modelCalls, originalSharedModelCalls: sourceCase.sharedModelCalls,
  workspaceId: sourceCase.workspaceId, sessionId: sourceCase.sessionId,
  newModelCalls: 0, originalRunReplayed: false, originalGitAddReplayed: false, sourceIndexHistoryWritesAllowed: false,
  modelIdentity: 'unknown', tokens: 'unknown', cost: 'unknown', operations: [], status: 'preflight', startedAt: new Date().toISOString() };
const save = () => writeFile(join(output, 'report.json'), JSON.stringify(sanitizeEvidence(report), null, 2) + '\n', { mode: 0o600 });
await save();
const controller = new AbortController();
const stop = () => controller.abort(new Error('Operator cancelled scoped patch recovery.'));
const timer = setTimeout(() => controller.abort(new Error('Scoped patch recovery deadline exceeded.')), 600_000);
process.once('SIGINT', stop); process.once('SIGTERM', stop);
const client = createCloudAccountClient({ signal: controller.signal });
const publicInspection = value => ({ summary: value.summary, workspace: { id: value.workspace?.id, state: value.workspace?.state, runtime: value.workspace?.runtime },
  events: value.events?.filter(event => event.requestId === failedRequestId).map(event => ({ sequence: event.sequence,
    sessionId: event.sessionId, requestId: event.requestId, eventType: event.eventType, occurredAt: event.occurredAt, payload: event.payload })) });
async function call(path, body, { timeoutMs = 20_000, select = value => value } = {}) {
  const number = String(report.operations.length + 1).padStart(4, '0');
  const operation = { path, action: body?.action ?? 'read', at: new Date().toISOString(), ...(body?.requestId ? { requestId: body.requestId } : {}) };
  report.operations.push(operation);
  const requestText = JSON.stringify(sanitizeEvidence({ path, request: body ?? null }), null, 2) + '\n';
  const requestFile = join(output, `${number}-request.json`);
  await writeFile(requestFile, requestText, { mode: 0o600, flag: 'wx' });
  operation.requestEvidence = { file: requestFile, sha256: hash(requestText) };
  await save();
  try {
    const response = await client.request(path, body, { timeoutMs });
    const responseText = JSON.stringify(sanitizeEvidence({ at: new Date().toISOString(), status: response.status, result: select(response.result) }), null, 2) + '\n';
    const responseFile = join(output, `${number}-response.json`);
    await writeFile(responseFile, responseText, { mode: 0o600, flag: 'wx' });
    operation.responseEvidence = { file: responseFile, sha256: hash(responseText), source: 'ordinary-authenticated-cloud-API' };
    operation.status = 'response-received';
    await save();
    return response.result;
  } catch (error) {
    operation.status = 'failed-no-resubmission';
    operation.failure = { code: error.publicFailure?.code ?? error.code ?? error.name,
      ...(error.publicFailure ? { publicFailure: error.publicFailure } : {}) };
    await save();
    throw error;
  }
}
const control = (action, fields = {}, timeoutMs = 135_000) => call('/resources/control', { action, sessionId: report.sessionId,
  workspaceId: report.workspaceId, requestId: `swe_recovery_${randomUUID().replaceAll('-', '')}`, ...fields },
{ timeoutMs, ...(action === 'workspace_inspect' ? { select: publicInspection } : {}) });
const sandboxProcess = async (executable, commandArgs) => {
  const value = await control('process_run', { executable, args: commandArgs, cwd: '.', timeoutMs: 30_000,
    environment: { GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }, 45_000);
  if (value.exitCode !== 0 || value.sandbox !== 'gVisor' || value.timedOut !== false || typeof value.stdout !== 'string' || Buffer.byteLength(value.stdout) > 500_000) throw failure('SWE_RECOVERY_READ_PROCESS_FAILED');
  return value;
};
const git = commandArgs => sandboxProcess('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '--no-pager', ...commandArgs]);
const indexProbe = String.raw`import configparser,hashlib,json,pathlib,stat
if not stat.S_ISDIR(pathlib.Path('.git').lstat().st_mode): raise SystemExit('Git metadata directory differs from prepared source')
p=pathlib.Path('.git/index');info=p.lstat()
if not stat.S_ISREG(info.st_mode) or info.st_size>33554432: raise SystemExit('Index metadata unavailable')
cfg=pathlib.Path('.git/config');cfginfo=cfg.lstat()
if not stat.S_ISREG(cfginfo.st_mode) or cfginfo.st_size>65536: raise SystemExit('Git configuration unavailable')
config=configparser.ConfigParser(interpolation=None,strict=True);config.read('.git/config')
if config.defaults() or config.sections()!=['core'] or dict(config['core'])!={'repositoryformatversion':'0','filemode':'true','bare':'false','logallrefupdates':'false'}: raise SystemExit('Git execution configuration differs from normalized source')
if pathlib.Path('.harness/home/.gitconfig').exists(): raise SystemExit('Unexpected runtime Git configuration')
print(json.dumps({'indexSha256':hashlib.sha256(p.read_bytes()).hexdigest(),'indexBytes':info.st_size,'gitConfigSafe':True}))`;
const sourcePaths = ['.', ':(top,exclude).harness', ':(top,exclude,glob).harness-restore-*', ':(top,exclude,glob).harness-restore-*/**',
  ':(top,exclude)lost+found', `:(top,exclude,literal)${excludedExportFile}`];
let stage = 'sign-in';
try {
  console.log(JSON.stringify({ status: 'ready-for-hidden-ordinary-account-json', output, modelCalls: 0 }));
  await client.login(await readHiddenCredentials({ signal: controller.signal }));
  stage = 'actual-terminal-and-original-failure-verification';
  const runtimeBefore = await call('/runtime');
  if (!/^[a-f0-9]{40}$/u.test(runtimeBefore.build?.revision ?? '')) throw failure('SWE_RECOVERY_RUNTIME_RECEIPT_INVALID');
  report.recoveryRuntimeRevision = runtimeBefore.build.revision;
  const terminal = (await call(`/runs/${report.originalRunId}`, undefined, { select: value => ({ run: {
    id: value.run?.id, sessionId: value.run?.sessionId, status: value.run?.status, finishedAt: value.run?.finishedAt } }) })).run;
  if (terminal?.id !== report.originalRunId || terminal.sessionId !== report.sessionId || terminal.status !== 'cancelled') throw failure('SWE_RECOVERY_ORIGINAL_RUN_NOT_TERMINAL');
  report.actualOriginalTerminal = { id: terminal.id, sessionId: terminal.sessionId, status: terminal.status, finishedAt: terminal.finishedAt };
  const inspected = await control('workspace_inspect');
  if (inspected.workspace?.id !== report.workspaceId || inspected.workspace.state !== 'ready') throw failure('SWE_RECOVERY_WORKSPACE_NOT_READY');
  const audits = inspected.events?.filter(event => event.requestId === failedRequestId) ?? [];
  const requested = audits.filter(event => event.eventType === 'operation.requested');
  const failed = audits.filter(event => event.eventType === 'operation.failed');
  if (requested.length !== 1 || failed.length !== 1 || audits.some(event => event.eventType === 'operation.completed') ||
      audits.some(event => event.sessionId !== report.sessionId) || failed[0].payload?.code !== 'EGRESS_UNAVAILABLE' ||
      requested[0].payload?.workspaceId !== report.workspaceId || requested[0].payload?.executable !== 'git' ||
      JSON.stringify(requested[0].payload?.args) !== JSON.stringify(request.args)) throw failure('SWE_RECOVERY_ORIGINAL_FAILURE_AUDIT_INVALID');
  report.actualOriginalFailure = { requestSequence: requested[0].sequence, failedSequence: failed[0].sequence, code: failed[0].payload.code,
    failedAt: failed[0].occurredAt, originalMutationResubmissions: 0 };
  stage = 'read-only-head-index-and-source-scope';
  const indexBefore = JSON.parse((await sandboxProcess('python', ['-c', indexProbe])).stdout);
  const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  if (head !== report.baseCommit) throw failure('SWE_RECOVERY_HEAD_CHANGED');
  const nativeLog = await control('git_log', { maximumBytes: 100_000 });
  if (nativeLog.exitCode !== 0 || nativeLog.sandbox !== 'gVisor') throw failure('SWE_RECOVERY_GIT_LOG_INVALID');
  report.actualHead = head;
  const reserved = name => name === '.harness' || name.startsWith('.harness/') || name === 'lost+found' || name.startsWith('lost+found/') || name.startsWith('.harness-restore-');
  const basePaths = (await git(['ls-tree', '-r', '--name-only', '-z', report.baseCommit])).stdout.split('\0').filter(Boolean);
  const trackedPaths = (await git(['ls-files', '-z'])).stdout.split('\0').filter(Boolean);
  if (basePaths.some(reserved) || trackedPaths.some(reserved)) throw failure('SWE_RECOVERY_RESERVED_TRACKED_PATH');
  const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...sourcePaths])).stdout.split('\0').filter(Boolean);
  report.untrackedNonRuntimePaths = untracked;
  if (untracked.length) throw failure('SWE_RECOVERY_UNTRACKED_SOURCE_NOT_EXPORTED');
  const status = await git(['status', '--porcelain=v1', '--untracked-files=all', '--', ...sourcePaths]);
  report.actualSourceStatus = status.stdout;
  report.reservedRuntimePathsTracked = false;
  report.excludedRuntimePaths = sourceCase.excludedRuntimePaths;
  report.sourceScope = 'Tracked source against exact base; ordinary Git ignored and reserved runtime paths excluded from untracked-source check.';
  stage = 'actual-native-base-diff-and-immutable-patch-export';
  const diff = await control('git_diff', { revision: report.baseCommit, maximumBytes: 500_000 });
  if (diff.exitCode !== 0 || diff.sandbox !== 'gVisor' || typeof diff.stdout !== 'string' || Buffer.byteLength(diff.stdout) > 500_000) throw failure('SWE_RECOVERY_BASE_DIFF_INVALID');
  const artifact = (await control('git_export_patch', { sourceRun: report.originalRunId, maximumBytes: 500_000 })).artifact;
  if (!/^art_[a-f0-9]{24}$/u.test(artifact?.id ?? '') || artifact.workspaceId !== report.workspaceId ||
      !Number.isSafeInteger(artifact.size) || artifact.size > 500_000 || !/^sha256:[a-f0-9]{64}$/u.test(artifact.blobHash ?? '')) throw failure('SWE_RECOVERY_ARTIFACT_INVALID');
  const exported = await control('artifact_read', { artifactId: artifact.id, maximumBytes: 500_000 });
  const bytes = Buffer.from(exported.contentBase64 ?? '', 'base64');
  if (exported.artifact?.id !== artifact.id || exported.artifact.workspaceId !== report.workspaceId ||
      exported.artifact.size !== bytes.length || artifact.size !== bytes.length || exported.artifact.blobHash !== artifact.blobHash ||
      `sha256:${hash(bytes)}` !== artifact.blobHash || !bytes.equals(Buffer.from(diff.stdout))) throw failure('SWE_RECOVERY_PATCH_BYTES_MISMATCH');
  const indexAfter = JSON.parse((await sandboxProcess('python', ['-c', indexProbe])).stdout);
  const headAfter = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  if (headAfter !== head || JSON.stringify(indexBefore) !== JSON.stringify(indexAfter)) throw failure('SWE_RECOVERY_INDEX_OR_HEAD_CHANGED');
  const runtimeAfter = await call('/runtime');
  if (runtimeAfter.build?.revision !== report.recoveryRuntimeRevision) throw failure('SWE_RECOVERY_RUNTIME_CHANGED');
  const patchFile = join(output, 'prediction.patch');
  await writeFile(patchFile, bytes, { flag: 'wx', mode: 0o600 });
  report.patch = { file: patchFile, sha256: hash(bytes), bytes: bytes.length, artifactId: artifact.id, artifactBlobHash: artifact.blobHash,
    actualNativeExport: true, exactBaseDiffBytesMatch: true, completeTrackedSourceScope: true };
  report.indexEvidence = { before: indexBefore, after: indexAfter, unchanged: true };
  report.status = bytes.length ? 'actual-existing-patch-recovered' : 'actual-existing-empty-patch-recovered';
  report.inferenceOutcomeUnchanged = 'Original run remains cancelled; this export does not claim a completed model run or official grading.';
} catch (error) {
  report.status = 'recovery-blocked';
  report.error = { stage, code: error.publicFailure?.code ?? error.code ?? error.name,
    message: 'The actual existing workspace recovery did not complete; immutable ordinary operation receipts are retained and no original write was replayed.' };
} finally {
  report.finishedAt = new Date().toISOString();
  await client.close();
  clearTimeout(timer);
  globalThis.process.removeListener('SIGINT', stop); globalThis.process.removeListener('SIGTERM', stop);
  await save();
}
console.log(JSON.stringify({ status: report.status, output, patchBytes: report.patch?.bytes ?? null, newModelCalls: 0 }));
globalThis.process.exitCode = report.patch ? 0 : 1;
