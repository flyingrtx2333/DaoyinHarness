import { describe, expect, it, vi } from "vitest";
import type { ModelRequest } from "@daoyin/harness-agent-core";
import {
  DaoyinGatewayModelClient,
  InMemoryCloudCredentialProvider,
  createDevelopmentGatewayModelFromEnvironment,
} from "./gateway-model-client.js";

function request(): ModelRequest {
  return {
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "hello" },
    ],
    tools: [],
    systemPrompt: {
      stableText: "stable",
      dynamicText: "dynamic",
      sections: [
        { id: "identity", kind: "stable" },
        { id: "runtime", kind: "dynamic" },
      ],
    },
    signal: new AbortController().signal,
  };
}

describe("DaoyinGatewayModelClient", () => {
  it("sends the normalized harness request and parses assistant output", async () => {
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer credential_for_test");
      expect(headers.get("x-daoyin-harness-version")).toBe("0.1.0");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        schemaVersion: 1,
        model: "auto",
        systemPrompt: { stableText: "stable", dynamicText: "dynamic" },
      });
      return new Response(JSON.stringify({
        schemaVersion: 1,
        requestId: "request_test",
        output: { kind: "assistant", content: "done" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const client = new DaoyinGatewayModelClient({
      endpoint: "https://gateway.example.test/api/ai/harness/responses",
      credentialProvider: new InMemoryCloudCredentialProvider("credential_for_test"),
      model: "auto",
      clientVersion: "0.1.0",
      fetch: fetchMock,
    });

    await expect(client.complete(request())).resolves.toEqual({ kind: "assistant", content: "done" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("parses normalized tool calls", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      schemaVersion: 1,
      output: {
        kind: "tool_calls",
        content: "checking",
        calls: [{ id: "call_1", name: "read_file", input: { path: "README.md" } }],
      },
    }), { status: 200 })) as unknown as typeof fetch;
    const client = new DaoyinGatewayModelClient({
      endpoint: "https://gateway.example.test/api/ai/harness/responses",
      credentialProvider: new InMemoryCloudCredentialProvider("credential_for_test"),
      fetch: fetchMock,
    });

    await expect(client.complete(request())).resolves.toEqual({
      kind: "tool_calls",
      content: "checking",
      calls: [{ id: "call_1", name: "read_file", input: { path: "README.md" } }],
    });
  });

  it("maps gateway authorization and rate-limit failures without exposing response bodies", async () => {
    const unauthorized = vi.fn(async () => new Response(JSON.stringify({
      request_id: "request_auth",
      error: { code: "invalid_session", message: "login again" },
    }), { status: 401 })) as unknown as typeof fetch;
    const client = new DaoyinGatewayModelClient({
      endpoint: "https://gateway.example.test/api/ai/harness/responses",
      credentialProvider: new InMemoryCloudCredentialProvider("credential_for_test"),
      fetch: unauthorized,
    });

    await expect(client.complete(request())).rejects.toMatchObject({
      code: "MODEL_AUTH_REQUIRED",
      retryable: false,
      status: 401,
      requestId: "request_auth",
    });
  });

  it("rejects non-HTTPS remote endpoints", () => {
    expect(() => new DaoyinGatewayModelClient({
      endpoint: "http://gateway.example.test/api/ai/harness/responses",
      credentialProvider: new InMemoryCloudCredentialProvider("credential_for_test"),
    })).toThrowError(/HTTPS/u);
  });

  it("keeps the development bridge disabled unless explicitly configured", () => {
    expect(createDevelopmentGatewayModelFromEnvironment({})).toBeNull();
    expect(() => createDevelopmentGatewayModelFromEnvironment({ DAOYIN_HARNESS_MODEL: "auto" })).toThrowError(/同时设置/u);
  });
});
