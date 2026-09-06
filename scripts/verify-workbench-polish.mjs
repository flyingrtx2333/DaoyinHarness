/* global document, innerWidth, innerHeight, getComputedStyle, requestAnimationFrame -- Browser callbacks. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

if (process.platform !== "win32") throw new Error("Run this acceptance script from Windows PowerShell, not WSL.");
const origin = new URL(process.env.HARNESS_UI_ORIGIN ?? "http://127.0.0.1:4677");
if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1") throw new Error("Use a loopback Harness runtime.");
const evidence = `evidence/ui-polish-20260905/run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
await mkdir(evidence, { recursive: true });
const results = [];
const errors = [];
let verdict = "failed";
const browser = await chromium.launch({ channel: "msedge", headless: true });

// Entire API and WebSocket are fixtures. No user account, model, local session,
// native picker, workspace switch or paid operation is invoked by this script.
const session = { id: "ses_polish_fixture", title: "界面验收资料", createdAt: "2026-09-05T00:00:00Z", updatedAt: "2026-09-05T00:00:00Z", activeTurnId: null, lastEventSeq: 0 };
const events = [];
function event(type, payload, turnId) {
  const item = { id: `evt_polish_${events.length + 1}`, eventSeq: events.length + 1, accountId: "fixture", scopeId: "fixture", sessionId: session.id, turnId, occurredAt: "2026-09-05T00:00:00Z", type, payload };
  events.push(item); session.lastEventSeq = item.eventSeq; return item;
}
for (let i = 0; i < 12; i++) {
  event("turn.started", { status: "running", userMessage: `整理第 ${i + 1} 份资料`, userMessageId: `msg_${i}` }, `turn_${i}`);
  event("assistant.delta", { delta: `## 资料 ${i + 1}\n\n这是明确标记的界面测试数据，不是用户会话。\n\n${"用于验证长对话阅读、紧凑排版和滚动位置保留。".repeat(8)}\n\n- 重点一\n- 重点二` }, `turn_${i}`);
  event("turn.completed", { status: "completed" }, `turn_${i}`);
}
const fixture = {
  csrfToken: "fixture-only", workspaceRevision: "fixture-revision", sessions: [session], tools: [], mcpServers: [],
  workspace: { name: "验收资料", root: "D:\\Workspace\\验收资料", fileCount: 40 },
  authentication: { status: "signed_in", account: { id: 1, tenantId: 1, userName: "测试账号" } },
  health: { status: "ready", version: "fixture", capabilities: { modelGateway: "ready" } },
  sandbox: { mode: "auto", provider: "none", available: false, osIsolation: "none", networkIsolation: "none", reason: "UI fixture" },
};
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference", deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  page.on("requestfailed", request => { if (request.failure()?.errorText !== "net::ERR_ABORTED") errors.push(`request failed: ${request.url()}`); });
  let socket;
  let socketCount = 0;
  await page.route("**/api/v1/**", async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() !== "GET") {
      errors.push(`Unexpected mutation: ${pathname}`);
      return route.fulfill({ status: 405, json: { error: { message: "Mutation blocked by UI fixture" } } });
    }
    const send = json => route.fulfill({ json });
    if (pathname.endsWith("/bootstrap")) return send(fixture);
    if (pathname.endsWith("/events")) return send({ session, events, lastEventSeq: session.lastEventSeq });
    if (pathname.endsWith("/permissions")) return send([]);
    if (pathname.endsWith("/workspace/files")) return send({ root: fixture.workspace.root, files: Array.from({ length: 40 }, (_, i) => `docs/资料-${i + 1}.md`) });
    if (pathname.endsWith("/workspaces")) return send({ recent: [{ ...fixture.workspace, openedAt: "2026-09-05T00:00:00Z" }], nativePickerAvailable: false });
    if (pathname.endsWith("/orchestration")) return send({ goals: [], workflows: [], workflowRuns: [], childRuns: [] });
    if (pathname.endsWith("/sessions/search")) return send({ query: "", hits: [] });
    errors.push(`Unmocked API: ${pathname}`);
    return route.fulfill({ status: 404, json: { error: { message: "Unknown fixture route" } } });
  });
  await page.routeWebSocket("**/events/ws**", ws => {
    socket = ws; socketCount++;
    const after = Number(new URL(ws.url()).searchParams.get("after") ?? 0);
    for (const item of events.filter(item => item.eventSeq > after)) ws.send(JSON.stringify({ type: "event", event: item, session }));
    ws.send(JSON.stringify({ type: "ready", session, lastEventSeq: session.lastEventSeq }));
  });
  async function capture(name) {
    await page.evaluate(() => document.fonts.ready);
    const layout = await page.evaluate(() => {
      const composer = document.querySelector(".composer").getBoundingClientRect();
      return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
        composer: { x: composer.x, y: composer.y, width: composer.width, height: composer.height } };
    });
    assert.equal(layout.scrollWidth, layout.width, `${name}: horizontal overflow`);
    assert.equal(layout.scrollHeight, layout.height, `${name}: outer page scroll`);
    assert.ok(layout.composer.x >= 0 && layout.composer.y >= 0 && layout.composer.y + layout.composer.height <= layout.height + 1);
    await page.screenshot({ path: `${evidence}/${name}.png`, animations: "disabled", caret: "hide" });
    results.push({ name, layout });
  }
  await page.goto(origin.origin, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelectorAll(".turn").length === 12);
  await page.waitForFunction(() => [...document.images].filter(image => image.classList.contains("brand-mark")).every(image => image.complete && image.naturalWidth > 0));
  assert.ok(await page.locator('img.brand-mark[src="/assets/harness-logo.png"]').count() > 0);
  assert.ok((await page.locator('link[rel="icon"]').getAttribute("href")).includes("harness-logo.png"));
  const sizes = await page.evaluate(() => ({ sidebar: document.querySelector(".studio-sidebar").getBoundingClientRect().width,
    header: document.querySelector(".top-bar").getBoundingClientRect().height,
    account: document.querySelector(".sidebar-account").getBoundingClientRect().height }));
  assert.equal(sizes.sidebar, 240); assert.equal(sizes.header, 52); assert.ok(sizes.account <= 48);
  results.push({ name: "compact-layout-and-local-logo", sizes });
  await capture("desktop");

  const animation = await page.evaluate(async () => {
    const sidebar = document.querySelector(".studio-sidebar");
    const width = sidebar.getBoundingClientRect().width;
    document.querySelector(".sidebar-collapse").click();
    const samples = [];
    for (let i = 0; i < 24; i++) { await new Promise(requestAnimationFrame); samples.push(sidebar.getBoundingClientRect().x); }
    return { width, samples, inert: sidebar.inert };
  });
  assert.ok(animation.samples.some(x => x < -1 && x > -animation.width + 1), "Sidebar must have actual intermediate animation frames");
  assert.equal(animation.inert, true);
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".studio-sidebar")).visibility === "hidden");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector(".studio-shell").classList.contains("history-hidden"));
  assert.equal(await page.locator(".studio-sidebar").evaluate(element => element.inert), true);
  await page.getByRole("button", { name: "展开对话列表", exact: true }).click();
  await page.waitForFunction(() => Math.abs(document.querySelector(".studio-sidebar").getBoundingClientRect().x) < 1);
  results.push({ name: "sidebar-motion-and-persistence", animation });

  await page.getByRole("button", { name: "查看工作区文件", exact: true }).click();
  await page.locator('.file-panel[aria-label="工作区文件"].is-open').waitFor();
  await capture("files");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "查看工作区文件");
  assert.equal(await page.locator('.file-panel[aria-label="工作区文件"]').count(), 1, "Keep the closing drawer mounted for its exit transition");
  assert.equal(await page.locator('.file-panel[aria-label="工作区文件"]').evaluate(element => element.inert), true);
  await page.getByRole("button", { name: "切换工作区", exact: true }).click();
  await page.locator("dialog[open]").waitFor();
  await page.keyboard.press("Escape");
  await page.locator(".workspace-dialog").waitFor({ state: "detached" });
  results.push({ name: "drawer-exit-focus-and-dialog-close" });

  await page.locator(".transcript").evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
  session.activeTurnId = "turn_live";
  for (const item of [event("turn.started", { status: "running", userMessage: "流式更新验收", userMessageId: "msg_live" }, "turn_live"), event("assistant.delta", { delta: "新消息不会把正在阅读历史的用户拉回底部。" }, "turn_live")]) {
    socket.send(JSON.stringify({ type: "event", event: item, session }));
  }
  await page.waitForFunction(() => document.querySelectorAll(".turn").length === 13);
  assert.ok(await page.locator(".transcript").evaluate(element => element.scrollTop < 5));
  results.push({ name: "preserve-reader-scroll-position" });

  for (const [width, height] of [[1280, 720], [768, 1024], [390, 844], [320, 740]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(280);
    await capture(`viewport-${width}`);
    if (width <= 800) {
      await page.getByRole("button", { name: "打开会话导航", exact: true }).click();
      await page.waitForFunction(() => document.querySelector(".studio-sidebar").getBoundingClientRect().x > -1);
      assert.equal(await page.locator("#agent-main").evaluate(element => element.inert), true);
      await page.getByRole("button", { name: "DaoyinHarness 首页", exact: true }).focus();
      await page.keyboard.press("Shift+Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "道引科技账号");
      await capture(`navigation-${width}`);
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "打开会话导航");
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForTimeout(50);
  assert.equal(await page.locator(".studio-sidebar").evaluate(element => getComputedStyle(element).transitionDuration), "0s");
  results.push({ name: "reduced-motion" });

  const socketsBefore = socketCount;
  await socket.close({ code: 1008, reason: "account changed; refresh required" });
  await page.locator(".welcome.error-state").waitFor();
  assert.equal(await page.locator(".session-row").count(), 0);
  assert.equal(await page.locator(".turn").count(), 0);
  await page.waitForTimeout(700);
  assert.equal(socketCount, socketsBefore, "Policy closure must not trigger an endless reconnect loop");
  results.push({ name: "account-change-clears-stale-ui-and-stops-reconnect" });
  assert.deepEqual(errors, []);
  verdict = "passed";
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await browser.close();
  const report = { checkedAt: new Date().toISOString(), platform: process.platform, node: process.version,
    environment: "Windows / Edge; real compiled UI; all APIs and WebSockets mocked; no model calls or user-data mutations", verdict, results, errors };
  await writeFile(`${evidence}/acceptance.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ verdict, checks: results.length, errors, evidence }, null, 2));
}
