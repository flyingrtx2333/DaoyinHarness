import { describe, expect, it } from "vitest";
import { ToolRegistry } from "./registry.js";
import { createWebTools } from "./web-tools.js";

function registry(): ToolRegistry {
  return new ToolRegistry(createWebTools({ timeoutMs: 1_000, maxResponseBytes: 20_000 }));
}

describe("web tools", () => {
  it("publishes web capabilities as non-mutating tools", () => {
    expect(registry().capabilities()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "web_search", category: "web", mutating: false }),
      expect.objectContaining({ name: "web_fetch", category: "web", mutating: false }),
    ]));
  });

  it("rejects localhost before making an HTTP request", async () => {
    const result = await registry().execute(
      { id: "call_localhost", name: "web_fetch", input: { url: "http://127.0.0.1/private" } },
      new AbortController().signal,
      { accountId: "test-account", scopeId: "test-scope", sessionId: "test-session", turnId: "test-turn", sourceEventIds: [] },
    );
    expect(result).toMatchObject({ ok: false, code: "WEB_URL_DENIED", retryable: false });
  });

  it("rejects URLs with credentials and non-standard ports", async () => {
    const tools = registry();
    const credentialResult = await tools.execute(
      { id: "call_credentials", name: "web_fetch", input: { url: "https://user:secret@example.com/" } },
      new AbortController().signal,
      { accountId: "test-account", scopeId: "test-scope", sessionId: "test-session", turnId: "test-turn", sourceEventIds: [] },
    );
    const portResult = await tools.execute(
      { id: "call_port", name: "web_fetch", input: { url: "https://example.com:8443/" } },
      new AbortController().signal,
      { accountId: "test-account", scopeId: "test-scope", sessionId: "test-session", turnId: "test-turn", sourceEventIds: [] },
    );
    expect(credentialResult).toMatchObject({ ok: false, code: "WEB_URL_DENIED" });
    expect(portResult).toMatchObject({ ok: false, code: "WEB_URL_DENIED" });
  });
});
