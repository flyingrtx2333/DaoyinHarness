import { describe, expect, it, vi } from "vitest";
import { DaoyinOAuthSession, InMemoryOAuthCredentialStore } from "./oauth-session.js";

const account = { id: 17, userName: "tester", tenantId: 9 };
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { token_type: "Bearer", access_token: "access-new", refresh_token: "refresh-new", expires_in: 3600,
    user: { id: account.id, user_name: account.userName, tenant_id: account.tenantId }, ...overrides };
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function expired(fetchImpl: typeof fetch) {
  const store = new InMemoryOAuthCredentialStore();
  await store.save({ accessToken: "expired", refreshToken: "refresh-old", accessExpiresAt: 1, account });
  const session = new DaoyinOAuthSession({ platformUrl: "https://www.daoyintech.com", port: 4677,
    credentialStore: store, fetch: fetchImpl, now: () => 1_000_000 });
  await session.initialize();
  return { session, store };
}

describe("OAuth reliability (mock transport; no real credentials)", () => {
  it.each([408, 429, 500, 502, 503])("preserves the credential for HTTP %s, including HTML errors", async (status) => {
    const { session, store } = await expired(async () => new Response("<h1>upstream unavailable</h1>", { status }));
    await expect(session.getCredential(new AbortController().signal)).rejects.toMatchObject({ status, retryable: true });
    expect(session.status().status).toBe("signed_in");
    expect((await store.load())?.refreshToken).toBe("refresh-old");
  });

  it("preserves login on network failure without echoing transport secrets", async () => {
    const { session, store } = await expired(async () => { throw new Error("secret-token-in-transport-error"); });
    const result = session.getCredential(new AbortController().signal);
    await expect(result).rejects.toMatchObject({ code: "MODEL_AUTH_NETWORK", retryable: true });
    await expect(result).rejects.not.toThrow("secret-token");
    expect((await store.load())?.refreshToken).toBe("refresh-old");
  });

  it.each([400, 401, 403])("clears a confirmed invalid_grant on HTTP %s", async (status) => {
    const { session, store } = await expired(async () => Response.json({ error: "invalid_grant" }, { status }));
    await expect(session.getCredential(new AbortController().signal)).rejects.toMatchObject({ code: "MODEL_AUTH_REQUIRED" });
    expect(session.status()).toEqual({ status: "signed_out", account: null });
    expect(await store.load()).toBeNull();
  });

  it("does not mistake invalid_client for invalid_grant", async () => {
    const { session, store } = await expired(async () => Response.json({ error: "invalid_client" }, { status: 401 }));
    await expect(session.getCredential(new AbortController().signal)).rejects.toMatchObject({ code: "MODEL_AUTH_REJECTED" });
    expect((await store.load())?.refreshToken).toBe("refresh-old");
  });

  it.each([{ name: "invalid JSON", text: "not-json" }, { name: "oversized", text: "x".repeat(65_537) }])("rejects $name responses without deleting login", async ({ text }) => {
    const { session, store } = await expired(async () => new Response(text));
    await expect(session.getCredential(new AbortController().signal)).rejects.toMatchObject({ code: "MODEL_AUTH_RESPONSE_INVALID" });
    expect((await store.load())?.refreshToken).toBe("refresh-old");
  });

  it("rejects another tenant's identity returned by refresh", async () => {
    const { session, store } = await expired(async () => Response.json(payload({ user: { id: 17, user_name: "other", tenant_id: 10 } })));
    await expect(session.getCredential(new AbortController().signal)).rejects.toMatchObject({ code: "MODEL_AUTH_IDENTITY_MISMATCH" });
    expect((await store.load())?.account).toEqual(account);
  });

  it("does not extend a short token lifetime and forbids credential redirects", async () => {
    const { session, store } = await expired(async (_input, init) => {
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json(payload({ expires_in: 5 }));
    });
    await session.getCredential(new AbortController().signal);
    expect((await store.load())?.accessExpiresAt).toBe(1_005_000);
  });

  it("one caller cancellation does not cancel a shared refresh", async () => {
    const pending = deferred<Response>();
    const transport = vi.fn<typeof fetch>(() => pending.promise);
    const { session, store } = await expired(transport);
    const controller = new AbortController();
    const cancelled = session.getCredential(controller.signal);
    const other = session.getCredential(new AbortController().signal);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    pending.resolve(Response.json(payload()));
    await expect(other).resolves.toBe("access-new");
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await store.load())?.refreshToken).toBe("refresh-new");
  });

  it("a late refresh response cannot resurrect logout", async () => {
    const pending = deferred<Response>();
    const { session, store } = await expired(async (url) => String(url).endsWith("/revoke") ? new Response(null, { status: 204 }) : pending.promise);
    const rejected = expect(session.getCredential(new AbortController().signal)).rejects.toMatchObject({ code: "MODEL_AUTH_CHANGED" });
    await session.logout();
    pending.resolve(Response.json(payload()));
    await rejected;
    expect(session.status().status).toBe("signed_out");
    expect(await store.load()).toBeNull();
  });

  it("serializes logout after a credential save already in progress", async () => {
    const { session, store } = await expired(async () => Response.json(payload()));
    const entered = deferred<void>();
    const release = deferred<void>();
    const originalSave = store.save.bind(store);
    vi.spyOn(store, "save").mockImplementation(async (tokens) => {
      entered.resolve(); await release.promise; await originalSave(tokens);
    });
    const rejected = expect(session.getCredential(new AbortController().signal)).rejects.toMatchObject({ code: "MODEL_AUTH_CHANGED" });
    await entered.promise;
    const logout = session.logout();
    release.resolve();
    await Promise.all([rejected, logout]);
    expect(await store.load()).toBeNull();
    expect(session.status().status).toBe("signed_out");
  });

  it("expires pending authorizations and returns copies of account identity", async () => {
    let now = 0;
    const session = new DaoyinOAuthSession({ platformUrl: "https://www.daoyintech.com", port: 4677,
      credentialStore: new InMemoryOAuthCredentialStore(), now: () => now, fetch: async () => Response.json(payload()) });
    const first = new URL(session.beginAuthorization().authorizationUrl);
    now = 300_001;
    expect(session.status().status).toBe("signed_out");
    await expect(session.completeAuthorization("code", first.searchParams.get("state") ?? "")).rejects.toThrow(/过期/u);
    const second = new URL(session.beginAuthorization().authorizationUrl);
    const returned = await session.completeAuthorization("code", second.searchParams.get("state") ?? "");
    returned.id = 999;
    expect(session.status().account?.id).toBe(17);
    await expect(session.completeAuthorization("code", second.searchParams.get("state") ?? "")).rejects.toThrow(/过期/u);
  });
});
