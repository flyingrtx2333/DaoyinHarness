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
  it("rejects oversized messages before credential lookup or HTTP without changing the input", async () => {
    const getCredential = vi.fn(async () => "credential_for_test");
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const client = new DaoyinGatewayModelClient({ endpoint: "https://gateway.example.test/responses", credentialProvider: { getCredential }, fetch: fetchMock });
    const payload = request();
    const content = "x".repeat(100_001);
    payload.messages = [{ role: "tool", toolCallId: "call_1", toolName: "read_file", content }];
    await expect(client.complete(payload)).rejects.toMatchObject({ code: "MODEL_CONTEXT_TOO_LARGE", retryable: false });
    expect(getCredential).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(payload.messages[0]?.content).toBe(content);
  });

  it("accepts a message exactly at the gateway limit", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ schemaVersion: 1, output: { kind: "assistant", content: "done" } }))) as unknown as typeof fetch;
    const client = new DaoyinGatewayModelClient({ endpoint: "https://gateway.example.test/responses", credentialProvider: new InMemoryCloudCredentialProvider("credential_for_test"), fetch: fetchMock });
    const payload = request();
    payload.messages = [{ role: "user", content: "x".repeat(100_000) }];
    await expect(client.complete(payload)).resolves.toEqual({ kind: "assistant", content: "done" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { type: "string_too_long", loc: ["body", "messages", 2, "content"], code: "MODEL_CONTEXT_TOO_LARGE", message: "超过网关长度限制" },
    { type: "missing", loc: ["body", "messages"], code: "MODEL_GATEWAY_VALIDATION", message: "格式校验失败" },
    { type: "string_too_long", loc: ["body", "other"], code: "MODEL_GATEWAY_VALIDATION", message: "格式校验失败" },
  ])("explains 422 $type safely without exposing echoed input", async ({ type, loc, code, message }) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ detail: [{ type, loc, msg: "private server text", input: "Bearer secret_document_payload" }], error: { message: "secret_document_payload" } }), { status: 422, headers: { "x-request-id": "req_validation" } })) as unknown as typeof fetch;
    const client = new DaoyinGatewayModelClient({ endpoint: "https://gateway.example.test/responses", credentialProvider: new InMemoryCloudCredentialProvider("credential_for_test"), fetch: fetchMock });
    await expect(client.complete(request())).rejects.toMatchObject({ code, status: 422, requestId: "req_validation", message: expect.stringContaining(message) });
    await expect(client.complete(request())).rejects.not.toThrow(/secret_document_payload|private server text/);
  });

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
