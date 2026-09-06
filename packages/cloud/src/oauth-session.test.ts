import { describe, expect, it, vi } from "vitest";
import { DaoyinOAuthSession, InMemoryOAuthCredentialStore } from "./oauth-session.js";

function tokenPayload(access: string, refresh: string, expiresIn = 3600): Record<string, unknown> {
  return {
    token_type: "Bearer",
    access_token: access,
    refresh_token: refresh,
    expires_in: expiresIn,
    scope: "harness:ai",
    user: { id: 17, user_name: "tester", tenant_id: 9 },
  };
}

describe("DaoyinOAuthSession", () => {
  it("creates an S256 authorization request and exchanges the callback without exposing tokens", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(init?.body)).toContain("grant_type=authorization_code");
      expect(String(init?.body)).toContain("code_verifier=");
      return new Response(JSON.stringify(tokenPayload("access-1", "refresh-1")), { status: 200 });
    }) as unknown as typeof fetch;
    const session = new DaoyinOAuthSession({
      platformUrl: "https://www.daoyintech.com",
      port: 4677,
      credentialStore: new InMemoryOAuthCredentialStore(),
      fetch: fetchMock,
    });
    await session.initialize();

    const started = session.beginAuthorization();
    const url = new URL(started.authorizationUrl);
    expect(url.origin).toBe("https://www.daoyintech.com");
    expect(url.pathname).toBe("/api/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:4677/api/v1/auth/callback");
    expect(session.status().status).toBe("authorizing");

    await expect(session.completeAuthorization("code-1", url.searchParams.get("state") ?? "")).resolves.toEqual({
      id: 17,
      userName: "tester",
      tenantId: 9,
    });
    expect(session.status()).toEqual({ status: "signed_in", account: { id: 17, userName: "tester", tenantId: 9 } });
    await expect(session.getCredential(new AbortController().signal)).resolves.toBe("access-1");
  });

  it("rotates an expired access token once for concurrent callers", async () => {
    let now = 1_000_000;
    const store = new InMemoryOAuthCredentialStore();
    await store.save({
      accessToken: "expired", refreshToken: "refresh-old", accessExpiresAt: now - 1,
      account: { id: 17, userName: "tester", tenantId: 9 },
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(tokenPayload("access-new", "refresh-new")), { status: 200 })) as unknown as typeof fetch;
    const session = new DaoyinOAuthSession({
      platformUrl: "https://www.daoyintech.com", port: 4677, credentialStore: store,
      fetch: fetchMock, now: () => now,
    });
    await session.initialize();
    const signal = new AbortController().signal;
    await expect(Promise.all([session.getCredential(signal), session.getCredential(signal)])).resolves.toEqual(["access-new", "access-new"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now += 100;
  });

  it("rejects non-HTTPS remote platform origins", () => {
    expect(() => new DaoyinOAuthSession({
      platformUrl: "http://www.daoyintech.com", port: 4677,
      credentialStore: new InMemoryOAuthCredentialStore(),
    })).toThrowError(/HTTPS/u);
  });
});
