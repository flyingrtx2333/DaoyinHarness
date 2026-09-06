/* global document, innerWidth, innerHeight -- Playwright page.evaluate callbacks run in the browser. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

// Browser fixtures exercise real UI state transitions without calling a paid model.
const origin = "http://127.0.0.1:4677";
const evidence = "evidence/ui-concepts";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const results = [];
const errors = [];
const failedRequests = [];
const oauth = new URL("http://127.0.0.1:6087/api/oauth/authorize");
oauth.search = new URLSearchParams({
  client_id: "daoyin-harness", response_type: "code",
  redirect_uri: origin + "/api/v1/auth/callback",
  code_challenge: "a".repeat(43), code_challenge_method: "S256",
  state: "ui-verification-state", scope: "harness:ai",
}).toString();

async function pageAt(width, height) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text() + " " + message.location().url); });
  page.on("requestfailed", (request) => {
    if (request.failure()?.errorText !== "net::ERR_ABORTED") failedRequests.push(request.url());
  });
  return page;
}
async function capture(page, name) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: evidence + "/" + name + ".png", animations: "disabled", caret: "hide" });
  const layout = await page.evaluate(() => ({
    width: innerWidth, height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  assert.equal(layout.scrollWidth, layout.width, name + " has horizontal overflow");
  results.push({ name, layout });
}

try {
  await mkdir(evidence, { recursive: true });
  const desktop = await pageAt(1586, 992);
  await desktop.goto(origin, { waitUntil: "networkidle" });
  await desktop.getByRole("heading", { name: "让想法，继续生长。" }).waitFor();
  await capture(desktop, "agent-workbench/render-desktop");
  await desktop.getByRole("button", { name: "收起对话列表" }).click();
  assert.equal(await desktop.locator(".studio-sidebar").isVisible(), false);
  await desktop.getByRole("button", { name: "展开对话列表" }).click();
  assert.equal(await desktop.locator(".studio-sidebar").isVisible(), true);
  await desktop.locator(".app-rail").getByRole("button", { name: "工作区", exact: true }).click();
  await desktop.getByRole("button", { name: "关闭工作区文件" }).waitFor();
  await capture(desktop, "agent-workbench/render-files");
  await desktop.keyboard.press("Escape");
  assert.equal(await desktop.locator(".file-panel").count(), 0);
  assert.equal(await desktop.evaluate(() => document.activeElement?.textContent), "工作区");
  await desktop.locator(".app-rail").getByRole("button", { name: "任务", exact: true }).click();
  await desktop.getByText("当前没有持久目标").waitFor();
  await capture(desktop, "agent-workbench/render-tasks");
  await desktop.getByRole("button", { name: "关闭任务状态" }).click();
  await desktop.getByRole("button", { name: "道引科技账号", exact: true }).click();
  await desktop.getByRole("region", { name: "道引科技账号" }).waitFor();
  await desktop.keyboard.press("Escape");
  await desktop.getByRole("textbox", { name: "任务描述" }).fill("登录前保留的草稿");
  assert.equal(await desktop.locator("button.send-button").isDisabled(), true);
  await desktop.getByRole("button", { name: "仔细规划" }).click();
  assert.equal(await desktop.getByRole("button", { name: "仔细规划" }).getAttribute("aria-pressed"), "true");
  await desktop.getByRole("button", { name: "登录道引账号" }).click();
  await desktop.waitForURL(/6087\/api\/oauth\/authorize/);
  assert.equal(await desktop.getByRole("button", { name: "登录并授权" }).count(), 1);
  await capture(desktop, "oauth-consent/render-desktop");
  assert.equal(await desktop.evaluate(() => document.documentElement.scrollHeight), 992);
  await desktop.close();

  for (const [width, height] of [[768, 1024], [390, 844], [320, 740]]) {
    const page = await pageAt(width, height);
    await page.goto(origin, { waitUntil: "networkidle" });
    await capture(page, "agent-workbench/render-" + width);
    await page.getByRole("button", { name: "打开会话导航" }).click();
    await page.getByRole("textbox", { name: "搜索会话" }).fill("不存在的对话");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".studio-sidebar").isVisible(), false);
    await page.locator(".app-rail").getByRole("button", { name: "工作区", exact: true }).click();
    await capture(page, "agent-workbench/files-" + width);
    await page.keyboard.press("Escape");
    await page.goto(oauth.href, { waitUntil: "networkidle" });
    await capture(page, "oauth-consent/render-" + width);
    await page.getByRole("button", { name: "登录并授权" }).click();
    assert.equal(await page.locator("#user_name").evaluate((input) => input.validity.valueMissing), true);
    await page.close();
  }

  const smallDesktop = await pageAt(1280, 720);
  await smallDesktop.goto(oauth.href, { waitUntil: "networkidle" });
  await capture(smallDesktop, "oauth-consent/render-720h");
  assert.equal(await smallDesktop.evaluate(() => document.documentElement.scrollHeight), 720);
  // Local browser fixture for the error state; never submits real credentials.
  await smallDesktop.locator(".auth-form form").evaluate((form) => {
    const error = document.createElement("p");
    error.className = "error";
    error.role = "alert";
    error.textContent = "账号、手机号或密码错误，请重试。";
    form.before(error);
  });
  await capture(smallDesktop, "oauth-consent/render-error");
  assert.equal(await smallDesktop.evaluate(() => document.documentElement.scrollHeight), 720);
  await smallDesktop.close();

  const fixture = await pageAt(1586, 992);
  const session = { id: "ses_ui_fixture", title: "整理工作区资料", createdAt: "2026-09-05T00:00:00Z", updatedAt: "2026-09-05T00:00:00Z", lastEventSeq: 0, activeTurnId: null };
  let events = [];
  let sockets = 0;
  let afterReconnect = null;
  let socket;
  let started = 0;
  let permissionStatus = "pending";
  function event(type, payload) {
    const item = { id: "evt_" + (events.length + 1), eventSeq: events.length + 1, type, sessionId: session.id, turnId: "turn_fixture", accountId: "fixture", scopeId: "workspace_fixture", occurredAt: "2026-09-05T00:00:00Z", payload };
    events.push(item);
    session.lastEventSeq = item.eventSeq;
    return item;
  }
  await fixture.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const send = (body) => route.fulfill({ json: body });
    if (url.pathname === "/api/v1/bootstrap") {
      const response = await route.fetch();
      const bootstrap = await response.json();
      return send({ ...bootstrap, sessions: [session], authentication: { status: "signed_in", account: { id: 1, userName: "体验账号", tenantId: 1 } }, health: { ...bootstrap.health, capabilities: { ...bootstrap.health.capabilities, modelGateway: "ready" } } });
    }
    if (url.pathname.endsWith("/events")) return send({ session, events, lastEventSeq: session.lastEventSeq });
    if (url.pathname.endsWith("/permissions")) return send([]);
    if (url.pathname.endsWith("/decision")) { permissionStatus = "approved"; return send({ id: "permission_fixture", status: permissionStatus }); }
    if (url.pathname.endsWith("/turns")) {
      started++;
      session.activeTurnId = "turn_fixture";
      event("turn.started", { status: "running", userMessage: route.request().postDataJSON().message, userMessageId: "msg_fixture" });
      event("tool.started", { toolCallId: "call_fixture", toolName: "run_package_script", displayText: "运行工作区检查" });
      event("tool.failed", { toolCallId: "call_fixture", toolName: "run_package_script", message: "执行前需要你的许可", details: { permissionRequestId: "permission_fixture", displayCommand: "npm run check", risk: "workspace-write", reason: "此操作会运行工作区脚本。", status: permissionStatus } });
      return send({ turnId: "turn_fixture", status: "running" });
    }
    if (url.pathname.endsWith("/cancel")) {
      session.activeTurnId = null;
      const item = event("turn.cancelled", { status: "cancelled", source: "user", lastCompletedEventSeq: session.lastEventSeq });
      socket.send(JSON.stringify({ type: "event", event: item, session }));
      return send({ status: "cancelling" });
    }
    return route.continue();
  });
  await fixture.routeWebSocket("**/events/ws**", (ws) => {
    socket = ws;
    sockets++;
    if (sockets > 1) {
      afterReconnect = new URL(ws.url()).searchParams.get("after");
      for (const item of events) ws.send(JSON.stringify({ type: "event", event: item, session }));
    }
    ws.send(JSON.stringify({ type: "ready", session, lastEventSeq: session.lastEventSeq }));
  });
  await fixture.goto(origin, { waitUntil: "networkidle" });
  await fixture.getByRole("textbox", { name: "任务描述" }).fill("整理资料，并运行工作区检查。");
  await fixture.locator("button.send-button").click();
  await fixture.getByRole("button", { name: "允许一次", exact: true }).waitFor();
  await fixture.getByRole("button", { name: "允许一次", exact: true }).click();
  assert.equal(permissionStatus, "approved");
  await capture(fixture, "agent-workbench/render-permission");
  // A second Enter while a turn runs must not issue another request.
  await fixture.getByRole("textbox", { name: "任务描述" }).fill("重复发送");
  await fixture.getByRole("textbox", { name: "任务描述" }).press("Enter");
  assert.equal(started, 1);
  await fixture.getByRole("button", { name: "停止当前任务" }).click();
  await fixture.getByText("已停止", { exact: true }).waitFor();
  const beforeReconnect = events.length;
  socket.close();
  await fixture.waitForFunction(() => document.querySelectorAll(".turn").length === 1);
  for (let attempt = 0; attempt < 30 && sockets < 2; attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(sockets >= 2, "WebSocket reconnect did not occur");
  assert.equal(Number(afterReconnect), beforeReconnect);
  assert.equal(await fixture.locator(".turn").count(), 1);
  const verifiedReconnectFrom = afterReconnect;
  await capture(fixture, "agent-workbench/render-conversation");
  await fixture.reload({ waitUntil: "networkidle" });
  await fixture.getByText("已停止", { exact: true }).waitFor();
  assert.equal(await fixture.locator(".turn").count(), 1);
  results.push({ name: "fixture-interactions", permission: "approved", duplicateSubmitBlocked: true, cancel: true, reconnectFrom: verifiedReconnectFrom, refreshReplay: true, evidence: "mocked API and WebSocket, real browser UI" });
  await fixture.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(failedRequests, []);
} finally {
  await browser.close();
  await writeFile(evidence + "/browser-verification.json", JSON.stringify({ results, errors, failedRequests }, null, 2));
}
console.log(JSON.stringify({ passed: results.length, errors, failedRequests }));
