/* global document, innerWidth, innerHeight -- Browser evaluate callbacks. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const origin = process.env.HARNESS_UI_ORIGIN ?? "http://127.0.0.1:4677";
const evidence = "evidence/ui-concepts/agent-workbench-redesign-20260905";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const results = [];
const errors = [];
const failedRequests = [];
const expectedErrors = [];
let bootstrap;

async function pageAt(width = 1586, height = 992, expectedFailure = false) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: "reduce", permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") (expectedFailure ? expectedErrors : errors).push(message.text());
  });
  page.on("requestfailed", request => {
    if (request.failure()?.errorText !== "net::ERR_ABORTED") failedRequests.push(request.url());
  });
  page.on("response", response => {
    if (response.status() >= 400) (expectedFailure ? expectedErrors : errors).push(`${response.status()} ${response.url()}`);
  });
  return page;
}

async function capture(page, name) {
  await page.evaluate(() => document.fonts.ready);
  const layout = await page.evaluate(() => ({
    width: innerWidth, height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    regions: Object.fromEntries([".studio-sidebar", ".top-bar", ".composer", ".transcript", ".welcome"].map(selector => {
      const element = document.querySelector(selector);
      if (!element) return [selector, null];
      const rect = element.getBoundingClientRect();
      return [selector, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }];
    })),
  }));
  assert.equal(layout.scrollWidth, layout.width, `${name}: horizontal overflow`);
  assert.equal(layout.scrollHeight, layout.height, `${name}: outer app scroll`);
  const composer = layout.regions[".composer"];
  assert.ok(composer.y >= 0 && composer.y + composer.height <= layout.height, `${name}: composer outside viewport`);
  await page.screenshot({ path: `${evidence}/${name}.png`, animations: "disabled", caret: "hide" });
  results.push({ name, layout });
}

const sampleText = "我会先梳理现有资料，再整理成一份清晰的项目概览。\n\n## 项目概览\n\n- **项目定位**：整理工作区中的项目资料，让目标与进展一目了然。\n- **核心内容**：需求说明、技术方案与工作计划，按主题归纳关键内容。\n- **下一步**：核对文档中的待确认事项，形成一份便于团队阅读的项目概览。";

async function fixture(page, { signedOut = false, empty = false, interrupted = false } = {}) {
  const session = { id: "ses_design_fixture", title: "整理项目资料", createdAt: "2026-09-05T02:49:00Z", updatedAt: "2026-09-05T02:49:00Z", lastEventSeq: 0, activeTurnId: null };
  const sessions = [session, ...["为项目设计技术架构", "撰写需求规格说明书", "生成测试计划", "优化数据库查询", "项目周报总结", "代码审查与建议"].map((title, index) => ({ ...session, id: `ses_history_${index}`, title }))];
  let events = [];
  let socket;
  let sockets = 0;
  let afterReconnect;
  let started = 0;
  let decision = "pending";
  let planning;
  let forked = false;
  let resumed = false;
  function event(type, payload, turnId = "turn_design") {
    const item = { id: `evt_${events.length + 1}`, eventSeq: events.length + 1, type, sessionId: session.id, turnId, accountId: "fixture", scopeId: "workspace_fixture", occurredAt: "2026-09-05T02:49:00Z", payload };
    events.push(item);
    session.lastEventSeq = item.eventSeq;
    return item;
  }
  if (!empty) {
    event("turn.started", { status: "running", userMessage: "帮我整理工作区资料，写一份项目概览。", userMessageId: "msg_design" });
    event("tool.started", { toolCallId: "call_list", toolName: "list_files", displayText: "梳理目录" });
    event("tool.completed", { toolCallId: "call_list", toolName: "list_files", summary: "已梳理目录，找到四份项目文档。" });
    event("tool.started", { toolCallId: "call_read", toolName: "read_file", displayText: "阅读资料" });
    event("tool.completed", { toolCallId: "call_read", toolName: "read_file", summary: "已阅读资料，准备整理概览。" });
    event("assistant.delta", { delta: sampleText });
    event("turn.completed", { status: "completed" });
  }
  if (interrupted) session.activeTurnId = "turn_interrupted";
  await page.route("**/api/v1/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const send = body => route.fulfill({ json: body });
    if (url.pathname === "/api/v1/bootstrap") return send({
      ...bootstrap, sessions: empty ? [] : sessions,
      workspace: { ...bootstrap.workspace, name: "项目资料整理", root: "D:\\Workspace\\项目资料整理", fileCount: 17 },
      authentication: signedOut ? { status: "signed_out", account: null } : { status: "signed_in", account: { id: 1, userName: "道引用户", tenantId: 1 } },
      health: { ...bootstrap.health, capabilities: { ...bootstrap.health.capabilities, modelGateway: signedOut ? "requires_login" : "ready" } },
    });
    if (url.pathname.endsWith("/auth/login")) return send({ authorizationUrl: `${origin}/fixture-oauth` });
    if (url.pathname === "/api/v1/sessions/search") {
      const hits = sessions.filter(item => item.title.includes(url.searchParams.get("q"))).map(item => ({ session: item, matchedText: "匹配项目资料", matchedEventSeq: 1 }));
      return send({ hits });
    }
    if (url.pathname === "/api/v1/sessions" && request.method() === "POST") return send({ session });
    if (url.pathname.endsWith("/events")) {
      const current = sessions.find(item => url.pathname.includes(item.id)) ?? session;
      return send({ session: current, events: current.id === session.id ? events : [], lastEventSeq: current.id === session.id ? session.lastEventSeq : 0 });
    }
    if (url.pathname.endsWith("/permissions")) return send([]);
    if (url.pathname.endsWith("/workspace/files")) return send({ files: ["README.md", "docs/需求说明.md", "docs/技术方案.md", "docs/项目计划.md"] });
    if (url.pathname.endsWith("/orchestration")) return send({ goals: [], workflows: [], workflowRuns: [], childRuns: [] });
    if (url.pathname.endsWith("/forks")) {
      forked = true;
      const branch = { ...session, id: "ses_branch", title: "整理项目资料 · 分支", activeTurnId: null, lastEventSeq: 0, forkedFrom: { sourceSessionId: session.id, sourceEventSeq: session.lastEventSeq } };
      sessions.push(branch);
      return send({ session: branch, sourceSession: session });
    }
    if (url.pathname.endsWith("/resume")) {
      resumed = true;
      session.activeTurnId = null;
      return send({ session, interruptedTurnId: "turn_interrupted" });
    }
    if (url.pathname.endsWith("/decision")) {
      decision = request.postDataJSON().approve ? "approved" : "denied";
      return send({ id: "permission_fixture", status: decision });
    }
    if (url.pathname.endsWith("/turns")) {
      started++;
      planning = request.postDataJSON().planning;
      session.activeTurnId = "turn_permission";
      event("turn.started", { status: "running", userMessage: request.postDataJSON().message, userMessageId: "msg_permission" }, "turn_permission");
      event("tool.started", { toolCallId: "call_permission", toolName: "run_package_script", displayText: "运行工作区检查" }, "turn_permission");
      event("tool.failed", { toolCallId: "call_permission", toolName: "run_package_script", message: "执行前需要你的许可", details: { permissionRequestId: "permission_fixture", displayCommand: "npm run check", risk: "workspace-write", reason: "此操作会运行工作区脚本。", status: decision } }, "turn_permission");
      return send({ turnId: "turn_permission", status: "running" });
    }
    if (url.pathname.endsWith("/cancel")) {
      session.activeTurnId = null;
      const item = event("turn.cancelled", { status: "cancelled", source: "user", lastCompletedEventSeq: session.lastEventSeq }, "turn_permission");
      socket.send(JSON.stringify({ type: "event", event: item, session }));
      return send({ status: "cancelling" });
    }
    throw new Error(`Unmocked API request: ${request.method()} ${url.pathname}`);
  });
  await page.route(`${origin}/fixture-oauth`, route => route.fulfill({ contentType: "text/html", body: "<h1>OAuth redirect fixture</h1>" }));
  await page.routeWebSocket("**/events/ws**", ws => {
    socket = ws;
    sockets++;
    afterReconnect = Number(new URL(ws.url()).searchParams.get("after"));
    const current = sessions.find(item => ws.url().includes(item.id)) ?? session;
    if (current.id === session.id) for (const item of events) ws.send(JSON.stringify({ type: "event", event: item, session }));
    ws.send(JSON.stringify({ type: "ready", session: current, lastEventSeq: current.lastEventSeq }));
  });
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByRole("textbox", { name: "任务描述" }).waitFor();
  return {
    get state() { return { sockets, afterReconnect, started, decision, planning, forked, resumed, lastEventSeq: session.lastEventSeq }; },
    disconnect() { socket.close(); },
    appendMarkdown(text) {
      const item = event("assistant.delta", { delta: text });
      socket.send(JSON.stringify({ type: "event", event: item, session }));
    },
  };
}

try {
  await mkdir(evidence, { recursive: true });
  const live = await pageAt();
  await live.goto(origin, { waitUntil: "networkidle" });
  bootstrap = await (await live.request.get(`${origin}/api/v1/bootstrap`)).json();
  await capture(live, "render-live");
  results.push({ name: "live-runtime", evidence: "Read-only real local runtime; no model call or session mutation" });
  await live.context().close();

  const desktop = await pageAt();
  const controls = await fixture(desktop);
  await desktop.getByRole("heading", { name: "项目概览", exact: true }).waitFor();
  await desktop.getByRole("button", { name: "仔细规划" }).click();
  await desktop.getByRole("textbox", { name: "任务描述" }).fill("继续整理");
  await desktop.getByRole("textbox", { name: "任务描述" }).blur();
  await capture(desktop, "render-desktop");
  await desktop.getByRole("button", { name: "复制回答" }).click();
  assert.equal((await desktop.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n"), sampleText);
  await desktop.getByRole("button", { name: "收起对话列表" }).click();
  assert.equal(await desktop.locator(".studio-sidebar").isVisible(), false);
  await desktop.getByRole("button", { name: "展开对话列表" }).click();
  assert.equal(await desktop.locator(".studio-sidebar").isVisible(), true);
  const search = desktop.getByRole("textbox", { name: "搜索会话" });
  await search.fill("不存在的对话");
  await desktop.getByText("没有匹配的会话").waitFor();
  await search.fill("项目资料");
  await desktop.waitForFunction(() => document.querySelectorAll(".session-row").length === 1);
  await search.fill("");
  await desktop.waitForFunction(() => document.querySelectorAll(".session-row").length === 7);
  await desktop.locator(".sidebar-primary").getByRole("button", { name: "工作区", exact: true }).click();
  await desktop.getByText("docs/需求说明.md", { exact: true }).waitFor();
  await capture(desktop, "render-files");
  await desktop.keyboard.press("Escape");
  await desktop.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "工作区");
  await desktop.getByRole("button", { name: "任务状态", exact: true }).click();
  await desktop.getByText("当前没有持久目标").waitFor();
  await capture(desktop, "render-tasks");
  await desktop.keyboard.press("Escape");
  await desktop.getByRole("button", { name: "道引科技账号", exact: true }).click();
  await desktop.getByRole("button", { name: "退出登录" }).waitFor();
  await desktop.keyboard.press("Escape");
  await desktop.getByRole("button", { name: "发送任务", exact: true }).click();
  await desktop.getByRole("button", { name: "拒绝", exact: true }).waitFor();
  assert.equal(controls.state.planning, true);
  await capture(desktop, "render-permission");
  await desktop.getByRole("button", { name: "拒绝", exact: true }).click();
  await desktop.getByRole("button", { name: "改为允许一次", exact: true }).click();
  assert.equal(controls.state.decision, "approved");
  await desktop.getByRole("textbox", { name: "任务描述" }).fill("重复发送");
  await desktop.getByRole("textbox", { name: "任务描述" }).press("Enter");
  assert.equal(controls.state.started, 1);
  await desktop.getByRole("button", { name: "停止当前任务" }).click();
  await desktop.getByText("已停止", { exact: true }).waitFor();
  const lastSeq = controls.state.lastEventSeq;
  const socketsBefore = controls.state.sockets;
  controls.disconnect();
  for (let attempt = 0; attempt < 50 && controls.state.sockets === socketsBefore; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(controls.state.sockets > socketsBefore);
  assert.equal(controls.state.afterReconnect, lastSeq);
  assert.equal(await desktop.locator(".turn").count(), 2);
  await desktop.reload({ waitUntil: "networkidle" });
  await desktop.getByText("已停止", { exact: true }).waitFor();
  assert.equal(await desktop.locator(".turn").count(), 2);
  await desktop.getByRole("button", { name: "分叉", exact: true }).click();
  await desktop.getByText("已从“整理项目资料”创建分支。").waitFor();
  assert.equal(controls.state.forked, true);
  await desktop.getByRole("button", { name: "新对话", exact: true }).click();
  await desktop.getByRole("heading", { name: "今天，想完成什么？" }).waitFor();
  await capture(desktop, "render-welcome");
  await desktop.getByRole("button", { name: "整理文件", exact: true }).click();
  assert.equal(await desktop.getByRole("textbox", { name: "任务描述" }).inputValue(), "帮我梳理工作区资料");
  results.push({ name: "fixture-interactions", evidence: "Mocked APIs/WebSocket in real Edge", copy: true, search: true, sidebar: true, files: true, tasks: true, permissionDenyApprove: true, planning: true, duplicateSubmitBlocked: true, cancel: true, replay: true, reconnectFrom: lastSeq, fork: true, newConversation: true, suggestion: true });
  await desktop.context().close();

  for (const [width, height] of [[1280, 720], [768, 1024], [390, 844], [320, 740]]) {
    const page = await pageAt(width, height);
    const control = await fixture(page);
    await page.getByRole("heading", { name: "项目概览", exact: true }).waitFor();
    await capture(page, `render-${width}`);
    control.appendMarkdown('\n\n| 文档 | 用途 |\n| --- | --- |\n| 需求文档 | 跟踪资料 |\n\n```ts\nconst longLine = "' + "x".repeat(300) + '";\n```\n\n<script>alert(1)</script>\n\n![远程图片](https://tracker.invalid/pixel.png)');
    await page.locator(".markdown-table").waitFor();
    assert.equal(await page.locator(".assistant-text img, .assistant-text script").count(), 0);
    await capture(page, `markdown-${width}`);
    if (width <= 800) {
      await page.getByRole("button", { name: "打开会话导航" }).click();
      await page.getByRole("button", { name: "DaoyinHarness 首页", exact: true }).focus();
      await page.keyboard.press("Shift+Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "道引科技账号");
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "DaoyinHarness 首页");
      await page.getByRole("textbox", { name: "搜索会话" }).fill("不存在的对话");
      await page.getByText("没有匹配的会话").waitFor();
      await capture(page, `navigation-${width}`);
      await page.keyboard.press("Escape");
      assert.equal(await page.locator(".studio-sidebar").isVisible(), false);
    }
    await page.getByRole("button", { name: "查看工作区文件" }).click();
    await page.getByText("docs/需求说明.md", { exact: true }).waitFor();
    await capture(page, `files-${width}`);
    await page.keyboard.press("Escape");
    await page.context().close();
  }

  const recovery = await pageAt();
  const recoveryControl = await fixture(recovery, { interrupted: true });
  await recovery.getByRole("button", { name: "恢复", exact: true }).click();
  await recovery.getByText("会话已恢复，可以继续。").waitFor();
  assert.equal(recoveryControl.state.resumed, true);
  await recovery.context().close();

  const signedOut = await pageAt(390, 844);
  await fixture(signedOut, { signedOut: true, empty: true });
  await signedOut.getByRole("textbox", { name: "任务描述" }).fill("登录前的草稿");
  assert.equal(await signedOut.getByRole("button", { name: "发送任务", exact: true }).isDisabled(), true);
  await capture(signedOut, "render-signed-out");
  await signedOut.getByRole("button", { name: "连接道引账号", exact: true }).click();
  await signedOut.waitForURL(`${origin}/fixture-oauth`);
  results.push({ name: "authentication-and-recovery", loginRedirect: true, signedOutSendDisabled: true, resume: true, evidence: "Mocked API; no credentials submitted" });
  await signedOut.context().close();

  const failure = await pageAt(390, 844, true);
  await failure.route("**/api/v1/bootstrap", route => route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "本地服务暂时不可用" } } }));
  await failure.goto(origin, { waitUntil: "networkidle" });
  await failure.getByRole("heading", { name: "连接暂时中断" }).waitFor();
  assert.equal(await failure.getByRole("textbox", { name: "任务描述" }).isDisabled(), true);
  await capture(failure, "render-error");
  await failure.context().close();
  assert.deepEqual(errors, []);
  assert.deepEqual(failedRequests, []);
} finally {
  await browser.close();
  await writeFile(`${evidence}/browser-verification.json`, JSON.stringify({ origin, capturedAt: new Date().toISOString(), results, errors, failedRequests, expectedErrors }, null, 2));
}
console.log(JSON.stringify({ passed: results.length, errors, failedRequests, expectedErrorCount: expectedErrors.length }));
