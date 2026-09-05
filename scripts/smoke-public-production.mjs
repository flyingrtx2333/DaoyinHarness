import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
if (process.platform !== "win32" || process.env.DAOYIN_PRODUCTION_SMOKE !== "1") throw new Error("Explicit Windows production-smoke opt-in required.");
const origin = "https://www.daoyintech.com";
const base = origin + "/api/company-assistant/agent";
let cookie = "", csrf = "";
async function request(path, body, expected = 200, auth = true) {
  const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", redirect: "error",
    headers: { origin, "content-type": "application/json", ...(auth ? { cookie, "x-agent-csrf": csrf } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
  if (response.status !== expected) throw new Error(`${path}: HTTP ${response.status}; ${await response.text()}`);
  const updated = response.headers.getSetCookie().find((entry) => entry.startsWith("daoyin_company_agent="));
  if (updated && auth) cookie = updated.split(";")[0];
  return response.json();
}
csrf = (await request("/bootstrap", {})).csrfToken;
assert.ok(csrf && cookie);
const { session } = await request("/sessions", { title: "统一 Agent 上线验收" }, 201);
const submission = { requestId: crypto.randomUUID(), message: "请查阅公开项目资料，介绍道引 AI 减压馆有哪些具体互动项目，以及适合哪些合作场景。请给出资料依据，不要猜测。" };
const { run: accepted } = await request(`/sessions/${session.id}/runs`, submission, 202);
const { run: duplicate } = await request(`/sessions/${session.id}/runs`, submission, 202);
assert.equal(accepted.id, duplicate.id);
let run = accepted;
const deadline = Date.now() + 180_000;
while (run.status === "running" || run.status === "queued") {
  assert.ok(Date.now() < deadline, "Run did not finish before the production acceptance deadline.");
  await delay(1500);
  ({ run } = await request(`/runs/${accepted.id}`));
}
const { events } = await request(`/sessions/${session.id}/events?after=0`);
console.log(JSON.stringify({ runId: run.id, status: run.status, eventTypes: events.map((event) => event.type), answer: run.finalText }, null, 2));
await writeFile(".cache/public-production-smoke.json", JSON.stringify({ sessionId: session.id, runId: run.id, status: run.status, events, answer: run.finalText }, null, 2));
assert.equal(run.status, "completed");
assert.ok(events.some((event) => event.type === "tool.completed"), "Real public retrieval must complete.");
await request(`/runs/${run.id}`, undefined, 401, false);
const { run: stopped } = await request(`/sessions/${session.id}/runs`, { requestId: crypto.randomUUID(), message: "请查阅资料详细介绍道引科技的体育项目。" }, 202);
await request(`/runs/${stopped.id}/cancel`, {});
let cancelled;
for (let attempt = 0; attempt < 30; attempt++) {
  ({ run: cancelled } = await request(`/runs/${stopped.id}`));
  if (cancelled.status !== "running" && cancelled.status !== "queued") break;
  await delay(300);
}
assert.equal(cancelled.status, "cancelled");
console.log("Real model, public retrieval, duplicate request reuse, unauthenticated denial, replay and cancellation passed.");
await request("/logout", {});
