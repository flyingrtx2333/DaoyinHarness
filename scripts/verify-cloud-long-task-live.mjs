import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createCloudAccountClient, readHiddenCredentials, sanitizeEvidence } from './cloud-live-client.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const MODEL_LIMIT = 36;
const TOOL_LIMIT = 96; // Four ordinary runs, each capped by the server at 24 tools.
const TOTAL_MS = 15 * 60_000;
const sha = value => createHash('sha256').update(value).digest('hex');
const scopedFailure = error => error?.publicFailure ?? { code: /^[A-Z0-9_]{1,100}$/u.test(error?.code ?? '') ? error.code : 'DRIVER_FAILED', name: error?.name ?? 'Error' };
const fail = (code, message) => Object.assign(new Error(message), { code });
const assert = (condition, code, message) => { if (!condition) throw fail(code, message); };

function csvRows(rows) { return rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n') + '\n'; }

export function fixtures() {
  const csv = csvRows([
    ['region', 'status', 'amount'], ['north', 'paid', '10.25'], ['south', 'paid', '5.20'],
    ['north', 'cancelled', '999.99'], ['north', 'paid', '-1.10'], ['east,coast', 'paid', '0.10'],
    ['east,coast', 'paid', '0.20'], ['south', 'pending', '123.00'], ['south', 'paid', ''],
    ['north', 'paid', '0.00'], ['south', 'paid', '2.80'],
  ]);
  const expectedCsv = [{ region: 'east,coast', total: '0.30', count: 2 }, { region: 'north', total: '9.15', count: 3 }, { region: 'south', total: '8.00', count: 2 }];
  const ledgerRows = [['entry_id', 'department', 'amount_cents', 'status', 'note']];
  const totals = new Map();
  for (let i = 0; i < 3500; i++) {
    const department = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'][i % 5];
    const amount = (i * 37 % 20_003) - 9000;
    const status = i % 7 === 0 ? 'void' : 'posted';
    ledgerRows.push([`entry-${String(i).padStart(5, '0')}`, department, amount, status,
      `audit-line-${i}: 数据记录，保留原始账本；${'reference-data '.repeat(5)}`]);
    if (status === 'posted') {
      const prior = totals.get(department) ?? { department, net_cents: 0, count: 0 };
      prior.net_cents += amount; prior.count++; totals.set(department, prior);
    }
  }
  const orders = [
    { customer: 'alice', currency: 'CNY', type: 'payment', status: 'settled', cents: 1500, at: '2026-09-01T00:00:00Z' },
    { customer: 'alice', currency: 'CNY', type: 'refund', status: 'settled', cents: 250, at: '2026-09-15T12:00:00Z' },
    { customer: 'bob', currency: 'CNY', type: 'payment', status: 'settled', cents: 999, at: '2026-09-30T23:59:59Z' },
    { customer: 'bob', currency: 'CNY', type: 'refund', status: 'pending', cents: 500, at: '2026-09-10T00:00:00Z' },
    { customer: 'alice', currency: 'USD', type: 'payment', status: 'settled', cents: 99999, at: '2026-09-10T00:00:00Z' },
    { customer: 'alice', currency: 'CNY', type: 'payment', status: 'settled', cents: 800, at: '2026-10-01T00:00:00Z' },
    { customer: 'carol', currency: 'CNY', type: 'payment', status: 'settled', cents: 200, at: '2026-08-31T23:59:59Z' },
    { customer: 'bob', currency: 'CNY', type: 'refund', status: 'settled', cents: 100, at: '2026-09-30T22:00:00Z' },
  ];
  const expectedOrders = { version: 1, currency: 'CNY', groups: [
    { customer: 'alice', net_cents: 1250, paid_count: 1, refund_count: 1 },
    { customer: 'bob', net_cents: 899, paid_count: 1, refund_count: 1 },
  ] };
  return [
    { id: 'csv', sourcePath: 'input.csv', source: csv, program: 'solution.py', output: 'result.csv', mediaType: 'text/csv',
      messages: ['请只操作当前工作区文件及沙箱 Python，不委派子任务，不访问业务接口或外部服务。读取 input.csv，创建只用标准库的 solution.py 并真实运行：只聚合 status=paid 且 amount 非空的行；负数正常计入，使用精确十进制，按 region 升序。输出 result.csv，严格列 region,total,count，total 固定两位小数，count 是参与聚合的行数。保持 input.csv 不变。完成后报告真实执行情况。'],
      expected: expectedCsv, verify: `import csv\nwith open('result.csv',newline='') as f:\n r=csv.DictReader(f); assert r.fieldnames==['region','total','count']; actual=[dict(region=x['region'],total=x['total'],count=int(x['count'])) for x in r]\nassert actual==expected, (actual,expected)\n` },
    { id: 'large-ledger', sourcePath: 'ledger.csv', source: csvRows(ledgerRows), program: 'ledger.py', output: 'summary.csv', mediaType: 'text/csv',
      messages: ['请只操作当前工作区文件及沙箱 Python，不委派子任务，不访问业务接口或外部服务。ledger.csv 是较大的真实账本输入；不要把整个文件灌入对话，先适量定位/读取了解结构，再用标准库程序处理。创建 ledger.py 并真实运行：仅聚合 status=posted 的行，amount_cents 是有符号整数，按 department 升序输出 summary.csv，严格列 department,net_cents,count。输入文件不能改，所有记录必须纳入计算。完成后报告真实执行情况。'],
      expected: [...totals.values()].sort((a, b) => a.department.localeCompare(b.department)),
      verify: `import csv\nwith open('summary.csv',newline='') as f:\n r=csv.DictReader(f); assert r.fieldnames==['department','net_cents','count']; actual=[dict(department=x['department'],net_cents=int(x['net_cents']),count=int(x['count'])) for x in r]\nassert actual==expected, (actual,expected)\n` },
    { id: 'multiturn-constraints', sourcePath: 'orders.json', source: JSON.stringify(orders, null, 2) + '\n', program: 'report.py', output: 'report.json', mediaType: 'application/json',
      messages: [
        '请只操作当前工作区文件及沙箱 Python，不委派子任务，不访问业务接口或外部服务。这是订单报告任务的第一轮。先查看 orders.json，将长期约束写进 plan.md，暂时不要生成或运行报表程序，等待下一轮日期区间：只处理 CNY；只处理 settled；payment 加 cents，refund 减 cents，全部用整数分，绝不浮点。报告 JSON 严格结构 version=1,currency=CNY,groups；groups 按 customer 升序，每项严格 customer,net_cents,paid_count,refund_count，无合格记录的客户不输出。请保存这些规则并确认等待区间。',
        '现在执行上轮订单报告任务，日期区间为 UTC 的 2026-09-01（含）至 2026-10-01（不含）。沿用前轮规则，保持 orders.json 不变，创建标准库 report.py 并真实运行，输出 report.json。完成后报告真实文件和执行结果。',
      ], expected: expectedOrders, verify: `with open('report.json') as f: actual=json.load(f)\nassert actual==expected, (actual,expected)\nassert type(actual['version']) is int\nassert all(type(group[key]) is int for group in actual['groups'] for key in ['net_cents','paid_count','refund_count'])\nassert 'plan.md' in os.listdir('.')\n` },
  ];
}

/** Real ordinary cloud path only; a caller may reuse its already authenticated shared client. */
export async function verifyCloudLongTasks({ client, expectedRevision, output, signal, cases, resumeLedgerReport, resumeMultiturnReport } = {}) {
  assert(client && typeof client.request === 'function', 'CLIENT_REQUIRED', 'An authenticated ordinary account client is required.');
  assert(typeof expectedRevision === 'string' && /^[a-f0-9]{40}$/u.test(expectedRevision), 'REVISION_REQUIRED', 'An exact expected runtime revision is required.');
  const available = fixtures();
  assert(cases === undefined || (Array.isArray(cases) && cases.length && new Set(cases).size === cases.length &&
    cases.every(id => available.some(fixture => fixture.id === id))), 'CASE_SELECTION_INVALID', 'Select only distinct named real scenarios.');
  const selected = cases === undefined ? available : available.filter(fixture => cases.includes(fixture.id));
  let priorLedger;
  if (resumeLedgerReport !== undefined) {
    const priorPath = resolve(resumeLedgerReport);
    const priorScope = relative(join(ROOT, '.cache'), priorPath);
    assert(priorScope && !priorScope.startsWith('..') && !isAbsolute(priorScope), 'RESUME_SCOPE_INVALID', 'Resume evidence must belong to repository .cache.');
    const bytes = await readFile(priorPath);
    const prior = JSON.parse(bytes.toString('utf8'));
    const fixture = available.find(item => item.id === 'large-ledger');
    const entry = prior.cases?.find(item => item.id === 'large-ledger');
    assert(selected.some(item => item.id === 'large-ledger') && prior.executionPath === 'ordinary-account-cloud-bff-gvisor' &&
      entry?.input?.sha256 === sha(fixture.source) && entry.input.size === Buffer.byteLength(fixture.source) &&
      entry.runs?.length === 1 && entry.runs[0].message === fixture.messages[0] && entry.runs[0].status === 'failed' &&
      /^wsp_[a-f0-9]{24}$/u.test(entry.workspaceId ?? '') && typeof entry.sessionId === 'string',
      'RESUME_EVIDENCE_INVALID', 'Only the exact existing failed real ledger scenario may be resumed.');
    priorLedger = { entry, source: priorPath, sha256: sha(bytes), inferenceRevision: prior.expectedRevision };
  }
  let priorMultiturn;
  if (resumeMultiturnReport !== undefined) {
    const priorPath = resolve(resumeMultiturnReport);
    const scope = relative(join(ROOT, '.cache'), priorPath);
    assert(scope && !scope.startsWith('..') && !isAbsolute(scope), 'RESUME_SCOPE_INVALID', 'Resume evidence must belong to repository .cache.');
    const bytes = await readFile(priorPath);
    const prior = JSON.parse(bytes.toString('utf8'));
    const fixture = available.find(item => item.id === 'multiturn-constraints');
    const entry = prior.cases?.find(item => item.id === fixture.id);
    assert(selected.some(item => item.id === fixture.id) && prior.executionPath === 'ordinary-account-cloud-bff-gvisor' &&
      entry?.input?.sha256 === sha(fixture.source) && entry.input.size === Buffer.byteLength(fixture.source) &&
      entry.runs?.length === 2 && entry.runs[0].status === 'completed' && entry.runs[0].message === fixture.messages[0] &&
      entry.runs[1].status === 'failed' && entry.runs[1].message === fixture.messages[1] && entry.runs[1].toolCalls === 0 &&
      typeof entry.firstTurnPlan?.content === 'string' && /^wsp_[a-f0-9]{24}$/u.test(entry.workspaceId ?? ''),
      'RESUME_EVIDENCE_INVALID', 'Only the exact completed plan followed by a failed tool-free second turn may be continued.');
    priorMultiturn = { entry, source: priorPath, sha256: sha(bytes), inferenceRevision: prior.expectedRevision };
  }
  signal?.throwIfAborted();
  const outputRoot = resolve(output ?? join(ROOT, '.cache', 'cloud-long-task-live', new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8)));
  const scoped = relative(join(ROOT, '.cache'), outputRoot);
  assert(scoped && !scoped.startsWith('..') && !isAbsolute(scoped), 'OUTPUT_INVALID', 'Evidence output must be a new directory within repository .cache.');
  await mkdir(dirname(outputRoot), { recursive: true, mode: 0o700 });
  await mkdir(outputRoot, { mode: 0o700 });
  const controller = new AbortController();
  const deadline = AbortSignal.timeout(TOTAL_MS - 30_000); // Reserve bounded time for cancellation receipts.
  const runSignal = AbortSignal.any([controller.signal, deadline, ...(signal ? [signal] : [])]);
  const interrupt = () => controller.abort(new DOMException('Cancelled', 'AbortError'));
  process.on('SIGINT', interrupt);
  const started = Date.now();
  const report = { schemaVersion: 1, executionPath: 'ordinary-account-cloud-bff-gvisor', expectedRevision,
    sourceSha256: sha(await readFile(fileURLToPath(import.meta.url))),
    transportSha256: sha(await readFile(new URL('./cloud-live-client.mjs', import.meta.url))),
    driverNodeVersion: process.version, startedAt: new Date().toISOString(),
    model: 'unknown-gateway-routed-model', usage: 'unknown', cost: 'unknown',
    limits: { totalMs: TOTAL_MS, modelAttempts: MODEL_LIMIT, toolCalls: TOOL_LIMIT, ordinaryRunModelDefault: 12, ordinaryRunToolLimit: 24, maxRuns: 4 },
    semantics: { multiturn: true, semanticCompaction: 'not-verified-unless-observed', mockResponses: false },
    plannedCases: selected.map(fixture => fixture.id), cases: [], status: 'running', passed: false };
  const sessions = new Map();
  const pending = [];
  let evidenceIndex = 0;
  const persist = async () => writeFile(join(outputRoot, 'report.json'), JSON.stringify(sanitizeEvidence(report), null, 2) + '\n', { mode: 0o600 });
  const save = async (name, value) => {
    const clean = sanitizeEvidence(value);
    const content = JSON.stringify(clean, null, 2) + '\n';
    const path = `${String(++evidenceIndex).padStart(4, '0')}-${name}.json`;
    await writeFile(join(outputRoot, path), content, { flag: 'wx', mode: 0o600 });
    return { path, sha256: sha(content) };
  };
  const request = async (path, body, options = {}) => {
    runSignal.throwIfAborted();
    const response = await client.request(path, body, { ...options, signal: runSignal });
    runSignal.throwIfAborted(); return response.result;
  };
  const runtime = async () => {
    const value = await request('/runtime');
    assert(value?.build?.revision === expectedRevision, 'RUNTIME_REVISION_MISMATCH', 'The running server revision does not match the candidate.');
    report.runtime = value;
    await save('runtime', value); return value;
  };
  const resource = async (entry, action, fields = {}, timeoutMs = 90_000) => {
    const body = { action, sessionId: entry.sessionId, ...(entry.workspaceId ? { workspaceId: entry.workspaceId } : {}), ...fields };
    const result = await request('/resources/control', body, { timeoutMs });
    const receipt = await save(`${entry.id}-${action}`, { observedAt: new Date().toISOString(), request: body, result });
    (entry.resourceReceipts ??= []).push({ action, ...receipt });
    report.observedDriverResourceOperations = report.cases.reduce((total, item) => total + (item.resourceReceipts?.length ?? 0), 0);
    report.observedDriverSandboxProcesses = report.cases.reduce((total, item) => total + (item.resourceReceipts?.filter(item => item.action === 'process_run').length ?? 0), 0);
    return result;
  };
  const processRun = async (entry, args, fields = {}) => {
    const result = await resource(entry, 'process_run', { executable: 'python', args, cwd: '.', timeoutMs: 30_000, ...fields }, 60_000);
    assert(result.sandbox === 'gVisor' && result.exitCode === 0 && !result.timedOut, 'SANDBOX_PROCESS_FAILED', 'A real gVisor process did not complete successfully.');
    return result;
  };
  const accounting = () => {
    let models = 0; let tools = 0;
    for (const data of sessions.values()) for (const event of data.events) {
      if (event.type === 'model.requested') models++;
      if (event.type === 'tool.started') tools++;
    }
    report.observedModelAttempts = models; report.observedToolCalls = tools;
    assert(models <= MODEL_LIMIT && tools <= TOOL_LIMIT, 'LIVE_BUDGET_EXCEEDED', 'Observed persisted work exceeded the driver budget.');
    return { models, tools };
  };
  const collect = async sessionId => {
    let data = sessions.get(sessionId);
    if (!data) { data = { events: [], cursor: 0, ids: new Set() }; sessions.set(sessionId, data); }
    for (let page = 0; page < 256; page++) {
      const value = await request(`/sessions/${encodeURIComponent(sessionId)}/events?after=${data.cursor}`);
      assert(Array.isArray(value.events) && typeof value.hasMore === 'boolean' && Number.isSafeInteger(value.nextEventSeq), 'EVENT_PAGE_INVALID', 'An event page has an invalid shape.');
      for (const event of value.events) {
        assert(event.sessionId === sessionId && typeof event.id === 'string' && !data.ids.has(event.id) && Number.isSafeInteger(event.eventSeq) && event.eventSeq === data.cursor + 1,
          'EVENT_CURSOR_INVALID', 'Events must belong to the session and advance monotonically.');
        data.events.push(event); data.cursor = event.eventSeq; data.ids.add(event.id);
      }
      if (value.events.length) await save(`events-${sessionId}-${data.cursor}`, value);
      accounting();
      await persist();
      assert(value.nextEventSeq === data.cursor, 'EVENT_CURSOR_INVALID', 'The returned cursor does not match persisted events.');
      if (!value.hasMore) return data.events;
      assert(value.events.length > 0, 'EVENT_PAGE_INVALID', 'A continuing page must advance.');
    }
    throw fail('EVENT_PAGE_LIMIT', 'Event pagination exceeded its bound.');
  };
  const inspectChildren = async runId => {
    const diagnostics = await request(`/runs/${encodeURIComponent(runId)}/diagnostics`);
    await save(`diagnostics-${runId}`, diagnostics);
    for (const child of diagnostics.orchestration?.children ?? []) {
      assert(typeof child.sessionId === 'string' && typeof child.runId === 'string', 'CHILD_RECEIPT_INVALID', 'Child diagnostics are malformed.');
      await collect(child.sessionId);
    }
    return diagnostics;
  };
  const submit = async (entry, message) => {
    await runtime();
    const { models, tools } = accounting();
    // Reserve the full ordinary server run allowance before admission; optional BFF limits are unsupported.
    assert(models + 12 <= MODEL_LIMIT && tools + 24 <= TOOL_LIMIT, 'LIVE_BUDGET_ADMISSION_DENIED', 'Insufficient remaining budget for another ordinary run.');
    const receipt = { sessionId: entry.sessionId, requestId: randomUUID(), message };
    await save(`request-${receipt.requestId}`, receipt); // Must exist before an uncertain, potentially billable POST.
    pending.push(receipt);
    let accepted;
    try { accepted = await request(`/sessions/${encodeURIComponent(entry.sessionId)}/runs`, { requestId: receipt.requestId, message }); }
    catch (error) {
      runSignal.throwIfAborted();
      if (error?.publicFailure) throw error;
      const recovery = await request(`/sessions/${encodeURIComponent(entry.sessionId)}/runs`);
      const matches = recovery.runs?.filter(run => run.requestId === receipt.requestId && run.userMessage === message) ?? [];
      assert(matches.length === 1, 'SUBMISSION_OUTCOME_UNKNOWN', 'Submission was uncertain; no new attempt was started.');
      accepted = { run: matches[0], recoveredFromPersistedRun: true };
    }
    const run = accepted.run;
    assert(run?.sessionId === entry.sessionId && run.requestId === receipt.requestId && run.userMessage === message && typeof run.id === 'string', 'RUN_RECEIPT_INVALID', 'The actual run receipt does not match the request.');
    receipt.runId = run.id;
    const observed = { runId: run.id, requestId: receipt.requestId, message, accepted: await save(`accepted-${run.id}`, accepted) };
    entry.runs.push(observed);
    await persist();
    for (;;) {
      await collect(entry.sessionId);
      const value = await request(`/runs/${encodeURIComponent(run.id)}`);
      assert(value.run?.id === run.id && value.run.sessionId === entry.sessionId, 'RUN_RECEIPT_INVALID', 'Run polling returned another scope.');
      observed.status = value.run.status;
      if (TERMINAL.has(value.run.status)) {
        await collect(entry.sessionId);
        observed.diagnostics = await inspectChildren(run.id);
        const events = sessions.get(entry.sessionId).events.filter(event => event.turnId === run.id);
        assert(events.some(event => event.type === `turn.${value.run.status}`), 'TERMINAL_EVENT_MISSING', 'A terminal run must have its persisted terminal event.');
        observed.modelAttempts = events.filter(event => event.type === 'model.requested').length;
        observed.toolCalls = events.filter(event => event.type === 'tool.started').length;
        assert(observed.modelAttempts <= 12 && observed.toolCalls <= 24, 'SERVER_RUN_BUDGET_EXCEEDED', 'The actual run exceeded its ordinary server allowance.');
        observed.toolActions = events.filter(event => event.type === 'tool.started').map(event => ({ eventSeq: event.eventSeq, name: event.payload.toolName, input: event.payload.input }));
        observed.eventEvidenceSha256 = sha(JSON.stringify(sanitizeEvidence(events)));
        observed.finalText = value.run.finalText;
        observed.lastEventSeq = value.run.lastEventSeq;
        observed.terminalReceipt = await save(`terminal-${run.id}`, value);
        assert(value.run.status === 'completed', 'REAL_RUN_NOT_COMPLETED', 'The real Agent run did not complete.');
        assert(observed.modelAttempts > 0 && observed.toolCalls > 0 && events.some(event => event.type === 'model.responded' && event.payload.status === 'completed'),
          'REAL_MODEL_EVIDENCE_MISSING', 'The task needs real model and tool receipts.');
        return run.id;
      }
      await delay(1000, undefined, { signal: runSignal });
    }
  };
  const artifact = async (entry, path, mediaType, runId) => {
    const created = await resource(entry, 'artifact_create', { path, title: `${entry.id} ${path}`, mediaType,
      sourceRun: runId, metadata: { validation: 'real-cloud-long-task', sourceRun: runId } });
    const read = await resource(entry, 'artifact_read', { artifactId: created.artifact.id, maximumBytes: 1_000_000 });
    const bytes = Buffer.from(read.contentBase64, 'base64');
    assert(read.artifact.id === created.artifact.id && read.artifact.workspaceId === entry.workspaceId && read.artifact.size === bytes.length &&
      read.artifact.blobHash === `sha256:${sha(bytes)}` && read.artifact.blobHash === created.artifact.blobHash,
      'ARTIFACT_INTEGRITY_FAILED', 'Actual artifact bytes must match server metadata.');
    const filename = `${entry.id}-${path}`;
    await writeFile(join(outputRoot, filename), bytes, { flag: 'wx', mode: 0o600 });
    return { artifactId: read.artifact.id, snapshotId: read.artifact.snapshotId, size: bytes.length, blobHash: read.artifact.blobHash, path: filename };
  };
  await persist();
  try {
    await runtime();
    for (const fixture of selected) {
      const entry = { id: fixture.id, status: 'preflight', input: { path: fixture.sourcePath, size: Buffer.byteLength(fixture.source), sha256: sha(fixture.source) }, runs: [] };
      report.cases.push(entry); await persist();
      const resumed = fixture.id === 'large-ledger' ? priorLedger : fixture.id === 'multiturn-constraints' ? priorMultiturn : undefined;
      const created = resumed ? { session: (await request('/sessions')).sessions?.find(item => item.id === resumed.entry.sessionId) } :
        await request('/sessions', { title: `Live validation ${fixture.id} ${randomUUID().slice(0, 8)}` });
      assert(created.session?.profileId === 'daoyin-workbench' && typeof created.session.id === 'string', 'SESSION_PROFILE_INVALID', 'An ordinary account workbench session is required.');
      entry.sessionId = created.session.id; entry.profileVersion = created.session.profileVersion;
      if (resumed) {
        entry.workspaceId = resumed.entry.workspaceId;
        const receipt = await request(`/runs/${encodeURIComponent(resumed.entry.runs.at(-1).runId)}`);
        assert(receipt.run?.sessionId === entry.sessionId && receipt.run.status === 'failed' && receipt.run.userMessage === fixture.messages.at(-1),
          'RESUME_RUN_MISMATCH', 'The previous failed run must be verified through the current account API.');
        if (fixture.id === 'multiturn-constraints') {
          const first = await request(`/runs/${encodeURIComponent(resumed.entry.runs[0].runId)}`);
          assert(first.run?.sessionId === entry.sessionId && first.run.status === 'completed' && first.run.userMessage === fixture.messages[0],
            'RESUME_PLAN_RUN_MISMATCH', 'The original first-turn completion must belong to the current account session.');
          entry.firstTurnReceipt = await save('resumed-plan-run', first);
        }
        entry.resumedFrom = { sourceReport: resumed.source, sourceSha256: resumed.sha256, inferenceRevision: resumed.inferenceRevision,
          previousRunId: receipt.run.id, receipt: await save(`resumed-${fixture.id}-run`, receipt) };
        await collect(entry.sessionId);
        entry.priorModelAttempts = sessions.get(entry.sessionId).events.filter(event => event.type === 'model.requested').length;
        assert(!sessions.get(entry.sessionId).events.some(event => event.turnId === receipt.run.id && event.type === 'tool.started') || fixture.id === 'large-ledger',
          'RESUME_TOOL_STATE_CHANGED', 'The failed second turn must have no tool execution.');
      }
      const workspace = resumed ? await resource(entry, 'workspace_inspect') :
        await resource(entry, 'workspace_create', { title: `Real ${fixture.id}`, source: { kind: 'empty' }, runtimeId: 'python313', requestId: randomUUID() }, 120_000);
      assert(workspace.workspace?.state === 'ready' && /^wsp_[a-f0-9]{24}$/u.test(workspace.workspace.id), 'WORKSPACE_NOT_READY', 'A real ready workspace is required.');
      entry.workspaceId = workspace.workspace.id; entry.runtimeImage = workspace.workspace.runtime?.image;
      entry.preflight = await processRun(entry, ['--version']);
      assert(/Python 3\./u.test(entry.preflight.stdout + entry.preflight.stderr), 'PYTHON_PREFLIGHT_FAILED', 'Python preflight must succeed before model admission.');
      if (resumed) {
        const observed = await processRun(entry, ['-c', `import hashlib;print(hashlib.sha256(open(${JSON.stringify(fixture.sourcePath)},'rb').read()).hexdigest())`]);
        assert(observed.stdout.trim() === entry.input.sha256, 'RESUME_INPUT_CHANGED', 'The existing input must retain its original bytes.');
        if (fixture.id === 'multiturn-constraints') {
          const files = await resource(entry, 'file_list');
          assert(!files.entries?.some(item => ['report.py', 'report.json'].includes(item.name)), 'RESUME_OUTPUT_EXISTS', 'The failed second turn must not have generated the report.');
          entry.firstTurnPlan = await resource(entry, 'file_read', { path: 'plan.md', maximumBytes: 20_000 });
          assert(entry.firstTurnPlan.content === resumed.entry.firstTurnPlan.content, 'RESUME_PLAN_CHANGED', 'The original persisted plan must remain unchanged.');
        }
      } else if (fixture.id === 'large-ledger') {
        // The ordinary public BFF rejects this 591 KiB upload with HTTP 413.
        // Prepare the same input through the real standard-library sandbox path;
        // compare its exact bytes with the independently generated fixture hash.
        const prepare = `import csv,hashlib,json\nwith open('ledger.csv','w',encoding='utf-8',newline='') as f:\n w=csv.writer(f,quoting=csv.QUOTE_ALL,lineterminator='\\n'); w.writerow(['entry_id','department','amount_cents','status','note'])\n for i in range(3500):\n  w.writerow([f'entry-{i:05d}',['alpha','beta','gamma','delta','epsilon'][i%5],(i*37%20003)-9000,'void' if i%7==0 else 'posted',f'audit-line-{i}: 数据记录，保留原始账本；'+'reference-data '*5])\nprint(json.dumps({'sha256':hashlib.sha256(open('ledger.csv','rb').read()).hexdigest()}))\n`;
        entry.input.preparation = 'real-gvisor-standard-library-generator';
        entry.input.preparationReceipt = await processRun(entry, ['-c', prepare]);
        assert(JSON.parse(entry.input.preparationReceipt.stdout.trim()).sha256 === entry.input.sha256,
          'INPUT_PREPARATION_MISMATCH', 'Sandbox-prepared input differs from the independent fixture.');
      } else await resource(entry, 'file_write', { path: fixture.sourcePath, content: fixture.source });
      entry.status = 'running'; await persist();
      let runId;
      const messages = resumed && fixture.id === 'multiturn-constraints' ? [`继续已保存的订单计划；上次模型请求已终止且没有执行任何工具。先读取 plan.md，再完成原日期区间任务。${fixture.messages[1]}`] : resumed ? [`继续同一账本任务。执行回执存储已修复，已有 ledger.py；先读取并真实运行现有程序，只在结果不符合规则时修改。${fixture.messages[0]}`] : fixture.messages;
      for (const [index, message] of messages.entries()) {
        runId = await submit(entry, message);
        if (fixture.id === 'multiturn-constraints' && !resumed && index === 0) {
          const files = await resource(entry, 'file_list');
          assert(files.entries?.some(item => item.name === 'plan.md') && !files.entries.some(item => ['report.py', 'report.json'].includes(item.name)),
            'MULTITURN_WAIT_STATE_FAILED', 'The first real turn must persist a plan and wait for the next-turn interval.');
          entry.firstTurnPlan = await resource(entry, 'file_read', { path: 'plan.md', maximumBytes: 20_000 });
          assert(typeof entry.firstTurnPlan.content === 'string' && ['CNY', 'net_cents', 'paid_count', 'refund_count'].every(value => entry.firstTurnPlan.content.includes(value)),
            'MULTITURN_RULE_STATE_FAILED', 'The first turn must retain the requested report constraints.');
        }
      }
      const actualRunEvents = sessions.get(entry.sessionId).events.filter(event => event.turnId === runId);
      assert(actualRunEvents.some(event => event.type === 'tool.completed' && event.payload.toolName === 'process_run' &&
        event.payload.evidence?.result?.exitCode === 0 && event.payload.evidence?.result?.sandbox === 'gVisor'),
        'AGENT_EXECUTION_EVIDENCE_MISSING', 'The Agent itself must successfully execute its program inside gVisor before independent verification.');
      await runtime();
      // Model-authored code is executed only through the same real server gVisor capability.
      entry.programExecution = await processRun(entry, [fixture.program], { sourceRun: runId });
      const verifier = `import hashlib,json,os\nfrom pathlib import Path\nassert Path(${JSON.stringify(fixture.program)}).is_file()\nassert hashlib.sha256(Path(${JSON.stringify(fixture.sourcePath)}).read_bytes()).hexdigest()==${JSON.stringify(entry.input.sha256)}\nexpected=json.loads(${JSON.stringify(JSON.stringify(fixture.expected))})\n${fixture.verify}\nprint(json.dumps({'verified':True,'source_sha256':${JSON.stringify(entry.input.sha256)},'output_sha256':hashlib.sha256(Path(${JSON.stringify(fixture.output)}).read_bytes()).hexdigest()},sort_keys=True))\n`;
      entry.verifierSha256 = sha(verifier);
      entry.verification = await processRun(entry, ['-c', verifier], { sourceRun: runId });
      const verification = JSON.parse(entry.verification.stdout.trim());
      assert(verification.verified === true, 'OUTPUT_VERIFICATION_FAILED', 'The fixed verifier did not confirm actual output.');
      entry.output = await artifact(entry, fixture.output, fixture.mediaType, runId);
      assert(entry.output.blobHash === `sha256:${verification.output_sha256}`, 'OUTPUT_CHANGED_AFTER_VERIFICATION', 'Verified output and immutable artifact differ.');
      entry.program = await artifact(entry, fixture.program, 'text/x-python', runId);
      if (fixture.id === 'multiturn-constraints') entry.plan = await artifact(entry, 'plan.md', 'text/markdown', runId);
      const snapshot = await resource(entry, 'workspace_snapshot');
      assert(snapshot.snapshot?.workspaceId === entry.workspaceId && typeof snapshot.snapshot.digest === 'string' &&
        snapshot.snapshot.entries?.some(item => item.path === fixture.sourcePath && item.blobHash === `sha256:${entry.input.sha256}`) &&
        snapshot.snapshot.entries.some(item => item.path === fixture.output && item.blobHash === entry.output.blobHash),
        'SNAPSHOT_INTEGRITY_FAILED', 'The actual snapshot must retain the input and verified output.');
      entry.snapshot = { id: snapshot.snapshot.id, digest: snapshot.snapshot.digest };
      entry.workspace = await resource(entry, 'workspace_inspect');
      entry.status = 'passed'; await persist();
      console.log(JSON.stringify({ case: entry.id, status: entry.status, modelAttempts: report.observedModelAttempts, toolCalls: report.observedToolCalls }));
    }
    await runtime(); accounting();
    const all = [...sessions.values()].flatMap(data => data.events);
    const summaryRequests = all.filter(event => event.type === 'model.requested' && event.payload.tools?.length === 0 &&
      /Summarize the supplied historical reference data/u.test(event.payload.systemPrompt?.stableText ?? ''));
    const successfulSummaries = summaryRequests.filter(requested => all.some(event => event.type === 'model.responded' &&
      event.payload.modelCallId === requested.payload.modelCallId && event.payload.status === 'completed'));
    const semanticV3Used = all.some(event => {
      if (event.type !== 'model.requested') return false;
      const dynamic = event.payload.systemPrompt?.dynamicText ?? '';
      const normalized = dynamic.replaceAll('\\', '').replace(/\s/gu, '');
      return dynamic.includes('UNTRUSTED_DERIVED_SESSION_CONTEXT') && normalized.includes('"schemaVersion":3') && normalized.includes('"kind":"semantic"');
    });
    report.semantics.semanticCompaction = successfulSummaries.length && semanticV3Used ? 'observed-in-persisted-model-audit' : 'not-verified-no-observed-compaction';
    report.semantics.summaryModelAttempts = summaryRequests.length;
    report.status = 'completed'; report.passed = report.cases.length === selected.length && report.cases.every(entry => entry.status === 'passed');
  } catch (error) {
    report.status = runSignal.aborted || error?.name === 'AbortError' ? 'cancelled' : 'failed';
    report.failure = scopedFailure(error);
    const current = report.cases.findLast(entry => !['passed', 'failed', 'cancelled'].includes(entry.status));
    if (current) current.status = report.status;
    // Resolve uncertain submissions read-only, then cancel only their real matching runs.
    report.cleanup = [];
    const cleanupSignal = AbortSignal.timeout(Math.max(1, Math.min(30_000, TOTAL_MS - (Date.now() - started))));
    for (const receipt of pending) {
      try {
        if (!receipt.runId) {
          const response = await client.request(`/sessions/${encodeURIComponent(receipt.sessionId)}/runs`, undefined, { signal: cleanupSignal, timeoutMs: 8000 });
          const found = response.result.runs?.filter(run => run.requestId === receipt.requestId && run.userMessage === receipt.message) ?? [];
          if (found.length === 1) receipt.runId = found[0].id;
          else { report.cleanup.push({ requestId: receipt.requestId, outcome: 'unconfirmed' }); continue; }
        }
        const response = await client.request(`/runs/${encodeURIComponent(receipt.runId)}`, undefined, { signal: cleanupSignal, timeoutMs: 8000 });
        if (!TERMINAL.has(response.result.run?.status)) {
          const cancelled = await client.request(`/runs/${encodeURIComponent(receipt.runId)}/cancel`, {}, { signal: cleanupSignal, timeoutMs: 8000 });
          report.cleanup.push({ runId: receipt.runId, cancellationRequested: cancelled.result.cancellationRequested, terminalConfirmed: false });
        } else report.cleanup.push({ runId: receipt.runId, status: response.result.run.status, terminalConfirmed: true });
      } catch (cleanupError) { report.cleanup.push({ runId: receipt.runId, failure: scopedFailure(cleanupError), terminalConfirmed: false }); }
    }
  } finally {
    process.removeListener('SIGINT', interrupt);
    report.finishedAt = new Date().toISOString(); report.elapsedMs = Date.now() - started;
    await persist();
  }
  return { report: sanitizeEvidence(report), output: outputRoot, passed: report.passed };
}

async function main() {
  const options = { run: false };
  for (let i = 2; i < process.argv.length; i++) {
    const argument = process.argv[i];
    if (argument === '--run') options.run = true;
    else if (['--expected-revision', '--origin', '--application', '--output', '--cases', '--resume-ledger-report', '--resume-multiturn-report'].includes(argument)) {
      const value = process.argv[++i]; if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}.`);
      options[argument.slice(2).replaceAll('-', '_')] = value;
    } else throw new Error('Unsupported command-line option.');
  }
  if (!options.run) {
    console.log(JSON.stringify({ status: 'prepared-not-executed', cases: fixtures().map(fixture => ({ id: fixture.id, realRuns: fixture.messages.length })),
      executionPath: 'ordinary-account-cloud-bff-gvisor', required: '--run --expected-revision <exact-40-character-runtime-revision>', maxModelAttempts: MODEL_LIMIT, totalMs: TOTAL_MS }));
    return;
  }
  assert(/^[a-f0-9]{40}$/u.test(options.expected_revision ?? ''), 'REVISION_REQUIRED', 'An exact expected runtime revision is required.');
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(TOTAL_MS - 30_000)]);
  const interrupt = () => controller.abort(new DOMException('Cancelled', 'AbortError'));
  process.on('SIGINT', interrupt);
  const client = createCloudAccountClient({ origin: options.origin, application: options.application, signal });
  try {
    console.log(JSON.stringify({ ready: true, input: 'hidden-credential-json', shape: '{"user_name":"...","password":"..."}' }));
    const credentials = await readHiddenCredentials({ signal });
    await client.login(credentials);
    console.log(JSON.stringify({ authenticated: true, executionPath: 'ordinary-account-cloud-bff-gvisor' }));
    const result = await verifyCloudLongTasks({ client, expectedRevision: options.expected_revision, output: options.output, signal,
      ...(options.cases === undefined ? {} : { cases: options.cases.split(',') }),
      ...(options.resume_ledger_report === undefined ? {} : { resumeLedgerReport: options.resume_ledger_report }),
      ...(options.resume_multiturn_report === undefined ? {} : { resumeMultiturnReport: options.resume_multiturn_report }) });
    console.log(JSON.stringify({ status: result.report.status, passed: result.passed, output: result.output,
      observedModelAttempts: result.report.observedModelAttempts, observedToolCalls: result.report.observedToolCalls,
      semanticCompaction: result.report.semantics.semanticCompaction, failure: result.report.failure }));
    if (!result.passed) process.exitCode = 1;
  } finally { process.removeListener('SIGINT', interrupt); client.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => { console.error(JSON.stringify({ failed: true, ...scopedFailure(error) })); process.exitCode = 1; });
}
