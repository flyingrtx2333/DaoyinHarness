/* Windows browser acceptance: real built UI, mocked HTTP/WebSocket, NO external services. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

if (process.platform !== "win32") throw new Error("Run browser acceptance from Windows.");
const release = JSON.parse(execFileSync(process.execPath, ["scripts/build-workbench-release.mjs", "--preview"], { encoding: "utf8", windowsHide: true }));
let base = "";
const configuredCsp = (await readFile("deployment/harness-workbench.conf", "utf8")).match(/Content-Security-Policy "([^"]+)"/u)[1];
const server = createServer(async (req, res) => {
  const path = new URL(req.url, base).pathname;
  const file = path === "/harness/" ? "index.html" : path.startsWith("/harness/") ? path.slice(9) : "";
  if (!Object.hasOwn(release.files, file)) { res.writeHead(404); res.end(); return; }
  try {
    if (file === "index.html") res.setHeader("Content-Security-Policy", configuredCsp.replace("wss://www.daoyintech.com", base.replace("http:", "ws:")));
    res.setHeader("content-type", file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".html") ? "text/html" : "image/png");
    res.end(await readFile(resolve(release.output, file)));
  } catch { res.writeHead(500); res.end(); }
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: "msedge", headless: true });
async function until(check) {
  for (let index = 0; index < 200; index++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error("Browser event fixture timed out");
}
try {
  for (const application of ["company", "saishi"]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const session = { id: "ses_fixture", title: "推送验证", profileId: application === "saishi" ? "saishi-readonly" : "company-public", profileVersion: "1", createdAt: "2026-09-06T00:00:00Z" };
    const run = { id: "run_fixture", sessionId: session.id, requestId: "fixture-request", userMessage: "展示执行进度", status: "running", finalText: "", lastEventSeq: 0,
      cancelRequested: false, authorizationId: "fixture-grant", billingAccountId: "fixture-payer", createdAt: session.createdAt };
    const events = [];
    const sockets = [];
    const cursors = [];
    let reads = 0;
    let submitted = 0;
    await page.route("**/*", route => {
      const req = route.request(); const url = new URL(req.url());
      if (url.origin !== base) return route.abort();
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (url.pathname.endsWith("/bootstrap")) return route.fulfill({ json: { csrfToken: "a".repeat(64), expiresAt: Date.now() + 60000,
        profileId: session.profileId, authentication: "account", accountScope: application === "saishi" ? "b".repeat(64) : "", account: { username: "验证账号", avatarUrl: null } } });
      if (url.pathname.endsWith("/sessions")) return route.fulfill({ json: { sessions: [session] } });
      if (url.pathname.endsWith("/runs")) {
        if (req.method() === "POST") submitted++;
        reads++; return route.fulfill({ json: { runs: [run] } });
      }
      if (url.pathname.endsWith("/events")) { reads++; return route.fulfill({ json: { events: events.filter(event => event.eventSeq > Number(url.searchParams.get("after"))), nextEventSeq: run.lastEventSeq, hasMore: false } }); }
      return route.fulfill({ status: 404, json: {} });
    });
    await page.routeWebSocket("**/events/ws", ws => {
      assert.equal(new URL(ws.url()).search, "");
      ws.onMessage(text => {
        const hello = JSON.parse(text);
        assert.equal(hello.type, "subscribe"); assert.equal(hello.csrfToken, "a".repeat(64));
        cursors.push(hello.after); sockets.push(ws);
        const pending = events.filter(event => event.eventSeq > hello.after);
        if (pending.length) ws.send(JSON.stringify({ type: "events", sessionId: session.id, events: pending, nextEventSeq: pending.at(-1).eventSeq }));
        ws.send(JSON.stringify({ type: "run", sessionId: session.id, run }));
        ws.send(JSON.stringify({ type: "ready", sessionId: session.id, lastEventSeq: run.lastEventSeq }));
      });
    });
    const append = (type, payload) => {
      const event = { id: `evt_${events.length + 1}`, eventSeq: events.length + 1, sessionId: session.id, turnId: run.id,
        accountId: "fixture", scopeId: "fixture", occurredAt: session.createdAt, type, payload };
      events.push(event); run.lastEventSeq = event.eventSeq; return event;
    };
    const push = event => sockets.at(-1).send(JSON.stringify({ type: "events", sessionId: session.id, events: [event], nextEventSeq: event.eventSeq }));
    await page.goto(`${base}/harness/${application === "saishi" ? "?app=saishi" : ""}`);
    await until(() => sockets.length === 1);
    push(append("assistant.delta", { contentBlockId: "text", delta: "第一段实时正文。" }));
    await page.locator(".assistant-message").filter({ hasText: "第一段实时正文。" }).waitFor();
    const before = reads; await page.waitForTimeout(2500); assert.equal(reads, before, "ready websocket must stop HTTP polling");
    await sockets[0].close({ code: 1013, reason: "fixture disconnect" });
    append("assistant.delta", { contentBlockId: "text", delta: "断线期间的第二段。" });
    await until(() => sockets.length >= 2);
    await page.locator(".assistant-message").filter({ hasText: "断线期间的第二段。" }).waitFor();
    assert.ok(cursors[1] >= 1, "reconnect must keep applied cursor");
    push(events[1]); // repeated delivery is harmless
    assert.equal((await page.locator(".assistant-message").innerText()).split("第二段").length - 1, 1);
    run.status = "completed"; run.finalText = "第一段实时正文。断线期间的第二段。";
    push(append("turn.completed", { status: "completed", assistantMessageId: "answer", outcomeSummary: run.finalText }));
    sockets.at(-1).send(JSON.stringify({ type: "run", sessionId: session.id, run }));
    await page.waitForTimeout(150);
    await sockets.at(-1).close({ code: 4401, reason: "fixture revoked" });
    await page.getByRole("button", { name: application === "saishi" ? "登录道引账号" : "重新连接", exact: true }).waitFor().catch(async () => {
      await page.getByText("登录或访客身份已失效，请重新连接。", { exact: false }).waitFor();
    });
    assert.equal(submitted, 0, "reconnect never re-submits model work");
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("PASS: real Windows UI + mock WebSocket: live text, no polling, reconnect/replay, dedupe, revocation, no re-submit (company & Saishi).");
} finally { await browser.close(); await new Promise(done => server.close(done)); }
