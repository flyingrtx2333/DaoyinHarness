/* global document, window */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { build } from "../packages/cli/node_modules/esbuild/lib/main.js";

if (process.platform !== "win32") throw new Error("Windows browser acceptance required.");
const evidence = resolve(process.argv.find(value => value.startsWith("--output="))?.slice(9) ?? "evidence/ui-login-20260913");
await mkdir(evidence, { recursive: true });
const preview = resolve(tmpdir(), "daoyin-harness-login-preview-20260913");
await mkdir(preview, { recursive: true });
await build({
  absWorkingDir: process.cwd(), bundle: true, format: "esm", platform: "browser", outfile: resolve(preview, "login.js"),
  jsx: "automatic",
  loader: { ".png": "file" }, assetNames: "assets/[name]-[hash]",
  stdin: { resolveDir: process.cwd(), sourcefile: "login-preview.tsx", loader: "tsx", contents: `
    import { createRoot } from "react-dom/client";
    import "./packages/ui/src/design-tokens.css";
    import "./packages/ui/src/cloud/cloud.css";
    import "./packages/ui/src/cloud/login-gateway.css";
    import { LoginGateway } from "./packages/ui/src/cloud/LoginGateway.tsx";
    createRoot(document.getElementById("root")).render(<LoginGateway />);
  ` },
});
await writeFile(resolve(preview, "index.html"), "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>道引 Harness</title><link rel=\"stylesheet\" href=\"/login.css\"></head><body><div id=\"root\"></div><script type=\"module\" src=\"/login.js\"></script></body></html>");
let connected = false;
const requests = [];
const mime = { ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".css": "text/css", ".png": "image/png" };
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  const path = url.pathname;
  if (path.startsWith("/api/")) {
    let body = ""; for await (const chunk of request) body += chunk;
    requests.push({ path, method: request.method, body, authorization: request.headers.authorization ?? "" });
    response.setHeader("content-type", "application/json");
    if (path === "/api/auth/sms/send") { response.end(JSON.stringify({ retry_after_seconds: 60, expires_in_seconds: 300 })); return; }
    if (path === "/api/auth/sms-login") { response.end(JSON.stringify({ access_token: "temporary-login-token", token_type: "bearer" })); return; }
    if (path === "/api/auth/account-session") {
      assert.equal(request.headers.authorization, "Bearer temporary-login-token"); connected = true;
      response.end(JSON.stringify({ connected: true })); return;
    }
    response.writeHead(404); response.end(JSON.stringify({ detail: "fixture route missing" })); return;
  }
  const name = path === "/" ? "index.html" : path.slice(1);
  let content;
  try { content = await readFile(resolve(preview, name)); } catch { response.writeHead(404); response.end(); return; }
  response.setHeader("content-type", mime[extname(name)] ?? "application/octet-stream");
  response.setHeader("cache-control", "no-store");
  response.end(content);
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: "msedge", headless: true });
const errors = [];
const failedRequests = [];
const checks = [];
try {
  const page = await browser.newPage({ viewport: { width: 1536, height: 1024 }, deviceScaleFactor: 1 });
  page.on("pageerror", error => errors.push(error.message));
  page.on("requestfailed", request => failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "failed"}`));
  await page.goto(origin + "/");
  await page.getByRole("heading", { name: "登录 Harness" }).waitFor();
  assert.equal(await page.locator("input[type=password]").count(), 0);
  const desktopGeometry = await page.evaluate(() => ({ scrollHeight: document.documentElement.scrollHeight, innerHeight: window.innerHeight, scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, bodyHeight: document.body.getBoundingClientRect().height, rootHeight: document.getElementById("root")?.getBoundingClientRect().height }));
  assert.equal(desktopGeometry.scrollHeight, desktopGeometry.innerHeight, JSON.stringify(desktopGeometry));
  assert.equal(desktopGeometry.scrollWidth, desktopGeometry.innerWidth, JSON.stringify(desktopGeometry));
  await page.screenshot({ path: resolve(evidence, "desktop-1536x1024.png"), animations: "disabled", caret: "hide" });
  checks.push("desktop fixed frame, real SMS fields, no password and no overflow");
  await page.getByLabel("手机号").fill("13800138000");
  await page.getByRole("button", { name: "获取验证码" }).click();
  await page.getByText("验证码已发送，5 分钟内有效").waitFor();
  await page.getByLabel("验证码").fill("123456");
  await page.getByRole("checkbox").check();
  const sessionExchange = page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/account-session");
  await page.getByRole("button", { name: "登录并进入 Harness" }).click();
  await sessionExchange;
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("heading", { name: "登录 Harness" }).waitFor();
  assert.ok(requests.some(item => item.path === "/api/auth/sms/send" && item.body.includes('"scene":"login"')));
  assert.ok(requests.some(item => item.path === "/api/auth/sms-login" && item.body.includes('"sms_code":"123456"')));
  assert.ok(requests.some(item => item.path === "/api/auth/account-session" && item.authorization === "Bearer temporary-login-token"));
  checks.push("SMS send, verification login, in-memory token exchange and workbench return");
  assert.equal(connected, true);
  connected = false;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin + "/");
  await page.getByRole("heading", { name: "登录 Harness" }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: resolve(evidence, "mobile-390x844.png"), fullPage: true, animations: "disabled", caret: "hide" });
  checks.push("390px mobile reflow without horizontal overflow");
  assert.deepEqual(errors, []); assert.deepEqual(failedRequests, []);
} finally {
  await writeFile(resolve(evidence, "browser-report.json"), JSON.stringify({ evidence: "Windows Edge; production UI bundle; mocked auth and workbench APIs; no real SMS sent", origin, checks, errors, failedRequests, requests }, null, 2));
  await browser.close();
  await new Promise(done => server.close(done));
}
console.log(JSON.stringify({ evidence, checks, errors, failedRequests }));
