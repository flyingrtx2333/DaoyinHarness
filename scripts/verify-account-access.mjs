/* global document, window */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

if (process.platform !== "win32") throw new Error("Windows acceptance required.");
const release = JSON.parse(execFileSync(process.execPath, ["scripts/build-workbench-release.mjs", ...(process.argv.includes("--committed") ? [] : ["--preview"])], { encoding: "utf8", windowsHide: true }));
const output = resolve(process.argv.find(argument => argument.startsWith("--output="))?.slice(9) ?? "output/playwright/account-access");
const platformOutput = resolve("../DaoyinTechnology/frontend/dist");
const csp = (await readFile("deployment/harness-workbench.conf", "utf8")).match(/Content-Security-Policy "([^"]+)"/u)[1];
await mkdir(output, { recursive: true });
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const file = pathname === "/harness/" ? "index.html" : pathname.startsWith("/harness/") ? pathname.slice(9) : "";
  if (pathname === "/login" || /^\/assets\/[A-Za-z0-9_.-]+$/u.test(pathname)) {
    const platformFile = pathname === "/login" ? "index.html" : pathname.slice(1);
    try {
      res.setHeader("content-type", platformFile.endsWith(".html") ? "text/html" : platformFile.endsWith(".js") ? "application/javascript" : platformFile.endsWith(".css") ? "text/css" : "application/octet-stream");
      res.end(await readFile(resolve(platformOutput, platformFile))); return;
    } catch { res.writeHead(404); res.end(); return; }
  }
  if (!Object.hasOwn(release.files, file)) { res.writeHead(404); res.end(); return; }
  if (file === "index.html") res.setHeader("Content-Security-Policy", csp);
  res.setHeader("content-type", file.endsWith(".html") ? "text/html" : file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : "image/png");
  res.end(await readFile(resolve(release.output, file)));
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: "msedge", headless: true });
const checks = [];
const errors = [];
try {
  const page = await browser.newPage();
  page.on("pageerror", error => errors.push(error.message));
  let account = "a";
  let brokenAvatar = false;
  let unavailable = false;
  let bootstrapDelay = 0;
  let logoutFails = false;
  let sessionsUnavailable = false;
  await page.route("https://images.example/avatar.png", route => route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5XcAAAAASUVORK5CYII=", "base64") }));
  await page.route("https://images.example/missing.png", route => route.fulfill({ status: 404, body: "" }));
  const requests = [];
  await page.route("**/api/**", async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    requests.push({ path, body: req.postData() });
    if (path === "/api/auth/account-session") {
      assert.equal(req.headers().authorization, "Bearer existing-platform-login-fixture");
      return route.fulfill({ json: { connected: true } });
    }
    const company = path.includes("company-assistant");
    if (path.endsWith("/bootstrap")) {
      if (bootstrapDelay) await new Promise(resolve => setTimeout(resolve, bootstrapDelay));
      if (unavailable) return route.fulfill({ status: 503, json: {} });
      if (!company && !account) return route.fulfill({ status: 401, json: { loginUrl: "/api/agent-apps/saishi/workbench/login" } });
      return route.fulfill({ json: { csrfToken: "fixture-csrf", expiresAt: Date.now() + (company ? 3600000 : 30 * 86400000),
        ...(company ? {} : { profileId: "saishi-readonly", authentication: "account", accountScope: account,
          account: { username: account === "a" ? "张小明" : "李小红", avatarUrl: account === "a" ? `https://images.example/${brokenAvatar ? "missing" : "avatar"}.png` : null } }) } });
    }
    if (!company && req.headers()["x-agent-account"] !== account) return route.fulfill({ status: 401, json: {} });
    if (path.endsWith("/logout")) {
      if (logoutFails) return route.fulfill({ status: 503, json: {} });
      account = ""; return route.fulfill({ json: { disconnected: true } });
    }
    const session = { id: `session_${account}`, title: `账号 ${account} 的会话`, profileId: "saishi-readonly", profileVersion: "1", createdAt: "2026-09-06T00:00:00Z" };
    if (path.endsWith("/sessions")) return sessionsUnavailable ? route.fulfill({ status: 503, json: {} }) : route.fulfill({ json: { sessions: company ? [] : [session] } });
    if (path.endsWith("/runs")) return route.fulfill({ json: { runs: [{ id: `run_${account}`, sessionId: session.id,
      requestId: `request_${account}`, userMessage: `账号 ${account} 的问题`, finalText: `账号 ${account} 的回答`,
      status: "completed", lastEventSeq: 0, createdAt: "2026-09-06T00:00:00Z" }] } });
    if (path.endsWith("/events")) return route.fulfill({ json: { events: [], hasMore: false, nextEventSeq: 0 } });
    throw new Error(`Unexpected fixture route ${path}`);
  });
  for (const width of [1280, 1920, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(base + "/harness/?app=saishi");
    await page.getByText("账号 a 的回答", { exact: true }).waitFor();
    if (width === 1280) {
      await page.waitForTimeout(500);
      assert.equal(requests.filter(request => request.path.endsWith("/bootstrap")).length, 1, "30-day account must stay connected without an expiry reconnect loop");
      checks.push("30-day account remains ready without repeated bootstrap requests");
    }
    await page.waitForFunction(() => document.querySelector(".account-avatar img")?.naturalWidth > 0);
    assert.equal(await page.locator(".account-username").textContent(), "张小明");
    assert.equal(await page.getByText("账号空间", { exact: true }).count(), 0);
    assert.equal(await page.locator("input[type=password]").count(), 0);
    assert.equal(await page.getByRole("button", { name: "登录道引账号" }).count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: resolve(output, `account-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: "选择插件", exact: true }).click();
    await page.getByRole("dialog", { name: "选择会话插件" }).waitFor();
    assert.equal(await page.getByText("连接授权", { exact: true }).count(), 0);
    await page.screenshot({ path: resolve(output, `picker-${width}.png`), fullPage: true });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "查看赛事只读详情" }).click();
    await page.getByRole("region", { name: "业务插件" }).waitFor();
    assert.equal(await page.getByText("待接入", { exact: true }).count(), 3);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: resolve(output, `catalog-${width}.png`), fullPage: true });
    checks.push(`signed-in, picker, catalog and layout ${width}px`);
  }
  await page.goto(base + "/harness/?app=saishi");
  await page.getByText("账号 a 的回答", { exact: true }).waitFor();
  await page.getByRole("textbox", { name: "发送给 Harness 的问题" }).fill("同账号的未发送草稿");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByText("账号 a 的回答", { exact: true }).waitFor();
  assert.equal(await page.getByRole("textbox", { name: "发送给 Harness 的问题" }).inputValue(), "同账号的未发送草稿");
  checks.push("same-account reconnection preserves the draft");
  await page.waitForTimeout(200);
  const beforeCheck = requests.length;
  bootstrapDelay = 700;
  await page.evaluate(() => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForTimeout(200);
  assert.equal(await page.getByText("正在连接工作台…", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("textbox", { name: "发送给 Harness 的问题" }).isEnabled(), true);
  await page.getByRole("textbox", { name: "发送给 Harness 的问题" }).pressSequentially("继续输入");
  await page.waitForTimeout(800);
  bootstrapDelay = 0;
  assert.equal(await page.getByRole("textbox", { name: "发送给 Harness 的问题" }).inputValue(), "同账号的未发送草稿继续输入");
  assert.equal(requests.slice(beforeCheck).filter(request => request.path.endsWith("/bootstrap")).length, 1);
  assert.equal(requests.slice(beforeCheck).filter(request => request.path.endsWith("/sessions") || request.path.endsWith("/runs")).length, 0);
  checks.push("coalesced background identity check preserves composer, draft and conversation without a spinner");
  brokenAvatar = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForFunction(() => document.querySelector(".account-avatar")?.textContent === "张");
  brokenAvatar = false;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForFunction(() => document.querySelector(".account-avatar img")?.naturalWidth > 0);
  checks.push("profile avatar loads under production CSP, falls back on failure and refreshes");
  unavailable = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByRole("button", { name: "重新连接工作台", exact: true }).waitFor();
  assert.equal(await page.getByText("正在连接工作台…", { exact: true }).count(), 0);
  unavailable = false;
  await page.getByRole("button", { name: "重新连接工作台", exact: true }).click();
  await page.getByText("账号 a 的回答", { exact: true }).waitFor();
  checks.push("temporary connection failure exits the spinner and can be retried");
  account = "b";
  sessionsUnavailable = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByRole("button", { name: "重新连接工作台", exact: true }).waitFor();
  assert.equal(await page.getByText("账号 a 的回答", { exact: true }).count(), 0);
  assert.equal(await page.getByText("正在连接工作台…", { exact: true }).count(), 0);
  sessionsUnavailable = false;
  await page.getByRole("button", { name: "重新连接工作台", exact: true }).click();
  await page.getByText("账号 b 的回答", { exact: true }).waitFor();
  assert.equal(await page.getByText("账号 a 的回答", { exact: true }).count(), 0);
  assert.equal(await page.locator(".account-username").textContent(), "李小红");
  assert.equal(await page.locator(".account-avatar").textContent(), "李");
  assert.equal(await page.locator(".account-avatar img").count(), 0);
  assert.equal(await page.getByRole("textbox", { name: "发送给 Harness 的问题" }).inputValue(), "");
  checks.push("account switch removes old transcript");
  account = "";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByRole("button", { name: "登录道引账号" }).waitFor();
  assert.equal(await page.getByText("账号 b 的回答", { exact: true }).count(), 0);
  assert.equal(await page.locator(".account-identity").count(), 0);
  assert.equal(await page.locator("input[type=password]").count(), 0);
  await page.screenshot({ path: resolve(output, "signed-out.png"), fullPage: true });
  checks.push("signed-out state has platform login without grant entry");
  await page.goto(base + "/harness/");
  await page.getByRole("heading", { name: "今天，想完成什么？" }).waitFor();
  assert.equal(await page.getByRole("textbox", { name: "发送给 Harness 的问题" }).isEnabled(), true);
  const entry = page.locator(".visitor-account-prompt");
  const login = entry.getByRole("link", { name: "登录道引账号", exact: true });
  const register = entry.getByRole("link", { name: "注册账号", exact: true });
  await login.waitFor(); await register.waitFor();
  assert.equal(await login.getAttribute("href"), "/login?redirect=%2Fharness%2F%3Fapp%3Dsaishi");
  assert.equal(await register.getAttribute("href"), "/login?mode=register&redirect=%2Fharness%2F%3Fapp%3Dsaishi");
  await page.screenshot({ path: resolve(output, "visitor-account-entry.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(base + "/harness/");
  const sidebarLogin = page.locator(".sidebar-footer").getByRole("link", { name: "登录道引账号", exact: true });
  await sidebarLogin.waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: resolve(output, "visitor-account-entry-desktop.png"), fullPage: true });
  checks.push("company visitor entry includes platform login and registration links on narrow and desktop screens");
  account = "a";
  await page.evaluate(() => window.localStorage.setItem("athletereel_token", "existing-platform-login-fixture"));
  await page.goto(base + "/login?redirect=%2Fharness%2F%3Fapp%3Dsaishi");
  await page.waitForURL(base + "/harness/?app=saishi");
  await page.getByText("账号 a 的回答", { exact: true }).waitFor();
  assert.equal(requests.some(req => req.path === "/api/auth/account-session"), true);
  checks.push("existing platform login enters Harness without password or grant prompts");
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    if (width < 600) await page.getByRole("button", { name: "展开会话导航" }).click();
    const trigger = page.getByRole("button", { name: "当前账号：张小明", exact: true });
    await trigger.click();
    await page.getByRole("menu", { name: "账号菜单" }).waitFor();
    const profile = page.getByRole("menuitem", { name: "个人中心" });
    assert.equal(await profile.getAttribute("href"), "/my/profile");
    assert.equal(await profile.getAttribute("target"), "_blank");
    await page.screenshot({ path: resolve(output, `account-menu-${width}.png`), fullPage: true });
    await page.keyboard.press("End");
    assert.equal(await page.getByRole("menuitem", { name: "退出登录", exact: true }).evaluate(node => node === document.activeElement), true);
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.getByRole("menuitem", { name: "设置", exact: true }).evaluate(node => node === document.activeElement), true);
    await page.keyboard.press("Enter");
    await page.getByRole("dialog", { name: "设置", exact: true }).waitFor();
    await page.keyboard.press("Shift+Tab");
    assert.equal(await page.getByRole("button", { name: "完成", exact: true }).evaluate(node => node === document.activeElement), true);
    await page.getByLabel("发送消息", { exact: true }).selectOption("modifier-enter");
    await page.getByLabel("回复时自动滚动", { exact: true }).uncheck();
    await page.screenshot({ path: resolve(output, `settings-${width}.png`), fullPage: true });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.activeElement?.classList.contains("account-identity"));
    assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
    await trigger.click(); await page.keyboard.press("Escape");
    assert.equal(await trigger.getAttribute("aria-expanded"), "false");
    if (width === 1280) {
      await trigger.click(); await page.locator("#message").click();
      assert.equal(await trigger.getAttribute("aria-expanded"), "false");
    }
    if (width < 600) await page.getByRole("button", { name: "关闭会话导航", exact: true }).click();
  }
  const composer = page.getByRole("textbox", { name: "发送给 Harness 的问题" });
  await composer.fill("设置换行"); await composer.press("Enter");
  assert.equal(await composer.inputValue(), "设置换行\n");
  await page.reload();
  await page.getByText("账号 a 的回答", { exact: true }).waitFor();
  await page.getByRole("button", { name: "展开会话导航" }).click();
  await page.getByRole("button", { name: "当前账号：张小明", exact: true }).click();
  await page.getByRole("menuitem", { name: "设置", exact: true }).click();
  assert.equal(await page.getByLabel("发送消息", { exact: true }).inputValue(), "modifier-enter");
  assert.equal(await page.getByLabel("回复时自动滚动", { exact: true }).isChecked(), false);
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await page.getByRole("button", { name: "当前账号：张小明", exact: true }).click();
  logoutFails = true;
  await page.getByRole("menuitem", { name: "退出登录", exact: true }).click();
  await page.getByText("退出登录未完成，请重试。", { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("app"), "saishi");
  logoutFails = false;
  await page.getByRole("menuitem", { name: "退出登录", exact: true }).click();
  await page.waitForURL(base + "/harness/");
  assert.equal(await page.locator(".account-identity").count(), 0);
  assert.equal(await page.evaluate(() => window.localStorage.getItem("athletereel_token")), null);
  checks.push("account menu, keyboard focus, persistent settings and confirmed logout pass at desktop and narrow widths");
  assert.equal(requests.some(req => req.path.endsWith("/connect")), false);
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, "report.json"), JSON.stringify({ evidence: "Windows Edge; local release preview; mocked platform APIs; no real model or production deployment", checks, errors }, null, 2));
  console.log(JSON.stringify({ checks, output }, null, 2));
} finally { await browser.close(); await new Promise(done => server.close(done)); }
