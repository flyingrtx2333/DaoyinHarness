import { describe, expect, it, vi } from "vitest";
import { EvaluationClient } from "./evaluation-client.js";

const bootstrap = { allowed: true, accountScope: "a".repeat(64), csrfToken: "b".repeat(64) };
describe("superadmin evaluation browser transport: mocked server, no credentials in storage or URL", () => {
  it("uses first-party cookie assertions for read and write requests", async () => {
    const calls: Array<{ url: string; options?: RequestInit }> = [];
    const fetcher = vi.fn<typeof fetch>(async (url, options) => { calls.push({ url: String(url), ...(options ? { options } : {}) }); return Response.json(String(url).endsWith("bootstrap") ? bootstrap : { cases: [] }); });
    const client = new EvaluationClient(fetcher);
    await client.bootstrap(); await client.prepare("问题");
    expect(calls[1]?.url).toBe("/api/harness-evaluation/prepare");
    const options = calls[1]?.options;
    expect(options?.credentials).toBe("same-origin"); expect(options?.redirect).toBe("error");
    expect(new Headers(options?.headers).get("x-eval-account")).toBe(bootstrap.accountScope);
    expect(new Headers(options?.headers).get("x-eval-csrf")).toBe(bootstrap.csrfToken);
    expect(calls[1]?.url).not.toContain(bootstrap.csrfToken);
  });
  it("cannot turn a forbidden response into admin access", async () => {
    const client = new EvaluationClient(async () => Response.json({ detail: { code: "SUPERADMIN_REQUIRED" } }, { status: 403 }));
    await expect(client.bootstrap()).rejects.toMatchObject({ status: 403 }); expect(client.scope).toBe("");
  });
  it("drops results obtained under an earlier account scope", async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith("bootstrap") ? Response.json(bootstrap) : new Promise<Response>(resolve => { finish = resolve; }));
    const client = new EvaluationClient(fetcher); await client.bootstrap();
    const pending = client.history(0); client.reset(); finish(Response.json({ runs: [{ title: "previous account" }] }));
    await expect(pending).rejects.toMatchObject({ code: "EVAL_ACCOUNT_CHANGED" });
  });
  it("does not install credentials from an aborted bootstrap", async () => {
    const controller = new AbortController();
    const client = new EvaluationClient(async () => { controller.abort(); return Response.json(bootstrap); });
    await expect(client.bootstrap(controller.signal)).rejects.toThrow(); expect(client.scope).toBe("");
  });
});
