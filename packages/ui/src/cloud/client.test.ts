import { describe, expect, it } from "vitest";
import { WorkbenchClient, type CloudRun } from "./client.js";

function memory() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status });
const run: CloudRun = { id: "run_1", sessionId: "session_1", requestId: "request_1", userMessage: "介绍产品", status: "completed", finalText: "回答", lastEventSeq: 2, cancelRequested: false, authorizationId: "grant_1", billingAccountId: "payer_1", createdAt: "2026-09-05T12:00:00Z" };

describe("cloud workbench BFF contract and recovery (mock HTTP)", () => {
  it("preserves the exact request across an uncertain response and a page reload", async () => {
    const store = memory();
    const submitted: string[] = [];
    let fail = true;
    const fetcher: typeof fetch = async (url, init) => {
      expect(String(url)).toMatch(/^\/api\/company-assistant\/agent\//u);
      expect(init?.credentials).toBe("same-origin");
      expect(init?.redirect).toBe("error");
      expect(init?.headers).not.toHaveProperty("Authorization");
      if (String(url).endsWith("/bootstrap")) return json({ csrfToken: "test-csrf", expiresAt: Date.now() + 1800000 });
      expect(init?.headers).toHaveProperty("x-agent-csrf", "test-csrf");
      submitted.push(String(init?.body));
      if (fail) { fail = false; throw new Error("connection lost after admission"); }
      return json({ run });
    };
    const first = new WorkbenchClient(store, fetcher);
    await first.bootstrap();
    await expect(first.submit("session_1", "介绍产品")).rejects.toThrow("连接中断");
    const restored = new WorkbenchClient(store, fetcher);
    expect(restored.pending("session_1")?.message).toBe("介绍产品");
    await expect(restored.submit("session_1", "修改正文")).rejects.toThrow("恢复原提交");
    await restored.bootstrap();
    await restored.submit("session_1", "介绍产品");
    expect(submitted).toHaveLength(2);
    expect(submitted[1]).toBe(submitted[0]);
    expect(restored.pending("session_1")).toBeUndefined();
  });

  it("does not start a billable request if a durable receipt cannot be stored", async () => {
    let calls = 0;
    const client = new WorkbenchClient({ ...memory(), setItem: () => { throw new Error("storage denied"); } }, async () => { calls++; return json({}); });
    await expect(client.submit("session_1", "问题")).rejects.toThrow("会话存储");
    expect(calls).toBe(0);
  });

  it("resolves an uncertain accepted request by read-only replay", async () => {
    const store = memory();
    store.setItem("daoyin-harness-cloud-receipts-v1", JSON.stringify([{ sessionId: run.sessionId, requestId: run.requestId, message: run.userMessage }]));
    const client = new WorkbenchClient(store, async (_url, init) => { expect(init?.method).toBe("GET"); return json({ runs: [run] }); });
    await client.runs(run.sessionId);
    expect(client.pending(run.sessionId)).toBeUndefined();
  });

  it("pages replay once per sequence and rejects a stalled cursor", async () => {
    const paths: string[] = [];
    const client = new WorkbenchClient(memory(), async (url) => {
      paths.push(String(url));
      return paths.length === 1 ? json({ events: [{ eventSeq: 1 }], nextEventSeq: 1, hasMore: true }) :
        json({ events: [{ eventSeq: 1 }, { eventSeq: 2 }], nextEventSeq: 2, hasMore: false });
    });
    expect((await client.events("session_1", 0)).map((event) => event.eventSeq)).toEqual([1, 2]);
    expect(paths[1]).toContain("after=1");
    const stalled = new WorkbenchClient(memory(), async () => json({ events: [], nextEventSeq: 0, hasMore: true }));
    await expect(stalled.events("session_1", 0)).rejects.toThrow("游标无效");
  });

  it("does not silently bootstrap or retry when authorization expires", async () => {
    let calls = 0;
    const client = new WorkbenchClient(memory(), async () => { calls++; return json({ error: "private upstream trace" }, 401); });
    await expect(client.sessions()).rejects.toMatchObject({ status: 401 });
    expect(calls).toBe(1);
  });

  it("cancels through the same protected BFF and aborts abandoned views", async () => {
    const client = new WorkbenchClient(memory(), async (url, init) => {
      if (String(url).endsWith("/bootstrap")) return json({ csrfToken: "csrf", expiresAt: Date.now() + 1800000 });
      expect(String(url)).toBe("/api/company-assistant/agent/runs/run_1/cancel");
      expect(init?.method).toBe("POST"); expect(init?.headers).toHaveProperty("x-agent-csrf", "csrf");
      return json({ run: { ...run, status: "cancelled" } });
    });
    await client.bootstrap(); await client.cancel("run_1");
    const controller = new AbortController();
    const slow = new WorkbenchClient(memory(), async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const reading = slow.sessions(controller.signal); controller.abort();
    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
  });
});
