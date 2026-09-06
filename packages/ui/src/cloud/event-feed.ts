import type { AgentEvent } from "@daoyin/harness-protocol";
import { WorkbenchError, type WorkbenchClient, type CloudRun } from "./client.js";

type FeedClient = Pick<WorkbenchClient, "runs" | "events" | "openEventStream" | "observeRun" | "streamDenied">;
interface Options {
  events?: readonly AgentEvent[];
  onUpdate(runs: CloudRun[], events: AgentEvent[]): void;
  onError(error: unknown): void;
  onTransport?(mode: "connecting" | "websocket" | "http"): void;
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/u.test(value);
const sequence = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const eventTypes = new Set(["turn.started", "assistant.delta", "tool.started", "tool.completed", "tool.failed", "turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"]);
function eventValue(value: unknown, sessionId: string): value is AgentEvent {
  return record(value) && value.sessionId === sessionId && identifier(value.id) && identifier(value.turnId) &&
    sequence(value.eventSeq) && value.eventSeq > 0 && typeof value.type === "string" && eventTypes.has(value.type) && record(value.payload);
}
function runValue(value: unknown, sessionId: string): value is CloudRun {
  return record(value) && value.sessionId === sessionId && identifier(value.id) && identifier(value.requestId) &&
    sequence(value.lastEventSeq) && typeof value.status === "string" && ["queued", "running", "completed", "failed", "cancelled", "interrupted"].includes(value.status) &&
    typeof value.userMessage === "string" && typeof value.finalText === "string" && typeof value.cancelRequested === "boolean" && typeof value.createdAt === "string";
}

/** Read-only transport. This module deliberately has NO submit or cancel dependency. */
export function watchCloudSession(client: FeedClient, sessionId: string, options: Options): () => void {
  const controller = new AbortController();
  let stopped = false;
  let socket: WebSocket | undefined;
  let live = false;
  let reconnects = 0;
  let httpBusy = false;
  let cursor = 0;
  const events = new Map<number, AgentEvent>();
  const runs = new Map<string, CloudRun>();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let watchTimer: ReturnType<typeof setTimeout> | undefined;

  function update(): void {
    if (stopped) return;
    options.onUpdate([...runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)), [...events.values()]);
  }
  function addEvents(values: unknown): void {
    if (!Array.isArray(values) || values.length > 24_000) throw new Error("Invalid event page");
    let next = cursor;
    const pending: AgentEvent[] = [];
    for (const value of values) {
      if (!eventValue(value, sessionId)) throw new Error("Invalid event scope");
      if (value.eventSeq <= cursor) {
        if (events.get(value.eventSeq)?.id !== value.id) throw new Error("Conflicting event");
        continue;
      }
      if (value.eventSeq !== next + 1) throw new Error("Event gap");
      pending.push(value); next = value.eventSeq;
    }
    if (events.size + pending.length > 24_000) throw new Error("Event history limit");
    for (const event of pending) events.set(event.eventSeq, event);
    cursor = next;
  }
  function addRun(value: unknown): void {
    if (!runValue(value, sessionId)) throw new Error("Invalid Run scope");
    const previous = runs.get(value.id);
    if (previous && (previous.lastEventSeq > value.lastEventSeq ||
        (previous.lastEventSeq === value.lastEventSeq && ((!['running', 'queued'].includes(previous.status) && ['running', 'queued'].includes(value.status)) ||
          (previous.cancelRequested && !value.cancelRequested))))) return;
    runs.set(value.id, value);
    client.observeRun(value);
  }
  function detach(): void {
    clearTimeout(watchTimer);
    const old = socket; socket = undefined; live = false;
    if (old) { old.onmessage = null; old.onerror = null; old.onclose = null; old.close(); }
  }
  function stop(): void {
    if (stopped) return;
    stopped = true; controller.abort();
    clearTimeout(retryTimer); clearTimeout(pollTimer); detach();
  }
  function deny(status: 401 | 403): void {
    stop(); options.onError(client.streamDenied(status));
  }
  function watchdog(delay: number): void {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => disconnected(1013), delay);
  }
  function schedulePoll(delay: number): void {
    clearTimeout(pollTimer);
    if (!stopped && !live) pollTimer = setTimeout(() => { void refreshHttp(); }, delay);
  }
  async function refreshHttp(): Promise<void> {
    if (stopped || live || httpBusy) return;
    httpBusy = true;
    try {
      const after = cursor;
      const [currentRuns, additions] = await Promise.all([client.runs(sessionId, controller.signal), client.events(sessionId, after, controller.signal)]);
      if (stopped) return;
      addEvents(additions);
      for (const run of currentRuns) addRun(run);
      update();
    } catch (error) {
      if (stopped) return;
      if (error instanceof WorkbenchError && (error.status === 401 || error.status === 403)) { deny(error.status); return; }
      options.onError(error);
    } finally {
      httpBusy = false;
      if (!stopped && !live) schedulePoll([...runs.values()].some((run) => ['running', 'queued'].includes(run.status)) ? 2000 : 10_000);
    }
  }
  function disconnected(code: number): void {
    if (stopped) return;
    detach();
    if ([4001, 4401].includes(code)) { deny(401); return; }
    if ([1008, 4403].includes(code)) { deny(403); return; }
    if (code === 4404) { stop(); options.onError(new WorkbenchError("会话不存在或当前账号无权访问。", 404)); return; }
    if (code === 4409) { events.clear(); runs.clear(); cursor = 0; update(); }
    options.onTransport?.("http");
    schedulePoll(0);
    clearTimeout(retryTimer);
    const delay = Math.min(10_000, 500 * 2 ** Math.min(reconnects++, 5)) * (0.8 + Math.random() * 0.2);
    retryTimer = setTimeout(open, delay);
  }
  function open(): void {
    if (stopped) return;
    detach();
    options.onTransport?.("connecting");
    try {
      const current = client.openEventStream(sessionId, cursor);
      socket = current;
      watchdog(8000);
      current.onmessage = ({ data }: MessageEvent<unknown>) => {
        if (stopped || socket !== current) return;
        try {
          if (typeof data !== "string" || new TextEncoder().encode(data).byteLength > 192_000) throw new Error("Oversized frame");
          const frame: unknown = JSON.parse(data);
          if (!record(frame) || frame.sessionId !== sessionId) throw new Error("Invalid subscription scope");
          if (frame.type === "events") {
            addEvents(frame.events);
            // HTTP fallback may already have applied a later contiguous event.
            if (!sequence(frame.nextEventSeq) || frame.nextEventSeq > cursor) throw new Error("Invalid cursor");
          } else if (frame.type === "run") addRun(frame.run);
          else if (frame.type === "ready") {
            if (!sequence(frame.lastEventSeq) || frame.lastEventSeq > cursor) throw new Error("Replay gap");
            live = true; reconnects = 0; clearTimeout(pollTimer);
            options.onTransport?.("websocket");
          } else if (frame.type === "heartbeat") {
            if (!sequence(frame.lastEventSeq) || frame.lastEventSeq > cursor) throw new Error("Missed events");
          } else throw new Error("Unsupported frame");
          watchdog(35_000);
          update();
        } catch { disconnected(4409); }
      };
      current.onerror = () => { if (socket === current) disconnected(1013); };
      current.onclose = (event) => { if (socket === current) disconnected(event.code); };
    } catch (error) {
      if (error instanceof WorkbenchError && [401, 403].includes(error.status)) { deny(error.status as 401 | 403); return; }
      disconnected(1013);
    }
  }
  try { addEvents(options.events ?? []); } catch { events.clear(); cursor = 0; }
  // One initial HTTP snapshot provides compatibility with older deployments. From
  // ready onward the live stream owns updates and polling is completely stopped.
  void refreshHttp().finally(() => { if (!stopped) open(); });
  return stop;
}
