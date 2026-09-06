import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { JsonSessionCatalog } from "@daoyin/harness-workspace";
import { JsonlProcessPermissionStore } from "@daoyin/harness-process";
import type { RuntimeBootstrap } from "@daoyin/harness-protocol";
import { createApp, type CreateAppOptions } from "./app.js";

let app: FastifyInstance;
let directory: string;
const host = { host: "127.0.0.1:4677" };
async function fixture(extra: Partial<CreateAppOptions> = {}) {
  directory = await mkdtemp(join(tmpdir(), "daoyin-workspace-switch-"));
  const a = join(directory, "project-a");
  const b = join(directory, "项目 B");
  const dataDir = join(directory, "data");
  await mkdir(a); await mkdir(b);
  await writeFile(join(a, "a.txt"), "only A");
  await writeFile(join(b, "b.txt"), "only B");
  const options: CreateAppOptions = { port: 4677, version: "test", startedAt: new Date().toISOString(), dataDir, workspaceRoot: a, ...extra };
  app = await createApp(options);
  return { a, b, dataDir, options };
}
async function bootstrap() {
  const response = await app.inject({ url: "/api/v1/bootstrap", headers: host });
  const body = response.json<RuntimeBootstrap>();
  const cookies = response.headers["set-cookie"];
  return { body, headers: { ...host, cookie: (Array.isArray(cookies) ? cookies[0] : cookies) ?? "", "x-daoyin-csrf": body.csrfToken, "x-daoyin-workspace": body.workspaceRevision ?? "" } };
}
afterEach(async () => {
  await app?.close();
  if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
});

describe("workspace switching (local API, model mocked)", () => {
  it("rebinds actual file tools and prompt context, isolates permissions, and closes the old event stream", async () => {
    let step = 0;
    let systemPrompt = "";
    const { a, b, dataDir } = await fixture({ model: { async complete(request) {
      systemPrompt = request.systemPrompt.dynamicText;
      return step++ === 0 ? { kind: "tool_calls", calls: [{ id: "write_b", name: "write_file", input: { path: "created.txt", content: "B workspace" } }] } : { kind: "assistant", content: "done" };
    } } });
    const first = await bootstrap();
    const original = (await app.inject({ method: "POST", url: "/api/v1/sessions", headers: first.headers, payload: {} })).json();
    const permission = await new JsonlProcessPermissionStore(join(dataDir, "process", "permissions.jsonl")).request({
      accountId: "local", resourceScopeId: `resource_${createHash("sha256").update(a).digest("hex").slice(0, 24)}`,
      sessionId: original.session.id, turnId: "turn_a", operation: "package_script", displayCommand: "npm test", fingerprint: "test-a", risk: "workspace_exec", reason: "test permission",
    });
    const socket = await app.injectWS(`/api/v1/sessions/${original.session.id}/events/ws`, { headers: first.headers });
    const closed = new Promise<number>((resolve) => { socket.once("close", resolve); });
    await app.inject({ method: "POST", url: "/api/v1/workspaces/switch", headers: first.headers, payload: { root: b } });
    expect(await closed).toBe(1008);
    const second = await bootstrap();
    expect((await app.inject({ url: `/api/v1/process/permissions?sessionId=${original.session.id}`, headers: second.headers })).json()).toEqual([]);
    expect((await app.inject({ method: "POST", url: `/api/v1/process/permissions/${permission.id}/decision`, headers: second.headers, payload: { approve: true } })).statusCode).toBe(403);
    const session = (await app.inject({ method: "POST", url: "/api/v1/sessions", headers: second.headers, payload: {} })).json().session;
    await app.inject({ method: "POST", url: `/api/v1/sessions/${session.id}/turns`, headers: second.headers, payload: { message: "write in this workspace" } });
    await expect.poll(async () => (await bootstrap()).body.sessions[0]?.activeTurnId).toBeNull();
    expect(await readFile(join(b, "created.txt"), "utf8")).toBe("B workspace");
    await expect(readFile(join(a, "created.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(systemPrompt).toContain(`Selected workspace root: ${b}`);
  });

  it("retains the current runtime if committing workspace history fails", async () => {
    const { a, b, dataDir } = await fixture();
    const first = await bootstrap();
    const historyPath = join(dataDir, "workspaces.json");
    await rename(historyPath, `${historyPath}.backup`);
    await mkdir(historyPath);
    const result = await app.inject({ method: "POST", url: "/api/v1/workspaces/switch", headers: first.headers, payload: { root: b } });
    expect(result.statusCode).toBe(500);
    expect((await bootstrap()).body.workspace?.root).toBe(a);
    expect((await app.inject({ url: "/api/v1/workspace/files", headers: first.headers })).json().files).toEqual(["a.txt"]);
  });

  it("uses the startup fallback when the most recent folder is gone", async () => {
    const { a, b, options } = await fixture();
    const first = await bootstrap();
    await app.inject({ method: "POST", url: "/api/v1/workspaces/switch", headers: first.headers, payload: { root: b } });
    await app.close();
    await rename(b, `${b}-renamed`);
    app = await createApp({ ...options, restoreLastWorkspace: true });
    expect((await bootstrap()).body.workspace?.root).toBe(a);
    expect((await app.inject({ url: "/api/v1/workspaces", headers: host })).json().recent.map((item: { root: string }) => item.root)).toContain(b);
  });
  it("isolates catalogs, files, session routes and search; restores both recent history and legacy sessions", async () => {
    const { a, b, dataDir, options } = await fixture();
    const legacy = await new JsonSessionCatalog(join(dataDir, "state")).create("original task");
    const originalCatalog = await readFile(join(dataDir, "state", "sessions.json"), "utf8");
    const first = await bootstrap();
    expect(first.body.sessions.map((s) => s.id)).toContain(legacy.id);
    expect((await app.inject({ method: "POST", url: "/api/v1/workspaces/switch", headers: first.headers, payload: { root: b } })).statusCode).toBe(200);
    const second = await bootstrap();
    expect(second.body.workspace?.root).toBe(b);
    expect(second.body.sessions).toEqual([]);
    expect(second.body.csrfToken).not.toBe(first.body.csrfToken);
    expect((await app.inject({ url: "/api/v1/workspace/files", headers: second.headers })).json().files).toEqual(["b.txt"]);
    for (const suffix of ["events", "resume", "forks", "turns"]) {
      const response = await app.inject({ method: suffix === "events" ? "GET" : "POST", url: `/api/v1/sessions/${legacy.id}/${suffix}`, headers: second.headers, ...(suffix === "events" ? {} : { payload: { message: "hello" } }) });
      expect(response.statusCode).toBe(404);
    }
    expect((await app.inject({ url: "/api/v1/sessions/search?q=original", headers: second.headers })).json().hits).toEqual([]);
    const created = await app.inject({ method: "POST", url: "/api/v1/sessions", headers: second.headers, payload: { title: "B task" } });
    expect(created.statusCode).toBe(201);
    expect(await readFile(join(dataDir, "state", "sessions.json"), "utf8")).toBe(originalCatalog);
    await app.close();
    app = await createApp({ ...options, restoreLastWorkspace: true });
    const restored = await bootstrap();
    expect(restored.body.workspace?.root).toBe(b);
    expect(restored.body.sessions.map((s) => s.title)).toEqual(["B task"]);
    expect((await app.inject({ url: "/api/v1/workspaces", headers: restored.headers })).json().recent.map((w: { root: string }) => w.root)).toEqual([b, a]);
    await app.inject({ method: "POST", url: "/api/v1/workspaces/switch", headers: restored.headers, payload: { root: a } });
    expect((await bootstrap()).body.sessions.map((s) => s.id)).toEqual([legacy.id]);
  });

  it("rejects missing paths and unsafe roots without changing the current workspace or history", async () => {
    const { a, dataDir } = await fixture();
    const first = await bootstrap();
    const before = await readFile(join(dataDir, "workspaces.json"), "utf8");
    for (const root of ["", "../outside", "C:relative", "\\\\server\\share", "\\\\?\\C:\\", "C:\\folder:secret", "C:\\NUL", join(directory, "missing"), join(a, "a.txt")]) {
      const response = await app.inject({ method: "POST", url: "/api/v1/workspaces/switch", headers: first.headers, payload: { root } });
      expect(response.statusCode, root).toBe(400);
    }
    expect((await bootstrap()).body.workspace?.root).toBe(a);
    expect(await readFile(join(dataDir, "workspaces.json"), "utf8")).toBe(before);
  });

  it("protects selection with CSRF and rejects stale page reads and writes after a switch", async () => {
    const { b } = await fixture({ pickWorkspaceDirectory: async () => null });
    const old = await bootstrap();
    for (const endpoint of ["pick", "switch"]) {
      expect((await app.inject({ method: "POST", url: `/api/v1/workspaces/${endpoint}`, headers: host, payload: { root: b } })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: `/api/v1/workspaces/${endpoint}`, headers: { ...old.headers, origin: "https://evil.example" }, payload: { root: b } })).statusCode).toBe(403);
    }
    await app.inject({ method: "POST", url: "/api/v1/workspaces/switch", headers: old.headers, payload: { root: b } });
    expect((await app.inject({ url: "/api/v1/workspace/files", headers: old.headers })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/api/v1/sessions", headers: old.headers, payload: {} })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/api/v1/sessions", headers: { ...host, cookie: old.headers.cookie, "x-daoyin-csrf": old.body.csrfToken }, payload: {} })).statusCode).toBe(403);
  });

  it("returns a picked folder without switching, and handles cancellation", async () => {
    let selected: string | null = null;
    const { a, b } = await fixture({ pickWorkspaceDirectory: async () => selected });
    const { headers } = await bootstrap();
    expect((await app.inject({ method: "POST", url: "/api/v1/workspaces/pick", headers, payload: {} })).json()).toEqual({ root: null });
    selected = b;
    expect((await app.inject({ method: "POST", url: "/api/v1/workspaces/pick", headers, payload: {} })).json()).toEqual({ root: b });
    expect((await bootstrap()).body.workspace?.root).toBe(a);
  });

  it("blocks switching during an active model turn, then allows it after completion", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const { a, b } = await fixture({ model: { async complete() { await gate; return { kind: "assistant", content: "done" }; } } });
    const { headers } = await bootstrap();
    const created = (await app.inject({ method: "POST", url: "/api/v1/sessions", headers, payload: {} })).json();
    await app.inject({ method: "POST", url: `/api/v1/sessions/${created.session.id}/turns`, headers, payload: { message: "wait" } });
    try {
      const result = await app.inject({ method: "POST", url: "/api/v1/workspaces/switch", headers, payload: { root: b } });
      expect(result.statusCode).toBe(409);
      expect(result.json().error.code).toBe("WORKSPACE_BUSY");
      expect((await bootstrap()).body.workspace?.root).toBe(a);
    } finally { finish(); }
    await expect.poll(async () => (await bootstrap()).body.sessions[0]?.activeTurnId).toBeNull();
    expect((await app.inject({ method: "POST", url: "/api/v1/workspaces/switch", headers, payload: { root: b } })).statusCode).toBe(200);
  });

  it("serializes folder selection and refuses switching while another request is pending", async () => {
    let finish!: (value: null) => void;
    const gate = new Promise<null>((resolve) => { finish = resolve; });
    const { b } = await fixture({ pickWorkspaceDirectory: () => gate });
    const { headers } = await bootstrap();
    const pending = app.inject({ method: "POST", url: "/api/v1/workspaces/pick", headers, payload: {} }).then((response) => response);
    try {
      await expect.poll(async () => (await app.inject({ method: "POST", url: "/api/v1/workspaces/switch", headers, payload: { root: b } })).statusCode).toBe(409);
      expect((await app.inject({ method: "POST", url: "/api/v1/workspaces/pick", headers, payload: {} })).statusCode).toBe(409);
    } finally { finish(null); await pending; }
  });
});
