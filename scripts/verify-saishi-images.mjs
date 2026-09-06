/* Windows browser acceptance: built workbench, fixture account/API/media. */
/* global document, innerWidth */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

if (process.platform !== "win32") throw new Error("Windows acceptance required.");
const release = JSON.parse(execFileSync(process.execPath, ["scripts/build-workbench-release.mjs", ...(process.argv.includes("--committed") ? [] : ["--preview"])], { encoding: "utf8", windowsHide: true }));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGO0SHnBwMDAxMDAwMDAAAARqgGIjTqpmAAAAABJRU5ErkJggg==", "base64");
let base;
const server = createServer(async (req, res) => {
  const path = new URL(req.url, base).pathname;
  const file = path === "/harness/" ? "index.html" : path.startsWith("/harness/") ? path.slice(9) : "";
  if (!Object.hasOwn(release.files, file)) { res.writeHead(404); res.end(); return; }
  res.setHeader("content-type", file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".html") ? "text/html" : "image/png");
  res.end(await readFile(resolve(release.output, file)));
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: "msedge", headless: true });
await mkdir(".cache/image-acceptance", { recursive: true });
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const scope = "b".repeat(64);
    const session = { id: "ses_images", title: "赛事图片验证", profileId: "saishi-readonly", profileVersion: "1", createdAt: "2026-09-06T00:00:00Z" };
    const run = { id: "run_images", sessionId: session.id, requestId: "fixture", userMessage: "给我看图片", status: "running", finalText: "", lastEventSeq: 1, cancelRequested: false, authorizationId: "fixture", billingAccountId: "fixture", createdAt: session.createdAt };
    const event = { id: "evt_image", eventSeq: 1, sessionId: session.id, turnId: run.id, accountId: "fixture", scopeId: "fixture", occurredAt: session.createdAt, type: "tool.completed",
      payload: { toolCallId: "images", toolName: "saishi_list_images", summary: "图片已找到", evidence: { result: { tool: "saishi_list_images", data: { items: [1,2].map(id => ({ image_id: id, event_id: 2, image_kind: "highlight", title: `测试照片${id}` })) } } } } };
    const imageRequests = [];
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) throw new Error("Unexpected external request");
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (url.pathname.includes("/images/")) {
        assert.ok(url.pathname.startsWith(`/api/agent-apps/saishi/workbench/images/${scope}/2/highlight/`));
        imageRequests.push(url.pathname);
        if (url.pathname.endsWith("/2") && url.searchParams.get("attempt") === "0") return route.fulfill({ status: 404 });
        await new Promise(done => setTimeout(done, 250));
        return route.fulfill({ contentType: "image/png", body: png });
      }
      if (url.pathname.endsWith("/bootstrap")) return route.fulfill({ json: { csrfToken: "a".repeat(64), expiresAt: Date.now()+60000, profileId: session.profileId, authentication: "account", accountScope: scope, account: { username: "验证账号", avatarUrl: null } } });
      if (url.pathname.endsWith("/sessions")) return route.fulfill({ json: { sessions: [session] } });
      if (url.pathname.endsWith("/runs")) return route.fulfill({ json: { runs: [run] } });
      if (url.pathname.endsWith("/events")) return route.fulfill({ json: { events: [event], nextEventSeq: 1, hasMore: false } });
      return route.fulfill({ status: 404, json: {} });
    });
    await page.routeWebSocket("**/events/ws", ws => ws.onMessage(() => {
      ws.send(JSON.stringify({ type: "events", sessionId: session.id, events: [event], nextEventSeq: 1 }));
      ws.send(JSON.stringify({ type: "run", sessionId: session.id, run }));
      ws.send(JSON.stringify({ type: "ready", sessionId: session.id, lastEventSeq: 1 }));
    }));
    await page.goto(`${base}/harness/?app=saishi`);
    const gallery = page.getByRole("region", { name: "赛事图片", exact: true });
    await gallery.waitFor();
    await gallery.getByRole("button", { name: "重新加载图片" }).click();
    await page.waitForFunction(() => [...document.querySelectorAll(".event-image-grid img")].length === 2 && [...document.querySelectorAll(".event-image-grid img")].every(img => img.naturalWidth > 0));
    assert.equal(await gallery.locator("figure").count(), 2, "replayed events do not duplicate images");
    const open = gallery.getByRole("button", { name: "放大查看测试照片1" });
    await open.click();
    await page.getByRole("dialog", { name: "查看赛事图片" }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.ok(await open.evaluate(element => document.activeElement === element), "dialog restores focus");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no horizontal overflow");
    await page.screenshot({ path: `.cache/image-acceptance/${width}.png`, fullPage: true });
    assert.ok(imageRequests.length >= 3);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("PASS: Windows Edge, fixture account/media: images before final answer, replay dedupe, retry, scoped URLs, dialog Escape/focus, desktop/mobile.");
} finally { await browser.close(); await new Promise(done => server.close(done)); }
