import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@daoyin/harness-protocol";
import { WorkbenchClient, WorkbenchError, type CloudRun } from "./client.js";
import { watchCloudSession } from "./event-feed.js";

class Socket extends EventTarget {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readyState = 1;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = 3; });
  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent); }
  end(code = 1013) { this.readyState = 3; this.onclose?.({ code } as CloseEvent); }
  asWebSocket(): WebSocket { return this as unknown as WebSocket; }
}
const event = (seq: number): AgentEvent => ({ id: `evt_${seq}`, eventSeq: seq, accountId: "a", scopeId: "scope", sessionId: "ses_a", turnId: "run_a",
  occurredAt: new Date(0).toISOString(), type: "assistant.delta", payload: { contentBlockId: "b", delta: `text${seq}` } });
const run = (seq = 0, status: CloudRun["status"] = "running"): CloudRun => ({ id: "run_a", sessionId: "ses_a", requestId: "request_a", userMessage: "question",
  status, finalText: status === "completed" ? "finished" : "", lastEventSeq: seq, cancelRequested: false,
  authorizationId: "grant_a", billingAccountId: "payer_a", createdAt: new Date(0).toISOString() });
const stops: Array<() => void> = [];
function fixture() {
  vi.useFakeTimers();
  const sockets: Socket[] = [];
  const client = {
    runs: vi.fn(async () => [run()]), events: vi.fn(async () => [] as AgentEvent[]), observeRun: vi.fn(),
    streamDenied: vi.fn((status: 401 | 403) => new WorkbenchError("expired", status)),
    openEventStream: vi.fn((sessionId: string, after: number) => { expect(sessionId).toBe("ses_a"); expect(after).toBeGreaterThanOrEqual(0); const socket = new Socket(); sockets.push(socket); return socket.asWebSocket(); }),
  };
  const onUpdate = vi.fn(); const onError = vi.fn();
  const stop = watchCloudSession(client, "ses_a", { onUpdate, onError }); stops.push(stop);
  return { client, sockets, onUpdate, onError, stop };
}
afterEach(() => { for (const stop of stops.splice(0)) stop(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("cloud browser event feed: fake transport, real cursor and retry logic", () => {
  it("stops HTTP polling after ready and applies pushed deltas and terminal Run snapshots", async () => {
    const f = fixture(); await vi.advanceTimersByTimeAsync(0);
    const socket = f.sockets[0]!;
    socket.message({ type: "ready", sessionId: "ses_a", lastEventSeq: 0 });
    socket.message({ type: "events", sessionId: "ses_a", events: [event(1), event(2)], nextEventSeq: 2 });
    socket.message({ type: "run", sessionId: "ses_a", run: run(2, "completed") });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.client.runs).toHaveBeenCalledTimes(1); expect(f.client.events).toHaveBeenCalledTimes(1);
    expect(f.onUpdate.mock.lastCall?.[0][0].status).toBe("completed");
    expect(f.onUpdate.mock.lastCall?.[1].map((item: AgentEvent) => item.eventSeq)).toEqual([1, 2]);
  });
  it("reconnects from the last applied cursor and deduplicates replay, without a submit method", async () => {
    const f = fixture(); await vi.advanceTimersByTimeAsync(0);
    f.sockets[0]!.message({ type: "events", sessionId: "ses_a", events: [event(1)], nextEventSeq: 1 });
    f.sockets[0]!.message({ type: "ready", sessionId: "ses_a", lastEventSeq: 1 });
    f.sockets[0]!.end();
    await vi.advanceTimersByTimeAsync(600);
    expect(f.client.openEventStream.mock.lastCall).toEqual(["ses_a", 1]);
    const second = f.sockets[1]!;
    second.message({ type: "events", sessionId: "ses_a", events: [event(1), event(2)], nextEventSeq: 2 });
    second.message({ type: "ready", sessionId: "ses_a", lastEventSeq: 2 });
    expect(f.onUpdate.mock.lastCall?.[1]).toHaveLength(2);
    expect("submit" in f.client).toBe(false);
  });
  it("does not let a stale HTTP or socket Run snapshot roll back completion", async () => {
    const f = fixture(); await vi.advanceTimersByTimeAsync(0);
    f.sockets[0]!.message({ type: "run", sessionId: "ses_a", run: run(2, "completed") });
    f.sockets[0]!.message({ type: "run", sessionId: "ses_a", run: run(1) });
    expect(f.onUpdate.mock.lastCall?.[0][0].status).toBe("completed");
  });
  it("rejects gaps and foreign sessions rather than advancing the durable cursor", async () => {
    const f = fixture(); await vi.advanceTimersByTimeAsync(0);
    f.sockets[0]!.message({ type: "events", sessionId: "ses_a", events: [event(2)], nextEventSeq: 2 });
    await vi.advanceTimersByTimeAsync(600);
    expect(f.client.openEventStream.mock.lastCall).toEqual(["ses_a", 0]);
    f.sockets.at(-1)!.message({ type: "events", sessionId: "foreign", events: [event(1)], nextEventSeq: 1 });
    expect(f.onUpdate.mock.lastCall?.[1]).toEqual([]);
  });
  it.each([4401, 4403, 1008])("stops all retries on authority/policy closure %s", async (code) => {
    const f = fixture(); await vi.advanceTimersByTimeAsync(0);
    f.sockets[0]!.end(code);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.client.openEventStream).toHaveBeenCalledOnce();
    expect(f.client.runs).toHaveBeenCalledOnce(); expect(f.client.streamDenied).toHaveBeenCalledOnce();
  });
  it("keeps HTTP fallback for older servers and closes silently on page/session changes", async () => {
    const f = fixture(); await vi.advanceTimersByTimeAsync(0);
    f.sockets[0]!.end(); await vi.advanceTimersByTimeAsync(2100);
    expect(f.client.runs.mock.calls.length).toBeGreaterThan(1);
    f.stop(); const calls = f.onUpdate.mock.calls.length;
    f.sockets.at(-1)!.message({ type: "events", sessionId: "ses_a", events: [event(1)], nextEventSeq: 1 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.onUpdate).toHaveBeenCalledTimes(calls);
  });
  it("uses only a same-origin URL and sends existing CSRF/account assertions in the first frame", async () => {
    vi.stubGlobal("window", { location: { origin: "https://www.daoyintech.com" } });
    const storage = { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() };
    const fetcher = vi.fn(async () => Response.json({ csrfToken: "a".repeat(64), expiresAt: Date.now() + 60_000,
      profileId: "saishi-readonly", authentication: "account", accountScope: "b".repeat(64) }));
    const client = new WorkbenchClient(storage, fetcher, "saishi"); await client.bootstrap();
    const socket = new Socket(); const factory = vi.fn<(url: string) => WebSocket>(() => socket.asWebSocket());
    client.openEventStream("ses_a", 7, factory); socket.dispatchEvent(new Event("open"));
    expect(factory.mock.calls[0]?.[0]).toBe("wss://www.daoyintech.com/api/agent-apps/saishi/workbench/sessions/ses_a/events/ws");
    expect(JSON.parse(socket.send.mock.calls[0]![0])).toMatchObject({ type: "subscribe", after: 7, accountScope: "b".repeat(64) });
    expect(factory.mock.calls[0]?.[0]).not.toContain("?");
  });
});
