/* global document, window, getComputedStyle, MutationObserver */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

if (process.platform !== "win32") throw new Error("Windows acceptance required.");
const release = JSON.parse(execFileSync(process.execPath, ["scripts/build-workbench-release.mjs", ...(process.argv.includes("--committed") ? [] : ["--preview"])], { encoding: "utf8", windowsHide: true }));
const output = resolve(".cache/streaming-ui-20260906");
await mkdir(output, { recursive: true });
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  const file = path === "/harness/" ? "index.html" : path.slice(9);
  if (!Object.hasOwn(release.files, file)) { res.writeHead(404); res.end(); return; }
  res.setHeader("content-type", file.endsWith(".html") ? "text/html" : file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : "image/png");
  res.end(await readFile(resolve(release.output, file)));
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: "msedge", headless: true });
const checks = []; const errors = [];
try {
  for (const width of [1280, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.on("pageerror", error => errors.push(error.message));
    const template = { sessionId: "session_a", authorizationId: "grant_a", billingAccountId: "payer_a", createdAt: new Date().toISOString(), cancelRequested: false };
    const old = { ...template, id: "old", requestId: "old-request", userMessage: "旧问题", finalText: "旧回答必须留在原处", status: "completed", lastEventSeq: 1 };
    let current; let submitted = false; let failures = 0;
    const events = [{ id: "event_1", eventSeq: 1, type: "assistant.delta", accountId: "a", scopeId: "a", sessionId: "session_a", turnId: "old", occurredAt: template.createdAt, payload: { contentBlockId: "old", delta: old.finalText } }];
    const cursors = [];
    const emit = (type, payload) => { const seq = events.length + 1; events.push({ ...events[0], id: `event_${seq}`, eventSeq: seq, turnId: "new", occurredAt: new Date().toISOString(), type, payload }); current.lastEventSeq = seq; };
    await page.route("**/api/**", async route => {
      const req = route.request(); const url = new URL(req.url());
      if (url.pathname.endsWith("/bootstrap")) return route.fulfill({ json: { csrfToken: "fixture", expiresAt: Date.now() + 86400000, profileId: "saishi-readonly", authentication: "account", accountScope: "a", account: { username: "流式测试" } } });
      if (url.pathname.endsWith("/sessions")) return route.fulfill({ json: { sessions: [{ id: "session_a", title: "测试会话", profileId: "saishi-readonly", createdAt: template.createdAt }] } });
      if (url.pathname.endsWith("/runs") && req.method() === "POST") {
        submitted = true;
        await new Promise(resolve => setTimeout(resolve, 650));
        current = { ...template, id: "new", requestId: req.postDataJSON().requestId, userMessage: req.postDataJSON().message, finalText: "", status: "running", lastEventSeq: 1 };
        return route.fulfill({ status: 202, json: { run: current } });
      }
      if (url.pathname.endsWith("/runs")) return route.fulfill({ json: { runs: current ? [current, old] : [old] } });
      if (url.pathname.endsWith("/events")) {
        const after = Number(url.searchParams.get("after")); if (submitted) cursors.push(after);
        if (failures) { failures--; return route.fulfill({ status: 503, json: {} }); }
        return route.fulfill({ json: { events: events.filter(event => event.eventSeq > after), hasMore: false, nextEventSeq: events.length } });
      }
      if (url.pathname.endsWith("/cancel")) { current.status = "cancelled"; current.cancelRequested = true; emit("turn.cancelled", { status: "cancelled", source: "user", lastCompletedEventSeq: events.length }); return route.fulfill({ json: { run: current } }); }
      throw new Error(`Unexpected fixture route ${url.pathname}`);
    });
    await page.goto(base + "/harness/?app=saishi");
    await page.getByText(old.finalText, { exact: true }).waitFor();
    const original = await page.locator("article.turn").first().elementHandle();
    await page.evaluate(() => { window.detachedHistory = false; const node = document.querySelector("article.turn"); new MutationObserver(() => { if (!node.isConnected) window.detachedHistory = true; }).observe(document.querySelector(".conversation-content"), { childList: true, subtree: true }); });
    await page.locator("#message").fill("现在开始流式回复");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.getByRole("article", { name: "正在发送的问题" }).waitFor();
    assert.equal(await original.evaluate(node => node.isConnected), true);
    await page.getByText("正在处理你的问题…", { exact: true }).waitFor();
    emit("tool.started", { toolCallId: "query", toolName: "saishi_list_events", displayText: "internal name" });
    await page.getByText("正在查询赛事列表…", { exact: true }).waitFor();
    assert.equal(await page.locator('.tool-line[data-status="running"] .spinner').evaluate(node => getComputedStyle(node).animationName), "spin");
    await page.screenshot({ path: resolve(output, `tool-running-${width}.png`), fullPage: true });
    emit("tool.completed", { toolCallId: "query", toolName: "saishi_list_events", summary: "PRIVATE_RESULT", evidence: { result: {} } });
    emit("assistant.delta", { contentBlockId: "answer", delta: "第一段回复" });
    await page.getByText("第一段回复", { exact: true }).waitFor();
    assert.equal(await page.getByText("PRIVATE_RESULT", { exact: true }).count(), 0);
    assert.equal(current.status, "running");
    assert.equal(await page.getByText("正在回复…", { exact: true }).count(), 1);
    emit("assistant.delta", { contentBlockId: "answer", delta: "，第二段追加" });
    await page.getByText("第一段回复，第二段追加", { exact: true }).waitFor();
    failures = 1;
    await page.getByRole("alert").waitFor();
    assert.equal(await original.evaluate(node => node.isConnected), true);
    emit("assistant.delta", { contentBlockId: "answer", delta: "，中断后恢复" });
    await page.getByText("第一段回复，第二段追加，中断后恢复", { exact: true }).waitFor();
    await page.getByRole("button", { name: "停止生成" }).click();
    await page.getByText("已停止", { exact: true }).waitFor();
    assert.equal(await page.getByText("第一段回复，第二段追加，中断后恢复", { exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => window.detachedHistory), false);
    assert.equal(cursors.includes(0), false);
    assert.equal(await page.getByText("正在恢复会话…", { exact: true }).count(), 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: resolve(output, `retained-${width}.png`), fullPage: true });
    checks.push(`${width}px: retained DOM, immediate send, real incremental fixture events, tool spinner, interrupted polling recovery, cancellation and cursor continuation`);
    await page.close();
  }
  assert.deepEqual(errors, []);
  const report = { revision: release.revision, preview: release.preview, checks, errors, evidence: "Windows Edge with controlled API event fixtures; no real model" };
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await browser.close(); await new Promise(done => server.close(done)); }
