import websocket from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { ExecutionAccessError, executionScopeKey, type ExecutionIdentity } from "@daoyin/harness-contracts";
import type { AgentEvent } from "@daoyin/harness-protocol";
import { CloudError, type CloudRepository } from "./repository.js";

export interface EventStreamLimits {
  heartbeatMs?: number;
  subscribeTimeoutMs?: number;
  sendTimeoutMs?: number;
  maxConnections?: number;
  maxConnectionsPerScope?: number;
}
interface Options {
  repository: CloudRepository;
  identityFor(request: FastifyRequest): ExecutionIdentity;
  ensureActive(identity: ExecutionIdentity, signal?: AbortSignal): Promise<void>;
  limits?: EventStreamLimits;
}
const MAX_FRAME = 192_000;
const MAX_BUFFER = 512_000;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Private service endpoint. Browsers connect through the authenticated same-origin BFF. */
export function registerCloudEventStream(app: FastifyInstance, options: Options): void {
  const heartbeatMs = options.limits?.heartbeatMs ?? 10_000;
  const subscribeTimeoutMs = options.limits?.subscribeTimeoutMs ?? 5_000;
  const sendTimeoutMs = options.limits?.sendTimeoutMs ?? 5_000;
  const maxConnections = options.limits?.maxConnections ?? 128;
  const perScope = options.limits?.maxConnectionsPerScope ?? 4;
  for (const value of [heartbeatMs, subscribeTimeoutMs, sendTimeoutMs, maxConnections, perScope]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) throw new Error("Invalid event stream limits.");
  }
  const connections = new Set<() => void>();
  const counts = new Map<string, number>();
  let closing = false;
  app.addHook("preClose", async () => {
    closing = true;
    for (const close of [...connections]) close();
  });
  // Register routes after the websocket plugin has installed its onRoute hook.
  void app.register(websocket, { options: { maxPayload: 1024, perMessageDeflate: false } });
  void app.register(async (routes) => {
    routes.get<{ Params: { sessionId: string } }>("/api/v1/cloud/sessions/:sessionId/events/ws", {
      websocket: true,
      schema: { params: { type: "object", required: ["sessionId"], additionalProperties: false,
        properties: { sessionId: { type: "string", pattern: "^[A-Za-z0-9_-]{1,160}$" } } },
        querystring: { type: "object", additionalProperties: false, properties: {} } },
      preHandler: async (request) => {
        if (closing || !options.repository.subscribeSession) throw new CloudError(503, "EVENT_STREAM_UNAVAILABLE", "请使用历史回放接口。");
        await options.repository.getSession(options.identityFor(request), request.params.sessionId);
      },
    }, (socket, request) => {
      const identity = options.identityFor(request);
      const key = executionScopeKey(identity);
      if (closing || connections.size >= maxConnections || (counts.get(key) ?? 0) >= perScope) {
        socket.close(1013, "event stream capacity");
        const kill = setTimeout(() => socket.terminate(), 1000); kill.unref();
        return;
      }
      counts.set(key, (counts.get(key) ?? 0) + 1);
      const close = attach(socket, identity, request.params.sessionId, () => {
        connections.delete(close);
        const remaining = (counts.get(key) ?? 1) - 1;
        if (remaining) counts.set(key, remaining); else counts.delete(key);
      });
      connections.add(close);
    });
  });

  function attach(socket: WebSocket, identity: ExecutionIdentity, sessionId: string, released: () => void): () => void {
    const controller = new AbortController();
    let subscribed = false;
    let stopped = false;
    let ready = false;
    let alive = true;
    let dirty = false;
    let busy = false;
    let cursor = 0;
    let unsubscribe = (): void => undefined;
    let wakeTimer: ReturnType<typeof setTimeout> | undefined;
    const knownRuns = new Map<string, string>();
    const firstMessage = setTimeout(() => end(1008, "subscribe timeout"), subscribeTimeoutMs);
    firstMessage.unref();
    const heartbeat = setInterval(() => {
      if (stopped || !subscribed || busy) return;
      if (!alive) { end(1013, "heartbeat timeout"); return; }
      alive = false;
      socket.ping();
      // Shares the same pump as data; no overlapping sends or periodic event-table polling.
      wake(false);
    }, heartbeatMs);
    heartbeat.unref();
    socket.on("pong", () => { alive = true; });
    socket.once("error", () => end(1013, "connection interrupted"));
    socket.once("close", cleanup);
    socket.on("message", (data, binary) => {
      if (stopped) return;
      try {
        const text = data.toString();
        if (binary || subscribed || Buffer.byteLength(text) > 1024) throw new Error("Invalid subscription");
        const value: unknown = JSON.parse(text);
        if (!record(value) || value.type !== "subscribe" || Object.keys(value).some((k) => !["type", "after"].includes(k)) ||
            typeof value.after !== "number" || !Number.isSafeInteger(value.after) || value.after < 0 || value.after > 999_999_999_999) throw new Error("Invalid cursor");
        subscribed = true;
        cursor = value.after;
        clearTimeout(firstMessage);
        // Register before the first read. Notifications only mark dirty, so arbitrarily
        // many deltas cannot create an unbounded per-connection queue during replay.
        unsubscribe = options.repository.subscribeSession!(identity, sessionId, () => wake(true));
        wake(true);
      } catch { end(1008, "invalid subscription"); }
    });

    function cleanup(): void {
      if (stopped) return;
      stopped = true;
      controller.abort();
      unsubscribe();
      clearTimeout(firstMessage); clearTimeout(wakeTimer); clearInterval(heartbeat);
      released();
    }
    function end(code: number, reason: string): void {
      if (stopped) return;
      cleanup();
      socket.close(code, reason);
      const kill = setTimeout(() => { if (socket.readyState !== 3) socket.terminate(); }, 1000);
      kill.unref();
    }
    async function send(value: Record<string, unknown>): Promise<void> {
      const text = JSON.stringify({ ...value, sessionId });
      if (Buffer.byteLength(text) > MAX_FRAME || socket.bufferedAmount > MAX_BUFFER) throw new Error("Slow consumer");
      // Recheck after database reads and before EACH data frame. Expiry is also
      // enforced during idle heartbeat; never grant indefinite access at handshake.
      await options.ensureActive(identity, controller.signal);
      controller.signal.throwIfAborted();
      if (socket.readyState !== 1) throw new Error("Closed stream");
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => finish(new Error("Slow consumer")), sendTimeoutMs);
        const onAbort = (): void => finish(new Error("Closed stream"));
        let settled = false;
        function finish(error?: Error): void {
          if (settled) return;
          settled = true;
          clearTimeout(timeout); controller.signal.removeEventListener("abort", onAbort);
          if (error) reject(error); else resolve();
        }
        controller.signal.addEventListener("abort", onAbort, { once: true });
        socket.send(text, (error) => finish(error));
      });
    }
    function wake(changed: boolean): void {
      if (stopped) return;
      dirty ||= changed;
      if (busy || wakeTimer !== undefined) return;
      wakeTimer = setTimeout(() => { wakeTimer = undefined; void pump(); }, 40);
      wakeTimer.unref();
    }
    async function sendEvents(events: AgentEvent[]): Promise<void> {
      let batch: AgentEvent[] = [];
      let bytes = 256;
      async function flush(): Promise<void> {
        if (!batch.length) return;
        const next = batch.at(-1)!.eventSeq;
        await send({ type: "events", events: batch, nextEventSeq: next });
        cursor = next;
        batch = []; bytes = 256;
      }
      for (const event of events) {
        const expected = batch.at(-1)?.eventSeq ?? cursor;
        if (event.sessionId !== sessionId || event.eventSeq !== expected + 1) throw new CloudError(409, "EVENT_GAP", "事件游标不连续。");
        const size = Buffer.byteLength(JSON.stringify(event)) + 1;
        if (bytes + size > MAX_FRAME - 256) await flush();
        batch.push(event); bytes += size;
      }
      await flush();
    }
    async function pump(): Promise<void> {
      if (busy || stopped) return;
      busy = true;
      try {
        await options.ensureActive(identity, controller.signal);
        if (!dirty && ready) {
          await send({ type: "heartbeat", lastEventSeq: cursor });
          return;
        }
        do {
          dirty = false;
          await options.repository.getSession(identity, sessionId);
          if (!ready) {
            const runs = await options.repository.listRuns(identity, sessionId);
            if (cursor > Math.max(0, ...runs.map((run) => run.lastEventSeq))) throw new CloudError(409, "EVENT_CURSOR_AHEAD", "事件游标超前。");
          }
          let page: AgentEvent[];
          do {
            page = await options.repository.readEvents(identity, sessionId, cursor, 32);
            if (page.length) await sendEvents(page);
          } while (page.length === 32 && !stopped);
          const runs = await options.repository.listRuns(identity, sessionId);
          for (const run of runs) {
            const fingerprint = JSON.stringify(run);
            if (knownRuns.get(run.id) === fingerprint) continue;
            await send({ type: "run", run });
            knownRuns.set(run.id, fingerprint);
          }
          if (runs.some((run) => run.lastEventSeq > cursor)) dirty = true;
          if (!ready && !dirty) {
            await send({ type: "ready", lastEventSeq: cursor });
            ready = true;
          }
        } while (dirty && !stopped);
      } catch (error) {
        const status = error instanceof CloudError ? error.statusCode : error instanceof ExecutionAccessError ? 401 : 503;
        const code = status === 401 ? 4401 : status === 403 ? 4403 : status === 404 ? 4404 : status === 409 ? 4409 : 1013;
        end(code, code === 1013 ? "reconnect and replay" : "subscription no longer valid");
      } finally {
        busy = false;
        if (dirty && !stopped) wake(true);
      }
    }
    return () => end(1012, "service restart");
  }
}
