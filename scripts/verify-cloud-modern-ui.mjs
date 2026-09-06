/* global document, innerWidth, innerHeight, getComputedStyle -- Browser evaluate callbacks. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

// Local browser acceptance only. All business responses are explicit fixtures.
if (process.platform !== "win32") throw new Error("Run acceptance on Windows.");
const evidence = resolve("evidence/ui-concepts/cloud-modern-20260906-side");
await mkdir(evidence, { recursive: true });
const release = JSON.parse(execFileSync(process.execPath, ["scripts/build-workbench-release.mjs", "--preview"], { encoding: "utf8", windowsHide: true }));
const output = release.output;
const logoFile = Object.keys(release.files).find(file => /^assets\/harness-logo-.+\.png$/u.test(file));
assert.ok(logoFile, "Brand image missing from release manifest");
assert.deepEqual(await readFile(resolve(output, logoFile)), await readFile("packages/ui/public/assets/harness-logo.png"), "Published image differs from the selected Aurora Fold resource");
for (const [file, hash] of Object.entries(release.files)) assert.equal(createHash("sha256").update(await readFile(resolve(output, file))).digest("hex"), hash);
const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  const file = path === "/harness/" ? "index.html" : path.startsWith("/harness/") ? path.slice("/harness/".length) : "";
  if (Object.hasOwn(release.files, file)) {
    response.setHeader("Content-Type", file.endsWith(".html") ? "text/html; charset=utf-8" : file.endsWith(".js") ? "application/javascript" : file.endsWith(".png") ? "image/png" : "text/css");
    response.end(await readFile(resolve(output, file)));
  } else { response.writeHead(404); response.end(); }
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const errors = [];
const failedRequests = [];
const expectedErrors = [];
const checks = [];
const captures = [];

async function capture(page, name, requireComposer = true) {
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}" });
  const layout = await page.evaluate(() => ({
    width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
    regions: Object.fromEntries([".sidebar", ".main", ".topbar", ".empty-state", ".composer", ".plugin-picker"].map(selector => {
      const node = document.querySelector(selector);
      const rect = node?.getBoundingClientRect();
      return [selector, rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null];
    })),
  }));
  assert.equal(layout.scrollWidth, layout.width, `${name}: horizontal overflow`);
  assert.equal(layout.scrollHeight, layout.height, `${name}: outer scroll`);
  if (requireComposer) {
    const composer = layout.regions[".composer"];
    assert.ok(composer.y >= 0 && composer.y + composer.height <= layout.height, `${name}: composer clipped`);
  }
  const picker = layout.regions[".plugin-picker"];
  if (picker) assert.ok(picker.x >= 0 && picker.y >= 0 && picker.x + picker.width <= layout.width, `${name}: picker clipped`);
  await page.screenshot({ path: `${evidence}/${name}.png`, animations: "disabled", caret: "hide" });
  captures.push({ name, layout });
}

try {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1672, height: 941 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
  const page = await context.newPage();
  let expectFailure = false;
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") (expectFailure ? expectedErrors : errors).push(message.text()); });
  page.on("requestfailed", request => { if (request.failure()?.errorText !== "net::ERR_ABORTED") failedRequests.push(request.url()); });
  let sessions = [];
  let runs = [];
  let events = [];
  let submitted = 0;
  let cancelled = 0;
  let bootstrap = 0;
  await page.route("**/api/company-assistant/agent/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/company-assistant/agent", "");
    const body = request.method() === "POST" ? request.postDataJSON() : undefined;
    let result;
    if (path === "/bootstrap") { bootstrap++; result = { csrfToken: "local-ui-fixture", expiresAt: Date.now() + 30 * 60_000 }; }
    else if (path === "/sessions" && !body) result = { sessions };
    else if (path === "/sessions" && body) {
      const session = { id: "session_design", title: body.title, profileId: "company-public", createdAt: "2026-09-06T00:00:00Z" };
      sessions = [session]; result = { session };
    } else if (path.endsWith("/runs") && body) {
      submitted++;
      const run = { id: "run_design", sessionId: "session_design", requestId: body.requestId, userMessage: body.message, status: "running", cancelRequested: false };
      runs = [run];
      events = [{ eventSeq: 1, turnId: run.id, type: "tool.started", payload: { toolCallId: "tool_design" } }];
      result = { run };
    } else if (path.endsWith("/runs")) result = { runs };
    else if (path.endsWith("/events")) {
      const after = Number(new URL(request.url()).searchParams.get("after") ?? 0);
      result = { events: events.filter(event => event.eventSeq > after), hasMore: false, nextEventSeq: events.length };
    } else if (path.endsWith("/cancel")) {
      cancelled++; runs[0] = { ...runs[0], status: "cancelled", cancelRequested: true, finalText: "任务已停止，已完成的记录已保留。" }; result = {};
    } else throw new Error(`Unexpected fixture route: ${path}`);
    await route.fulfill({ json: result });
  });
  await page.goto(`${origin}/harness/`);
  await page.getByRole("heading", { name: "今天，想完成什么？" }).waitFor();
  const expectedLogoUrl = `${origin}/harness/${logoFile}`;
  await page.waitForFunction(() => [...document.querySelectorAll("img.harness-logo")].every(image => image.complete && image.naturalWidth > 0));
  for (const selector of [".brand-mark img", ".empty-mark img"]) {
    assert.equal(await page.locator(selector).getAttribute("src"), `/harness/${logoFile}`);
    assert.equal(await page.locator(selector).evaluate(image => getComputedStyle(image).objectFit), "contain");
  }
  assert.equal(await page.locator('link[rel="icon"]').getAttribute("href"), `/harness/${logoFile}`);
  assert.equal(await page.locator('link[rel="apple-touch-icon"]').getAttribute("href"), `/harness/${logoFile}`);
  const faviconResponse = await page.request.get(expectedLogoUrl);
  assert.equal(faviconResponse.status(), 200);
  assert.deepEqual(await faviconResponse.body(), await readFile("packages/ui/public/assets/harness-logo.png"));
  checks.push("Aurora Fold bytes, image loading/aspect ratio, favicon and release manifest");
  await capture(page, "desktop-empty");
  await page.getByRole("button", { name: "选择插件", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "选择会话插件" });
  await dialog.waitFor();
  assert.equal(await dialog.getByText("待接入", { exact: true }).count(), 3);
  assert.equal(await dialog.getByRole("button", { name: /短剧制作/ }).count(), 0);
  await capture(page, "desktop-picker");
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("button", { name: "选择插件", exact: true }).evaluate(node => node === document.activeElement), true);
  checks.push("Picker availability, Escape and focus restoration");
  await page.getByRole("button", { name: "插件", exact: true }).click();
  await page.getByRole("heading", { name: "短剧制作" }).waitFor();
  await capture(page, "desktop-plugins", false);
  await page.getByRole("searchbox", { name: "搜索插件" }).fill("不存在的插件");
  await page.getByText("没有找到匹配的插件").waitFor();
  await page.getByRole("searchbox", { name: "搜索插件" }).fill("官网");
  await page.getByRole("button", { name: "返回会话使用" }).click();
  checks.push("Plugin navigation, filtering and return to composer");
  await page.getByRole("button", { name: "了解道引的产品" }).click();
  assert.equal(await page.locator("#message").inputValue(), "道引科技有哪些产品？");
  assert.equal(await page.locator("#message").evaluate(node => node === document.activeElement), true);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByRole("button", { name: "停止生成" }).waitFor();
  assert.equal(await page.locator(".mini-mark img").getAttribute("src"), `/harness/${logoFile}`);
  await page.getByText("正在检索公开资料", { exact: true }).waitFor();
  await capture(page, "desktop-running");
  await page.getByRole("button", { name: "停止生成" }).click();
  await page.getByText("任务已停止，已完成的记录已保留。", { exact: true }).waitFor();
  assert.equal(submitted, 1); assert.equal(cancelled, 1);
  checks.push("Suggestion fill, send, tool progress and cancellation");
  runs[0] = { ...runs[0], status: "completed", cancelRequested: false };
  events.push({ eventSeq: 2, turnId: "run_design", type: "tool.completed", payload: { toolCallId: "tool_design", evidence: { result: { sources: [{ id: "source_design", title: "产品资料示例", location: "官网", content: "这是本地界面验收资料。" }] } } } }, { eventSeq: 3, turnId: "run_design", type: "assistant.delta", payload: { delta: "这是一段**本地验收回答**。\n\n- 公开资料检索\n- 产品与方案介绍" } });
  await page.getByRole("button", { name: "重新连接", exact: true }).click();
  await page.getByText("本地验收回答", { exact: true }).waitFor();
  await page.getByText("参考资料", { exact: false }).click();
  await page.locator(".source summary").click();
  await page.getByText("这是本地界面验收资料。", { exact: true }).waitFor();
  await capture(page, "desktop-answer");
  await page.reload();
  await page.getByText("本地验收回答", { exact: true }).waitFor();
  assert.ok(bootstrap >= 3);
  assert.equal(submitted, 1);
  await page.getByRole("searchbox", { name: "搜索会话" }).fill("没有此会话");
  assert.equal(await page.getByRole("navigation", { name: "最近会话" }).getByRole("button").count(), 0);
  await page.getByRole("searchbox", { name: "搜索会话" }).fill("");
  await page.getByRole("button", { name: "新建会话" }).click();
  await page.getByRole("heading", { name: "今天，想完成什么？" }).waitFor();
  checks.push("Source disclosure, reconnect/reload replay, session search and new session");
  for (const [width, height, name] of [[1280, 720, "desktop-1280"], [390, 844, "mobile"], [320, 640, "mobile-small"]]) {
    await page.setViewportSize({ width, height });
    await capture(page, name);
    await page.getByRole("button", { name: "选择插件", exact: true }).click();
    await capture(page, `${name}-picker`);
    await page.keyboard.press("Escape");
    if (width < 640) {
      await page.getByRole("button", { name: "展开会话导航" }).click();
      await page.getByRole("button", { name: "插件", exact: true }).click();
      await page.getByRole("heading", { name: "短剧制作" }).waitFor();
      assert.equal(await page.locator(".sidebar").isVisible(), false);
      await capture(page, `${name}-plugins`, false);
      await page.getByRole("button", { name: "返回会话使用" }).click();
    }
  }
  checks.push("1280 desktop and 390/320 mobile geometry, picker and navigation");
  expectFailure = true;
  await page.route("**/api/company-assistant/agent/bootstrap", route => route.fulfill({ status: 401, json: { error: "fixture_expired" } }));
  await page.getByRole("button", { name: "重新连接", exact: true }).click();
  await page.getByRole("button", { name: "重新进入工作台" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "发送", exact: true }).isDisabled(), true);
  await capture(page, "mobile-expired");
  checks.push("Expired authorization recovery and disabled submission");
  assert.deepEqual(errors, []); assert.deepEqual(failedRequests, []);
} finally {
  await writeFile(`${evidence}/browser-report.json`, JSON.stringify({ evidence: "Windows local browser; production bundle; mocked business API; no live model", checks, errors, failedRequests, expectedErrors, captures }, null, 2));
  await browser?.close();
  await new Promise(done => server.close(done));
}
console.log(JSON.stringify({ checks, errors, failedRequests, captures: captures.length }));
