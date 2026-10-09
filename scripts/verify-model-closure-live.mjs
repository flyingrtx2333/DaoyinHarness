import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createCloudAccountClient, readHiddenCredentials, sanitizeEvidence } from './cloud-live-client.mjs';
import { verifyCloudLongTasks } from './verify-cloud-long-task-live.mjs';

// Two actual account/Agent/tool/storage scenarios. No model replay or synthetic replies.
const revision = process.argv[process.argv.indexOf('--expected-revision') + 1];
if (!process.argv.includes('--run')) {
  console.log(JSON.stringify({ status: 'prepared-not-executed', scenarios: ['csv', 'budget-closure'], maxSharedCalls: 24 }));
  process.exit(0);
}
if (!process.argv.includes('--expected-revision') || !/^[a-f0-9]{40}$/u.test(revision ?? '')) throw new Error('Exact runtime revision required.');
const controller = new AbortController();
for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => controller.abort(new Error('Stopped by operator.')));
const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20 * 60_000)]);
const output = resolve('.cache/model-closure-live', new Date().toISOString().replaceAll(':', '-') + '_' + randomUUID().slice(0, 8));
await mkdir(output, { recursive: true, mode: 0o700 });
const report = { kind: 'real-account-model-closure', startedAt: new Date().toISOString(), revision,
  maxSharedCalls: 24, status: 'running', normal: undefined, closure: undefined };
const save = async (name, value) => writeFile(join(output, name), JSON.stringify(sanitizeEvidence(value), null, 2) + '\n', { mode: 0o600 });
const persist = () => save('report.json', report);
const assert = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { code }); };
const client = createCloudAccountClient({ signal });
const request = async (path, body, options = {}) => (await client.request(path, body, { ...options, signal: options.signal ?? signal })).result;
let active;
try {
  await persist();
  console.log(JSON.stringify({ ready: true, input: 'hidden-credential-json', output }));
  await client.login(await readHiddenCredentials({ signal }));
  const normal = await verifyCloudLongTasks({ client, expectedRevision: revision, output: join(output, 'normal'), signal, cases: ['csv'] });
  report.normal = normal;
  await persist();
  assert(normal.passed, 'NORMAL_TASK_FAILED');
  const runtime = await request('/runtime');
  assert(runtime.build?.revision === revision, 'RUNTIME_REVISION_MISMATCH');
  await save('runtime.json', runtime);
  const created = await request('/sessions', { title: `Real budget closure ${randomUUID().slice(0, 8)}` });
  assert(created.session?.profileId === 'daoyin-workbench', 'SESSION_PROFILE_INVALID');
  const sessionId = created.session.id;
  const entry = { sessionId, status: 'preparing', events: [], startedAt: new Date().toISOString() };
  report.closure = entry;
  await persist();
  const workspace = await request('/resources/control', { action: 'workspace_create', sessionId,
    title: 'Real sequential document review', source: { kind: 'empty' }, runtimeId: 'python313', requestId: randomUUID() }, { timeoutMs: 120_000 });
  assert(workspace.workspace?.state === 'ready', 'WORKSPACE_NOT_READY');
  entry.workspaceId = workspace.workspace.id;
  entry.runtimeImage = workspace.workspace.runtime?.image;
  await save('workspace.json', workspace);
  for (let i = 1; i <= 12; i++) {
    const path = `review-${String(i).padStart(2, '0')}.txt`;
    const content = `编号：${i}\n记录值：${i * 7}\n`;
    const value = await request('/resources/control', { action: 'file_write', sessionId, workspaceId: entry.workspaceId, path, content });
    await save(`input-${i}.json`, { path, content, value });
  }
  const body = { requestId: randomUUID(), message: '只在当前工作区核对 review-01.txt 到 review-12.txt 十二份核对单中的编号和记录值，按顺序逐份读取。每次模型回复只调用一次 file_read，只读一份文件；不要批量调用、不要用进程或搜索一次读取全部，也不要委派子任务或访问外部业务。完成后列出实际核对的编号和值。如果可信运行预算要求收尾，立即停止调用工具，如实列出已核对和未核对的编号，不能声称全部完成。不要修改输入文件。' };
  entry.request = body;
  await save('closure-request.json', { sessionId, ...body });
  let accepted;
  try { accepted = await request(`/sessions/${sessionId}/runs`, body); }
  catch (error) {
    if (error.publicFailure) throw error;
    const listed = await request(`/sessions/${sessionId}/runs`);
    const matches = listed.runs?.filter(run => run.requestId === body.requestId && run.userMessage === body.message) ?? [];
    assert(matches.length === 1, 'SUBMISSION_OUTCOME_UNKNOWN');
    accepted = { run: matches[0] };
  }
  assert(accepted.run?.sessionId === sessionId && accepted.run.requestId === body.requestId, 'RUN_RECEIPT_INVALID');
  entry.runId = accepted.run.id;
  active = entry.runId;
  entry.status = 'running';
  await save('accepted.json', accepted);
  await persist();
  const deadline = Date.now() + 7 * 60_000;
  let cursor = 0;
  let terminal;
  while (Date.now() < deadline) {
    for (;;) {
      const page = await request(`/sessions/${sessionId}/events?after=${cursor}`);
      assert(Array.isArray(page.events), 'EVENT_PAGE_INVALID');
      for (const event of page.events) {
        assert(event.sessionId === sessionId && event.eventSeq === cursor + 1, 'EVENT_CURSOR_INVALID');
        entry.events.push(event); cursor = event.eventSeq;
      }
      assert(page.nextEventSeq === cursor, 'EVENT_CURSOR_INVALID');
      await save('closure-events.json', entry.events);
      if (!page.hasMore) break;
      assert(page.events.length, 'EVENT_PAGE_STALLED');
    }
    terminal = await request(`/runs/${entry.runId}`);
    entry.status = terminal.run?.status;
    await persist();
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(entry.status)) break;
    await delay(1000, undefined, { signal });
  }
  assert(['completed', 'failed', 'cancelled', 'interrupted'].includes(entry.status), 'RUN_DEADLINE_EXCEEDED');
  active = undefined;
  await save('terminal.json', terminal);
  const tail = await request(`/sessions/${sessionId}/events?after=${cursor}`);
  for (const event of tail.events ?? []) {
    assert(event.sessionId === sessionId && event.eventSeq === cursor + 1, 'EVENT_CURSOR_INVALID');
    entry.events.push(event); cursor = event.eventSeq;
  }
  assert(tail.hasMore === false && tail.nextEventSeq === cursor, 'TERMINAL_EVENTS_INCOMPLETE');
  const events = entry.events.filter(event => event.turnId === entry.runId);
  const requests = events.filter(event => event.type === 'model.requested');
  entry.engineAttempts = requests.length;
  const last = requests.at(-1);
  const response = events.find(event => event.type === 'model.responded' && event.payload.modelCallId === last?.payload.modelCallId);
  entry.finalRequest = last;
  entry.finalResponse = response;
  entry.finalText = terminal.run.finalText;
  entry.toolActions = events.filter(event => event.type === 'tool.started').map(event => ({ name: event.payload.toolName, input: event.payload.input }));
  entry.diagnostics = await request(`/runs/${entry.runId}/diagnostics`);
  await save('closure-events.json', entry.events);
  await persist();
  assert(last?.payload.tools?.length === 0, 'TOOL_FREE_CLOSURE_NOT_EXERCISED');
  assert(last.payload.messages?.some(message => message.role === 'assistant_tool_calls'), 'TOOL_HISTORY_NOT_EXERCISED');
  assert(response?.payload.status === 'completed' && response.payload.reply?.kind === 'assistant', 'TOOL_FREE_MODEL_FAILED');
  assert(!events.some(event => event.type === 'tool.started' && event.eventSeq > last.eventSeq), 'TOOL_EXECUTED_AFTER_CLOSURE');
  assert(entry.status === 'completed' && entry.finalText, 'CLOSURE_NOT_COMPLETED');
  assert(requests.length <= 12, 'ENGINE_BUDGET_EXCEEDED');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = { code: error.code ?? 'DRIVER_FAILED', name: error.name };
  if (active) {
    try {
      await request(`/runs/${active}/cancel`, {}, { signal: AbortSignal.timeout(30_000) });
      report.cleanup = await request(`/runs/${active}`, undefined, { signal: AbortSignal.timeout(30_000) });
    } catch { report.cleanup = { status: 'unconfirmed', runId: active }; }
  }
  process.exitCode = 1;
} finally {
  client.close();
  report.finishedAt = new Date().toISOString();
  await persist();
  console.log(JSON.stringify({ status: report.status, report: join(output, 'report.json'), failure: report.failure }));
}
