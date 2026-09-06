import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthenticationSummary, RuntimeBootstrap, SessionEventsResponse } from "@daoyin/harness-protocol";
import { JsonSessionCatalog } from "@daoyin/harness-workspace";
import { JsonlProcessPermissionStore } from "@daoyin/harness-process";
import { createApp, type CreateAppOptions, type HarnessAuthentication } from "./app.js";
import { runtimeAccountScope } from "./account-scope.js";

const userA = { id: 17, userName: "Account A", tenantId: 9 };
const userB = { id: 18, userName: "Account B", tenantId: 9 };
class TestAuthentication implements HarnessAuthentication {
  readonly authority = "https://accounts.example.test";
  account: typeof userA | null = { ...userA };
  status(): AuthenticationSummary { return this.account === null ? { status: "signed_out", account: null } : { status: "signed_in", account: { ...this.account } }; }
  beginAuthorization() { return { authorizationUrl: `${this.authority}/authorize?state=test-state` }; }
  async completeAuthorization(code: string, state: string) {
    if (state !== "test-state" || !["a", "b"].includes(code)) throw new Error("Invalid test callback");
    this.account = { ...(code === "a" ? userA : userB) };
    return { ...this.account };
  }
  async logout() { this.account = null; }
}
let app: FastifyInstance | undefined;
let directory: string | undefined;
const host = { host: "127.0.0.1:4677" };
async function fixture(extra: Partial<CreateAppOptions> = {}) {
  directory = await mkdtemp(join(tmpdir(), "daoyin-account-isolation-"));
  const root = join(directory, "workspace");
  const other = join(directory, "other-workspace");
  const dataDir = join(directory, "data");
  await mkdir(root); await mkdir(other); await writeFile(join(root, "note.txt"), "shared explicitly selected file");
  const authentication = new TestAuthentication();
  app = await createApp({ port: 4677, version: "test", startedAt: new Date().toISOString(), dataDir,
    workspaceRoot: root, authentication, model: { async complete() { return { kind: "assistant", content: "fixture answer" }; } }, ...extra });
  return { root, other, dataDir, authentication };
}
async function bootstrap() {
  if (app === undefined) throw new Error("fixture missing");
  const response = await app.inject({ url: "/api/v1/bootstrap", headers: host });
  expect(response.statusCode).toBe(200);
  const body = response.json<RuntimeBootstrap>();
  const cookies = response.headers["set-cookie"];
  return { body, headers: { ...host, cookie: ((Array.isArray(cookies) ? cookies[0] : cookies) ?? "").split(";")[0] ?? "",
    "x-daoyin-csrf": body.csrfToken, "x-daoyin-workspace": body.workspaceRevision ?? "" } };
}
async function callback(code: "a" | "b") {
  const result = await app!.inject({ url: `/api/v1/auth/callback?code=${code}&state=test-state`, headers: host });
  expect(result.statusCode).toBe(200);
  expect(result.body).toContain("登录成功");
  return bootstrap();
}
afterEach(async () => {
  await app?.close(); app = undefined;
  if (directory !== undefined) await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  directory = undefined;
});

describe("account namespaces", () => {
  it("keys identity by authority, tenant and user, not display name", () => {
    const auth = new TestAuthentication();
    const before = runtimeAccountScope("data", auth);
    auth.account = { ...userA, userName: "renamed" };
    expect(runtimeAccountScope("data", auth)).toEqual(before);
    auth.account = userB;
    expect(runtimeAccountScope("data", auth).accountId).not.toBe(before.accountId);
    auth.account = { ...userA, tenantId: 10 };
    expect(runtimeAccountScope("data", auth).accountId).not.toBe(before.accountId);
    const otherAuthority = { authority: "https://other.example.test", status: (): AuthenticationSummary => ({ status: "signed_in", account: userA }) };
    expect(runtimeAccountScope("data", otherAuthority).accountId).not.toBe(before.accountId);
    expect(before.accountId).toMatch(/^account_[a-f0-9]{32}$/u);
  });
  it("separates signed-out data from explicitly unauthenticated legacy data", () => {
    const auth = new TestAuthentication(); auth.account = null;
    expect(runtimeAccountScope("data").dataDir).toBe("data");
    expect(runtimeAccountScope("data", auth).dataDir).toBe(join("data", "accounts", "signed_out"));
    auth.account = { ...userA, id: Number.NaN };
    expect(() => runtimeAccountScope("data", auth)).toThrow(/账号标识/u);
  });
});

describe("account switching (real local stores/API; mocked authentication and model)", () => {
  it("isolates transcripts, memory, permissions, search and workspace history without claiming legacy data", async () => {
    let step = 0;
    let promptForB = "";
    const { root, other, dataDir, authentication } = await fixture({ model: { async complete(request) {
      if (step++ === 0) return { kind: "tool_calls", calls: [{ id: "remember_a", name: "memory_remember", input: { scope: "account", kind: "preference", content: "private-preference-A", keywords: ["preference"] } }] };
      promptForB = request.systemPrompt.dynamicText;
      return { kind: "assistant", content: "fixture answer" };
    } } });
    const legacy = await new JsonSessionCatalog(join(dataDir, "state")).create("legacy untouched");
    const legacyBefore = await readFile(join(dataDir, "state", "sessions.json"), "utf8");
    const a = await bootstrap();
    expect(a.body.sessions).toEqual([]);
    const sessionA = (await app!.inject({ method: "POST", url: "/api/v1/sessions", headers: a.headers, payload: { title: "A-only-session" } })).json<{ session: { id: string } }>().session;
    const scopeA = runtimeAccountScope(dataDir, authentication);
    await app!.inject({ method: "POST", url: `/api/v1/sessions/${sessionA.id}/turns`, headers: a.headers, payload: { message: "Remember my preference" } });
    await expect.poll(async () => (await bootstrap()).body.sessions[0]?.activeTurnId).toBeNull();
    const eventsA = (await app!.inject({ url: `/api/v1/sessions/${sessionA.id}/events`, headers: a.headers })).json<SessionEventsResponse>().events;
    expect(eventsA.length).toBeGreaterThan(0);
    expect(eventsA.every((event) => event.accountId === scopeA.accountId)).toBe(true);
    expect(eventsA.some((event) => event.type === "tool.completed")).toBe(true);
    expect(await readFile(join(scopeA.dataDir!, "memory", "memories.jsonl"), "utf8")).toContain("private-preference-A");
    const transcriptBefore = await readFile(join(scopeA.dataDir!, "transcripts", `${sessionA.id}.jsonl`), "utf8");
    const resourceScopeId = `resource_${createHash("sha256").update(a.body.workspace?.root ?? root).digest("hex").slice(0, 24)}`;
    const permission = await new JsonlProcessPermissionStore(join(scopeA.dataDir!, "process", "permissions.jsonl")).request({
      accountId: scopeA.accountId, resourceScopeId, sessionId: sessionA.id, turnId: "test-turn", operation: "package_script",
      displayCommand: "npm test", fingerprint: "a-test", risk: "workspace_exec", reason: "test fixture",
    });
    const socket = await app!.injectWS(`/api/v1/sessions/${sessionA.id}/events/ws`, { headers: a.headers });
    const closed = new Promise<number>((resolve) => { socket.once("close", resolve); });
    const b = await callback("b");
    expect(await closed).toBe(1008);
    expect(b.body.sessions).toEqual([]);
    expect(b.body.csrfToken).not.toBe(a.body.csrfToken);
    expect(b.headers.cookie).not.toBe(a.headers.cookie);
    expect((await app!.inject({ url: "/api/v1/sessions", headers: a.headers })).statusCode).toBe(409);
    for (const suffix of ["events", "resume", "forks", "turns"]) {
      const response = await app!.inject({ method: suffix === "events" ? "GET" : "POST", url: `/api/v1/sessions/${sessionA.id}/${suffix}`, headers: b.headers,
        ...(suffix === "events" ? {} : { payload: { message: "attempt cross-account access" } }) });
      expect(response.statusCode).toBe(404);
    }
    expect((await app!.inject({ url: "/api/v1/sessions/search?q=A-only", headers: b.headers })).json().hits).toEqual([]);
    expect((await app!.inject({ url: "/api/v1/process/permissions", headers: b.headers })).json()).toEqual([]);
    expect((await app!.inject({ method: "POST", url: `/api/v1/process/permissions/${permission.id}/decision`, headers: b.headers, payload: { approve: true } })).statusCode).toBe(404);
    const sessionB = (await app!.inject({ method: "POST", url: "/api/v1/sessions", headers: b.headers, payload: { title: "B-only-session" } })).json<{ session: { id: string } }>().session;
    await app!.inject({ method: "POST", url: `/api/v1/sessions/${sessionB.id}/turns`, headers: b.headers, payload: { message: "Recall my preference" } });
    await expect.poll(async () => (await bootstrap()).body.sessions[0]?.activeTurnId).toBeNull();
    expect(promptForB).not.toContain("private-preference-A");
    await app!.inject({ method: "POST", url: "/api/v1/workspaces/switch", headers: b.headers, payload: { root: other } });
    const returnedA = await callback("a");
    expect(returnedA.body.sessions.map((session) => session.id)).toEqual([sessionA.id]);
    expect((await app!.inject({ url: "/api/v1/workspaces", headers: returnedA.headers })).json().recent.map((item: { root: string }) => item.root)).not.toContain(other);
    expect(await readFile(join(scopeA.dataDir!, "transcripts", `${sessionA.id}.jsonl`), "utf8")).toBe(transcriptBefore);
    expect(await readFile(join(dataDir, "state", "sessions.json"), "utf8")).toBe(legacyBefore);
    expect(returnedA.body.sessions.map((session) => session.id)).not.toContain(legacy.id);
  });

  it("rejects stale identity reads and rebuilds only through bootstrap", async () => {
    const { authentication } = await fixture();
    const a = await bootstrap();
    await app!.inject({ method: "POST", url: "/api/v1/sessions", headers: a.headers, payload: { title: "private A" } });
    authentication.account = null; // Simulate refresh receiving invalid_grant.
    const stale = await app!.inject({ url: "/api/v1/sessions", headers: a.headers });
    expect(stale.statusCode).toBe(409);
    expect(stale.body).not.toContain("private A");
    const signedOut = await bootstrap();
    expect(signedOut.body.sessions).toEqual([]);
    expect(signedOut.body.authentication.status).toBe("signed_out");
    const session = (await app!.inject({ method: "POST", url: "/api/v1/sessions", headers: signedOut.headers, payload: {} })).json<{ session: { id: string } }>().session;
    expect((await app!.inject({ method: "POST", url: `/api/v1/sessions/${session.id}/turns`, headers: signedOut.headers, payload: { message: "must not run without login" } })).statusCode).toBe(401);
  });

  it("refuses account transitions while a model turn is active, then isolates logout", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    await fixture({ model: { async complete() { await pending; return { kind: "assistant", content: "done" }; } } });
    const a = await bootstrap();
    const session = (await app!.inject({ method: "POST", url: "/api/v1/sessions", headers: a.headers, payload: {} })).json<{ session: { id: string } }>().session;
    await app!.inject({ method: "POST", url: `/api/v1/sessions/${session.id}/turns`, headers: a.headers, payload: { message: "wait in fixture" } });
    try {
      for (const route of ["login", "logout"]) {
        expect((await app!.inject({ method: "POST", url: `/api/v1/auth/${route}`, headers: a.headers, payload: {} })).statusCode).toBe(409);
      }
    } finally { finish(); }
    await expect.poll(async () => (await bootstrap()).body.sessions[0]?.activeTurnId).toBeNull();
    expect((await app!.inject({ method: "POST", url: "/api/v1/auth/logout", headers: a.headers, payload: {} })).statusCode).toBe(200);
    expect((await bootstrap()).body.sessions).toEqual([]);
    expect((await callback("a")).body.sessions[0]?.id).toBe(session.id);
  });
});
