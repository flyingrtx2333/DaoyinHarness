import Fastify, { type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { EvaluationError, EVALUATOR_VERSION, metrics, parseSpec, prepareCases, TEMPLATES, type Experiment } from "./contracts.js";
import { EvaluationStore, type Authority } from "./store.js";
import { runTrial } from "./runner.js";
import type { EvaluationModelConfig } from "./provider.js";

export interface EvaluationServiceOptions {
  store: EvaluationStore; serviceToken: string; revision: string | null;
  authorize(authority: Authority, signal: AbortSignal): Promise<boolean>;
  model?: EvaluationModelConfig; fetcher?: typeof fetch;
}
const safeEqual = (actual: unknown, expected: string): boolean => typeof actual === "string" && Buffer.byteLength(actual) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
const idParams = { type: "object", required: ["id"], additionalProperties: false, properties: { id: { type: "string", pattern: "^ev_[a-f0-9]{32}$" } } };
export function createEvaluationService(options: EvaluationServiceOptions) {
  if (!/^[\x21-\x7e]{32,256}$/u.test(options.serviceToken)) throw new Error("A dedicated evaluation service credential is required.");
  const app = Fastify({ logger: false, bodyLimit: 512_000, ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } } });
  const actors = new WeakMap<FastifyRequest, Authority>();
  let active: { id: string; controller: AbortController; done: Promise<void>; caseId: string; repetition: number; stage: string } | undefined;
  let closing = false;
  const heartbeat = setInterval(() => { try { options.store.renew(); } catch { closing = true; active?.controller.abort(); } }, 10_000);
  heartbeat.unref();
  async function check(authority: Authority, parent?: AbortSignal): Promise<void> {
    options.store.assertOwner();
    const signal = parent ? AbortSignal.any([parent, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
    if (!await options.authorize(authority, signal)) throw new EvaluationError(403, "SUPERADMIN_REQUIRED", "超级管理员身份已失效。");
    signal.throwIfAborted(); options.store.assertOwner();
  }
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff");
    if (request.url === "/health" && request.method === "GET") return;
    if (closing) throw new EvaluationError(503, "EVAL_NOT_READY", "评估服务暂不可用。");
    if (request.headers.origin !== undefined || !safeEqual(request.headers["x-eval-service-token"], options.serviceToken)) throw new EvaluationError(401, "EVAL_SERVICE_AUTH", "评估服务鉴权失败。");
    const actorId = request.headers["x-eval-actor"]; const sessionId = request.headers["x-eval-session"];
    if (typeof actorId !== "string" || !/^[1-9][0-9]{0,15}$/u.test(actorId) || typeof sessionId !== "string" || !/^[a-f0-9]{48}$/u.test(sessionId)) throw new EvaluationError(401, "EVAL_ACTOR_REQUIRED", "缺少可信操作者。");
    const authority = { actorId, sessionId }; await check(authority); actors.set(request, authority);
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof EvaluationError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    const validation = error instanceof Error && ("validation" in error || ("statusCode" in error && error.statusCode === 413));
    return reply.code(validation ? 400 : 503).send({ error: { code: validation ? "EVAL_INPUT_INVALID" : "EVAL_SERVICE_FAILURE", message: validation ? "评估请求格式或大小不正确。" : "评估服务未完成请求，请查询原实验，勿重复提交。" } });
  });
  function summary(run: Experiment) {
    return { ...run, trials: run.trials.map(t => ({ ...t, answer: "", checks: [], tools: [] })), metrics: metrics(run),
      dispatchedCalls: options.store.counts(run.id), active: active?.id === run.id ? { caseId: active.caseId, repetition: active.repetition, stage: active.stage } : null };
  }
  async function execute(id: string, controller: AbortController): Promise<void> {
    try {
      const run = options.store.get(id); const authority = options.store.authority(id);
      for (const test of run.spec.cases) for (let repetition = 1; repetition <= run.spec.repetitions; repetition++) {
        controller.signal.throwIfAborted(); await check(authority, controller.signal);
        if (active?.id === id) { active.caseId = test.id; active.repetition = repetition; active.stage = "准备隔离环境"; }
        const trial = await runTrial({ spec: run.spec, test, repetition, signal: controller.signal,
          ...(options.model ? { model: options.model } : {}), ...(options.fetcher ? { fetcher: options.fetcher } : {}),
          budget: { take: async kind => {
            try { await check(authority, controller.signal); } catch (error) { controller.abort(); throw error; }
            options.store.reserveCall(id, kind);
          } },
          onStage: stage => { if (active?.id === id) active.stage = stage; },
        });
        options.store.append(id, trial);
      }
      options.store.state(id, controller.signal.aborted ? "cancelled" : "completed");
    } catch { try { options.store.state(id, controller.signal.aborted ? "cancelled" : "failed"); } catch { closing = true; } }
    finally { if (active?.id === id) active = undefined; }
  }
  app.get("/health", async (_request, reply) => { try { options.store.assertOwner(); } catch { closing = true; } return reply.code(closing ? 503 : 200).send({ status: closing ? "unavailable" : "ok" }); });
  app.get("/catalog", async () => ({ version: EVALUATOR_VERSION, revision: options.revision, templates: TEMPLATES,
    liveAvailable: !!options.model, model: options.model?.model ?? null, judgeModel: options.model?.judgeModel ?? null,
    maxCases: 50, maxRepetitions: 5, scope: "shared-cloud-api-and-engine-with-isolated-fixtures",
    excludes: ["production-authentication-chain", "production-business-database", "browser-websocket", "financial-settlement"] }));
  app.post("/prepare", async request => ({ cases: prepareCases(request.body) }));
  app.get<{ Params: { requestId: string } }>("/requests/:requestId", {
    schema: { params: { type: "object", additionalProperties: false, required: ["requestId"], properties: { requestId: { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" } } } },
  }, async request => {
    const run = options.store.findRequest(actors.get(request)!.actorId, request.params.requestId);
    return { run: run ? summary(run) : null };
  });
  app.get<{ Querystring: { offset?: string } }>("/runs", { schema: { querystring: { type: "object", additionalProperties: false, properties: { offset: { type: "string", pattern: "^[0-9]{1,5}$" } } } } }, async request => ({
    runs: options.store.list(Number(request.query.offset ?? 0)).map(run => ({ id: run.id, title: run.spec.title, status: run.status, createdAt: run.createdAt,
      mode: run.spec.mode, planned: run.planned, completed: run.completed, metrics: metrics(run) })),
  }));
  app.post("/runs", async (request, reply) => {
    const spec = parseSpec(request.body);
    if (spec.mode === "live" && !options.model) throw new EvaluationError(503, "EVAL_MODEL_DISABLED", "请先由运维配置专用评估模型。");
    const result = options.store.create(actors.get(request)!, spec, spec.mode === "live" ? `${options.model!.model} / judge:${options.model!.judgeModel}` : null, options.revision);
    if (result.created) {
      const controller = new AbortController();
      active = { id: result.run.id, controller, done: Promise.resolve(), caseId: "", repetition: 0, stage: "已受理" };
      active.done = Promise.resolve().then(() => execute(result.run.id, controller));
    }
    return reply.code(result.created ? 202 : 200).send({ run: summary(result.run), reused: !result.created });
  });
  app.get<{ Params: { id: string } }>("/runs/:id", { schema: { params: idParams } }, async request => summary(options.store.get(request.params.id)));
  app.get<{ Params: { id: string; caseId: string; repetition: string } }>("/runs/:id/trials/:caseId/:repetition", {
    schema: { params: { type: "object", required: ["id", "caseId", "repetition"], additionalProperties: false, properties: { ...idParams.properties,
      caseId: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" }, repetition: { type: "string", pattern: "^[1-5]$" } } } },
  }, async request => {
    const run = options.store.get(request.params.id); const trial = run.trials.find(t => t.caseId === request.params.caseId && t.repetition === Number(request.params.repetition));
    if (!trial) throw new EvaluationError(404, "EVAL_TRIAL_NOT_FOUND", "该次试验尚无结果。");
    return { trial, test: run.spec.cases.find(c => c.id === trial.caseId), mode: run.spec.mode };
  });
  app.post<{ Params: { id: string } }>("/runs/:id/cancel", { schema: { params: idParams, body: { type: "object", additionalProperties: false } } }, async request => {
    const run = options.store.get(request.params.id);
    if (run.status === "running") { options.store.state(run.id, "cancelling"); if (active?.id === run.id) active.controller.abort("admin-cancel"); }
    return summary(options.store.get(run.id));
  });
  app.get<{ Params: { id: string } }>("/runs/:id/report", { schema: { params: idParams } }, async (request, reply) => {
    const run = options.store.get(request.params.id);
    reply.header("Content-Disposition", `attachment; filename="${run.id}.json"`);
    return { ...run, metrics: metrics(run), dispatchedCalls: options.store.counts(run.id), completeEvidence: run.status === "completed" && run.completed === run.planned };
  });
  app.addHook("onClose", async () => { closing = true; clearInterval(heartbeat); active?.controller.abort("service-close"); await active?.done; });
  return app;
}
