import { describe, expect, it, vi } from "vitest";
import type { ModelRequest } from "@daoyin/harness-agent-core";
import { EvaluationProvider, modelConfig } from "./provider.js";
import { runTrial } from "./runner.js";
import type { EvaluationSpec } from "./contracts.js";
const config = { endpoint: "https://example.invalid/chat/completions", apiKey: "[REDACTED_SECRET]", model: "fixture", judgeModel: "fixture-judge" };
const request = (): ModelRequest => ({ messages: [{ role: "user", content: "hello" }], tools: [], signal: new AbortController().signal, systemPrompt: { stableText: "", dynamicText: "", sections: [] } });
const response = (content: string) => Response.json({ choices: [{ finish_reason: "stop", message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 20 } });

describe("dedicated evaluation model transport; every HTTP call mocked", () => {
  it("waits for budget and authority and never dispatches after denial", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new EvaluationProvider(config, { take: async () => { throw new Error("revoked"); } }, fetcher);
    await expect(client.client().complete(request())).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not retry errors or report unknown usage as zero", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("private provider error", { status: 503 }));
    const client = new EvaluationProvider(config, { take: () => undefined }, fetcher);
    await expect(client.client().complete(request())).rejects.toMatchObject({ code: "EVAL_PROVIDER_HTTP_503" });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(client.usage.inputTokens).toBeNull();
  });
  it("turns invented judge quotes into review rather than passing", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response(JSON.stringify({ checks: [{ passed: true, evidence: "invented quote" }] })));
    const client = new EvaluationProvider(config, { take: () => undefined }, fetcher);
    const checks = await client.judge({ question: "hello", answer: "actual answer", facts: ["required"], reference: "reference" }, new AbortController().signal);
    expect(checks[0]?.passed).toBeNull();
  });
  it("rejects malformed judge results", async () => {
    const client = new EvaluationProvider(config, { take: () => undefined }, async () => response("not JSON"));
    await expect(client.judge({ question: "hello", answer: "answer", facts: ["required"], reference: "reference" }, new AbortController().signal)).rejects.toMatchObject({ code: "EVAL_JUDGE_JSON" });
  });
  it("does not expose acceptance criteria to the agent model", async () => {
    const requests: Record<string, unknown>[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>; requests.push(body);
      return body.model === "fixture-judge" ? response(JSON.stringify({ checks: [{ passed: true, evidence: "回答" }] })) : response("回答");
    });
    const spec: EvaluationSpec = { requestId: "isolated", title: "isolation", mode: "live", repetitions: 1, maxModelCalls: 2, maxTotalCalls: 3, confirmPaid: true,
      cases: [{ id: "case1", input: "说一句话", template: "explore", expectedFacts: ["ONLY_VISIBLE_TO_JUDGE"], approved: true }] };
    const result = await runTrial({ spec, test: spec.cases[0]!, repetition: 1, model: config, fetcher, signal: new AbortController().signal, budget: { take: () => undefined } });
    expect(result.judgeCalls).toBe(1); expect(result.modelCalls).toBe(1);
    expect(JSON.stringify(requests[0])).not.toContain("ONLY_VISIBLE_TO_JUDGE"); expect(JSON.stringify(requests[1])).toContain("ONLY_VISIBLE_TO_JUDGE");
  });
  it("keeps real mode disabled with no dedicated configuration", () => {
    expect(modelConfig({})).toBeUndefined();
    expect(() => modelConfig({ DAOYIN_EVAL_MODEL_ENDPOINT: "file:///tmp/example" })).toThrow();
  });
});
