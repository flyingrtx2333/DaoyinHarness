/* Windows acceptance: real compiled UI, simulated admin/API/results. No production/model calls. */
/* global window -- evaluated only inside Playwright's browser context */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
if (process.platform !== "win32") throw new Error("Run UI acceptance from Windows PowerShell.");
const release = JSON.parse(execFileSync(process.execPath, ["scripts/build-workbench-release.mjs", "--preview"], { encoding: "utf8", windowsHide: true }));
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const file = url.pathname === "/harness/" ? "index.html" : url.pathname.startsWith("/harness/") ? url.pathname.slice(9) : "";
  if (!Object.hasOwn(release.files, file)) { res.writeHead(404); res.end(); return; }
  try {
    res.setHeader("Content-Type", file.endsWith(".html") ? "text/html" : file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : "image/png");
    res.end(await readFile(resolve(release.output, file)));
  } catch { res.writeHead(500); res.end(); }
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  for (const width of [1280, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } }); const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    let isAdmin = false; let run = null; let starts = 0;
    const test = { id: "case_1", input: "查询我的赛事素材处理状态", template: "saishi-materials", expectedFacts: ["40条素材"], approved: false };
    const trial = { caseId: test.id, repetition: 1, verdict: "passed", runStatus: "completed", answer: "测试回放回答：40条素材。",
      checks: [{ name: "素材覆盖", passed: true, detail: "40/40" }], tools: [{ name: "saishi_list_materials", status: "completed", summary: "读取完成" }],
      modelCalls: 4, judgeCalls: 0, durationMs: 1000, firstTextMs: 500, inputTokens: null, outputTokens: null, recall: null, retrievedMemoryIds: [], errorCode: null };
    await page.route("**/*", async route => {
      const request = route.request(); const url = new URL(request.url());
      if (url.origin !== base) return route.abort();
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (url.pathname.startsWith("/api/harness-evaluation")) {
        if (!isAdmin) return route.fulfill({ status: 403, json: { detail: { code: "SUPERADMIN_REQUIRED" } } });
        const path = url.pathname.slice("/api/harness-evaluation".length);
        if (path === "/bootstrap") return route.fulfill({ json: { allowed: true, csrfToken: "b".repeat(64), accountScope: "a".repeat(64) } });
        assert.equal(request.headers()["x-eval-account"], "a".repeat(64));
        if (request.method() === "POST") assert.equal(request.headers()["x-eval-csrf"], "b".repeat(64));
        if (path === "/catalog") return route.fulfill({ json: { version: "fixture", revision: null, liveAvailable: false, model: null, judgeModel: null,
          templates: [{ id: "saishi-materials", name: "赛事素材状态", fixture: "40条合成数据，不连接生产。", facts: ["40条素材"] }, { id: "explore", name: "自由探索", fixture: "未配置标准", facts: [] }] } });
        if (path === "/prepare") return route.fulfill({ json: { cases: [test] } });
        if (path === "/runs" && request.method() === "POST") {
          starts++; const spec = request.postDataJSON(); assert.equal(spec.mode, "replay"); assert.equal(spec.cases[0].approved, true);
          run = { id: "ev_" + "c".repeat(32), actorId: "1", spec, status: "completed", createdAt: "2026-09-06T00:00:00Z", finishedAt: "2026-09-06T00:00:01Z",
            configurationHash: "fixture", version: "fixture", model: null, revision: null, planned: 1, completed: 1, trials: [trial], active: null,
            dispatchedCalls: { agent: 4, judge: 0 }, metrics: { verifiedSuccessRate: null, protocolPassRate: 1, repeatAllPassRate: 1, meanRecall: null, recallSamples: 0, failed: 0, review: 0, notRun: 0 } };
          return route.fulfill({ status: 202, json: { run, reused: false } });
        }
        if (path === "/runs") return route.fulfill({ json: { runs: run ? [{ ...run, title: run.spec.title, mode: "replay" }] : [] } });
        if (path.includes("/trials/")) return route.fulfill({ json: { trial, test, mode: "replay" } });
        if (run && path === `/runs/${run.id}`) return route.fulfill({ json: run });
        return route.fulfill({ status: 404, json: {} });
      }
      if (url.pathname.endsWith("/bootstrap")) return route.fulfill({ json: { csrfToken: "normal-fixture", expiresAt: Date.now() + 60_000 } });
      if (url.pathname.endsWith("/sessions")) return route.fulfill({ json: { sessions: [] } });
      return route.fulfill({ status: 404, json: {} });
    });
    await page.goto(base + "/harness/#plugins");
    await page.waitForTimeout(300);
    assert.equal(await page.getByRole("button", { name: "测试评估", exact: true }).count(), 0);
    await page.goto(base + "/harness/#plugins-evaluation"); await page.reload();
    await page.getByText("测试评估仅向已验证的超级管理员开放。", { exact: true }).waitFor();
    isAdmin = true; await page.reload();
    await page.getByRole("heading", { name: "测试评估", exact: true }).waitFor();
    await page.getByLabel("真实用户输入", { exact: true }).fill(test.input);
    await page.getByRole("button", { name: "整理用例", exact: true }).click();
    await page.getByLabel("确认该场景和成功条件适用于这道题", { exact: true }).check();
    await page.getByLabel("每题重复次数", { exact: true }).selectOption("1");
    await page.getByRole("button", { name: "开始测试", exact: true }).click();
    await page.getByRole("button", { name: "case_1 第1次 通过", exact: true }).waitFor();
    await page.getByRole("button", { name: "case_1 第1次 通过", exact: true }).click();
    await page.getByText(trial.answer, { exact: true }).waitFor();
    assert.equal(starts, 1); assert.equal(await page.locator("body").evaluate(el => el.scrollWidth <= window.innerWidth), true);
    isAdmin = false; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.getByText("测试评估仅向已验证的超级管理员开放。", { exact: true }).waitFor();
    assert.equal(await page.getByText(trial.answer, { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log("PASS: compiled evaluation UI, mocked authority/API: hidden tab, direct denial, case approval, replay evidence, narrow layouts and revocation. No real production or model test.");
} finally { await browser.close(); await new Promise(done => server.close(done)); }
