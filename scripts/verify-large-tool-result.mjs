import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { AgentEngine } from "../packages/agent-core/dist/index.js";
import { DaoyinGatewayModelClient, WindowsDpapiCredentialStore } from "../packages/cloud/dist/index.js";
import { ToolRegistry, createWorkspaceTools } from "../packages/tools/dist/index.js";
import { JsonlSessionStore, Workspace } from "../packages/workspace/dist/index.js";

// Explicitly gated: this verification makes billable real-model requests.
// Credentials stay in memory; only status, lengths and final text are reported.
if (process.env.DAOYIN_HARNESS_RUN_REAL_MODEL !== "1") {
  throw new Error("Set DAOYIN_HARNESS_RUN_REAL_MODEL=1 to authorize real-model verification.");
}
const directory = "evidence/gateway-large-tool-result";
await mkdir(directory, { recursive: true });
const tokens = await new WindowsDpapiCredentialStore(process.env.DAOYIN_HARNESS_DATA_DIR ?? `${process.env.USERPROFILE}/.daoyin-harness`).load();
if (!tokens || tokens.accessExpiresAt <= Date.now()) throw new Error("An unexpired existing Daoyin login is required. Log in using the local UI.");
const http = [];
const client = new DaoyinGatewayModelClient({
  endpoint: new URL("/api/harness/ai/responses", process.env.DAOYIN_PLATFORM_URL ?? "https://www.daoyintech.com").href,
  credentialProvider: { async getCredential() { return tokens.accessToken; } },
  fetch: async (url, init) => {
    const request = JSON.parse(String(init?.body));
    const response = await fetch(url, init);
    http.push({ status: response.status, messages: request.messages.map(message => ({ role: message.role, characters: message.content.length })) });
    return response;
  },
});
const workspace = await Workspace.open(process.cwd());
// Only read-only directory enumeration is available to the verification model.
const tools = new ToolRegistry(createWorkspaceTools(workspace).filter(tool => tool.name === "list_files"));
const store = new JsonlSessionStore(`${directory}/transcripts`);
const sessionId = `large_result_${Date.now()}`;
const engine = new AgentEngine({ model: client, tools, events: store, maxSteps: 3, maxToolCalls: 2 });
const result = await engine.runTurn({
  accountId: "local_verification", scopeId: "large_result_verification", sessionId, turnId: "verify_list_then_answer",
  userMessage: "浏览本地文件。请先调用 list_files 查看工作区文件，再用三句话概括返回的目录内容。如果工具结果带有省略标记，明确说明只是部分预览。不要再次请求相同列表，不读取文件内容。",
});
const events = await store.read(sessionId);
const listed = events.find(event => event.type === "tool.completed" && event.payload.toolName === "list_files");
const originalCharacters = listed ? JSON.stringify({ ok: true, summary: listed.payload.summary, result: listed.payload.evidence.result }).length : 0;
const report = {
  verifiedAt: new Date().toISOString(), evidence: "Real Daoyin Gateway model calls and real read-only local list_files; isolated append-only verification transcript",
  sessionId, status: result.status, http, originalToolResultCharacters: originalCharacters,
  finalText: result.finalText,
};
await writeFile(`${directory}/real-model-verification.json`, JSON.stringify(report, null, 2) + "\n");
assert.ok(listed, "The real model did not execute list_files");
assert.ok(originalCharacters > 100_000, "The workspace fixture did not reproduce an oversized result");
assert.ok(http.length >= 2 && http.some(request => request.messages.some(message => message.role === "tool")), "Missing real model request after tool execution");
assert.ok(http.every(request => request.status === 200));
assert.ok(http.flatMap(request => request.messages).filter(message => message.role === "tool").every(message => message.characters <= 24_000));
assert.equal(result.status, "completed");
console.log(JSON.stringify(report));
