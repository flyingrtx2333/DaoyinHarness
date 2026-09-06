import { afterEach, describe, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EvaluationStore } from "./store.js";
import { createEvaluationService } from "./service.js";
import { parseSpec, prepareCases, metrics, TEMPLATES, type EvaluationSpec, type Experiment } from "./contracts.js";
import { runTrial } from "./runner.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const authority = { actorId: "1", sessionId: "a".repeat(48) };
// Explicit placeholder shared only by this isolated in-process test.
const token = "[REDACTED_SECRET]".repeat(3);
const headers = { "x-eval-service-token": token, "x-eval-actor": authority.actorId, "x-eval-session": authority.sessionId };
function spec(template: "saishi-materials" | "memory-current" | "explore" = "saishi-materials"): EvaluationSpec {
  return { requestId: "request_a", title: "fixture test", mode: "replay", repetitions: 1, maxModelCalls: 8, maxTotalCalls: 9, confirmPaid: false,
    cases: [{ id: "case_1", input: template === "memory-current" ? "我之前的视频画幅偏好是什么" : "查询我的赛事素材处理状态", template,
      expectedFacts: [...TEMPLATES.find(t => t.id === template)!.facts], approved: true }] };
}
async function fixture() {
  const store = new EvaluationStore(":memory:"); const state = { active: true };
  const app = createEvaluationService({ store, serviceToken: token, revision: null,
    authorize: async actor => state.active && actor.actorId === authority.actorId && actor.sessionId === authority.sessionId });
  await app.ready(); cleanups.push(async () => { await app.close(); store.close(); });
  return { app, store, state };
}
async function ended(store: EvaluationStore, id: string): Promise<Experiment> {
  for (let i = 0; i < 300; i++) { const run = store.get(id); if (!["running", "cancelling"].includes(run.status)) return run; await delay(10); }
  throw new Error("Evaluation did not reach terminal state");
}

describe("Harness evaluator: real cloud/core/SQLite; fixture auth, scripted model and business I/O", () => {
  it("requires approved contracts and forbids arbitrary endpoint and unconfirmed spend parameters", () => {
    const cases = prepareCases({ lines: "查询我的赛事素材处理状态\n其他问题" });
    expect(cases.map(c => c.template)).toEqual(["saishi-materials", "explore"]);
    expect(cases.every(c => !c.approved)).toBe(true);
    expect(() => parseSpec({ ...spec(), endpoint: "https://example.invalid" })).toThrow();
    expect(() => parseSpec({ ...spec(), cases })).toThrow();
    expect(() => parseSpec({ ...spec(), mode: "live" })).toThrow();
    expect(() => parseSpec({ ...spec(), mode: "live", confirmPaid: true, maxTotalCalls: 1 })).toThrow();
  });
  it("runs shared cloud admission/tools, persists results, and reuses uncertain submissions", async () => {
    const f = await fixture();
    const accepted = await f.app.inject({ method: "POST", url: "/runs", headers, payload: spec() });
    expect(accepted.statusCode).toBe(202);
    const id = accepted.json().run.id as string; const run = await ended(f.store, id);
    expect(run.status).toBe("completed"); expect(run.trials[0]?.verdict).toBe("passed");
    expect(run.trials[0]?.tools.map(t => t.name)).toEqual(["saishi_list_events", "saishi_list_materials", "saishi_list_materials"]);
    expect(metrics(run).verifiedSuccessRate).toBeNull(); expect(metrics(run).protocolPassRate).toBe(1);
    const repeat = await f.app.inject({ method: "POST", url: "/runs", headers, payload: spec() });
    expect(repeat.statusCode).toBe(200); expect(repeat.json().run.id).toBe(id); expect(repeat.json().reused).toBe(true);
    expect((await f.app.inject({ url: "/requests/request_a", headers })).json().run.id).toBe(id);
    expect(f.store.counts(id)).toEqual({ agent: 4, judge: 0 });
    expect((await f.app.inject({ method: "POST", url: "/runs", headers, payload: { ...spec(), title: "changed" } })).statusCode).toBe(409);
  });
  it("measures actual memory references; free exploration cannot pass from a nonempty answer", async () => {
    for (const template of ["memory-current", "explore"] as const) {
      const s = spec(template);
      const result = await runTrial({ spec: s, test: s.cases[0]!, repetition: 1, signal: new AbortController().signal, budget: { take: () => undefined } });
      if (template === "explore") expect(result.verdict).toBe("review");
      else { expect(result.verdict).toBe("passed"); expect(result.recall).toBe(1); expect(result.retrievedMemoryIds).toContain("current-preference"); expect(result.retrievedMemoryIds).not.toContain("forbidden-reference"); }
    }
  });
  it("blocks missing service identity, forged actors, revoked admins and browser origins", async () => {
    const f = await fixture();
    expect((await f.app.inject("/catalog")).statusCode).toBe(401);
    expect((await f.app.inject({ url: "/runs", headers: { ...headers, "x-eval-actor": "2" } })).statusCode).toBe(403);
    expect((await f.app.inject({ url: "/catalog", headers: { ...headers, origin: "https://example.invalid" } })).statusCode).toBe(401);
    f.state.active = false;
    expect((await f.app.inject({ method: "POST", url: "/runs", headers, payload: spec() })).statusCode).toBe(403);
    expect(f.store.list()).toHaveLength(0);
  });
  it("refuses live mode without a dedicated model", async () => {
    const f = await fixture();
    expect((await f.app.inject({ method: "POST", url: "/runs", headers, payload: { ...spec(), mode: "live", confirmPaid: true } })).statusCode).toBe(503);
    expect(f.store.list()).toHaveLength(0);
  });
  it("marks restored active experiments interrupted and retains reservations without retry", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "harness-evaluation-")); cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const database = path.join(directory, "evaluation.sqlite"); const first = new EvaluationStore(database);
    const admitted = first.create(authority, spec(), null, null); first.reserveCall(admitted.run.id, "agent");
    expect(() => new EvaluationStore(database)).toThrow(); first.close();
    const next = new EvaluationStore(database);
    try { expect(next.get(admitted.run.id).status).toBe("interrupted"); expect(next.counts(admitted.run.id).agent).toBe(1);
      expect(next.create(authority, spec(), null, null).created).toBe(false); expect(metrics(next.get(admitted.run.id)).notRun).toBe(1);
    } finally { next.close(); }
  });
  it("cancels accepted work without replaying it", async () => {
    const f = await fixture(); const input = { ...spec(), repetitions: 5, maxTotalCalls: 45 };
    const admitted = await f.app.inject({ method: "POST", url: "/runs", headers, payload: input }); const id = admitted.json().run.id as string;
    expect((await f.app.inject({ method: "POST", url: `/runs/${id}/cancel`, headers, payload: {} })).statusCode).toBe(200);
    const result = await ended(f.store, id); expect(["cancelled", "completed"]).toContain(result.status);
    expect(f.store.create(authority, input, null, null).created).toBe(false);
  });
});
