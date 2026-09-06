import { describe, expect, it, vi } from "vitest";
import { WorkbenchClient, type CloudRun } from "./client.js";

function memory() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status });
const run: CloudRun = { id: "run_1", sessionId: "session_1", requestId: "request_1", userMessage: "介绍产品", status: "completed", finalText: "回答", lastEventSeq: 2, cancelRequested: false, authorizationId: "grant_1", billingAccountId: "payer_1", createdAt: "2026-09-05T12:00:00Z" };

describe("cloud workbench BFF contract and recovery (mock HTTP)", () => {
  it("bootstraps an account without a pasted grant and sends its boundary on every business request", async () => {
    const calls: string[] = [];
    const client = new WorkbenchClient(memory(), async (url, init) => {
      calls.push(String(url));
      expect(init?.credentials).toBe("same-origin");
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      if (String(url).endsWith("/bootstrap")) {
        expect(JSON.parse(String(init?.body))).toEqual({});
        return json({ csrfToken: "csrf", expiresAt: Date.now() + 60000, profileId: "saishi-readonly", authentication: "account", accountScope: "account_a" });
      }
      expect(new Headers(init?.headers).get("x-agent-account")).toBe("account_a");
      return json({ sessions: [] });
    }, "saishi");
    await client.bootstrap(); await client.sessions();
    expect(calls).toEqual(["/api/agent-apps/saishi/workbench/bootstrap", "/api/agent-apps/saishi/workbench/sessions"]);
  });
  it("isolates uncertain submissions across accounts and restores only the same account receipt", async () => {
    const store = memory();
    let scope = "account_a";
    const client = new WorkbenchClient(store, async (url) => {
      if (String(url).endsWith("/bootstrap")) return json({ csrfToken: "csrf", expiresAt: Date.now() + 60000,
        profileId: "saishi-readonly", authentication: "account", accountScope: scope });
      throw new Error("uncertain result");
    }, "saishi");
    await expect(client.submit("session_1", "问题")).rejects.toThrow("账号");
    await client.bootstrap();
    await expect(client.submit("session_1", "问题")).rejects.toThrow("连接中断");
    const pending = client.pending("session_1");
    scope = "account_b"; await client.bootstrap();
    expect(client.pending("session_1")).toBeUndefined();
    scope = "account_a"; await client.bootstrap();
    expect(client.pending("session_1")).toEqual(pending);
  });
  it("rejects legacy grant bootstrap and accepts only the fixed first-party login route", async () => {
    const legacy = new WorkbenchClient(memory(), async () => json({ csrfToken: "csrf", expiresAt: Date.now() + 60000, profileId: "saishi-readonly" }), "saishi");
    await expect(legacy.bootstrap()).rejects.toThrow("账号工作台尚未接通");
    for (const loginUrl of ["https://evil.example", "//evil.example", "/api/agent-apps/saishi/workbench/login"]) {
      const client = new WorkbenchClient(memory(), async () => json({ loginUrl }, 401), "saishi");
      await expect(client.bootstrap()).rejects.toMatchObject({ status: 401, loginUrl: loginUrl.startsWith("/api/") ? loginUrl : undefined });
    }
    const denied = new WorkbenchClient(memory(), async () => json({}, 403), "saishi");
    await expect(denied.bootstrap()).rejects.toThrow("没有此赛事数据的访问权限");
  });
  it("checks the server session profile before the selected plugin can start model work", async () => {
    let calls = 0;
    const client = new WorkbenchClient(memory(), async (_url, init) => {
      calls++;
      expect(JSON.parse(String(init?.body))).toEqual({ title: "问题" });
      return json({ session: { id: "session_1", profileId: "unexpected-profile" } });
    });
    await expect(client.createSession("问题", "company-public")).rejects.toThrow("插件与选择不一致");
    expect(calls).toBe(1);
  });
  it("does not bind the native browser fetch receiver to the client instance", async () => {
    const native = vi.spyOn(globalThis, "fetch").mockImplementation(async function (this: unknown) {
      if (this instanceof WorkbenchClient) throw new TypeError("Illegal invocation");
      return json({ csrfToken: "csrf", expiresAt: Date.now() + 1800000 });
    });
    try { await expect(new WorkbenchClient(memory()).bootstrap()).resolves.toBeGreaterThan(Date.now()); }
    finally { native.mockRestore(); }
  });
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
