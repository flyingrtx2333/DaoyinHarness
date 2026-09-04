import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../packages/server/dist/index.js";

const dataDir = await mkdtemp(join(tmpdir(), "daoyin-harness-smoke-data-"));
const workspaceRoot = await mkdtemp(join(tmpdir(), "daoyin-harness-smoke-workspace-"));
let app;
let modelStep = 0;
const modelRequests = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForTerminal(sessionId, afterEventSeq = 0) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const replayResponse = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/events?after=${String(afterEventSeq)}`,
      headers: { host: "127.0.0.1:4677" },
    });
    assert(replayResponse.statusCode === 200, `event replay failed: ${replayResponse.body}`);
    const events = replayResponse.json().events;
    if (events.some((event) => ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type))) return events;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("turn did not reach a terminal event during smoke test");
}

async function startTurn(sessionId, cookie, csrfToken, message, planning = false) {
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/sessions/${sessionId}/turns`,
    headers: {
      host: "127.0.0.1:4677",
      cookie,
      "x-daoyin-csrf": csrfToken,
      "content-type": "application/json",
    },
    payload: { message, planning },
  });
  assert(response.statusCode === 202, `turn start failed: ${response.body}`);
}

try {
  await mkdir(join(workspaceRoot, ".daoyin", "skills", "smoke"), { recursive: true });
  await writeFile(join(workspaceRoot, ".daoyin", "skills", "smoke", "SKILL.md"), "# Smoke Skill\nUse concise evidence-backed results.\n", "utf8");
  await writeFile(join(workspaceRoot, "package.json"), JSON.stringify({
    name: "runtime-smoke-workspace",
    private: true,
    scripts: { test: "node -e \"process.stdout.write('runtime-process-ok')\"" },
  }), "utf8");

  app = await createApp({
    port: 4677,
    version: "0.1.0-smoke",
    startedAt: new Date().toISOString(),
    dataDir,
    workspaceRoot,
    compactionRetainRecentTurns: 1,
    compactionTriggerUncompactedTurns: 2,
    compactionTriggerCharacters: 2_000,
    compactionMaxSummaryCharacters: 5_000,
    model: {
      async complete(request) {
        modelRequests.push(request);
        modelStep += 1;
        if (modelStep === 1) {
          return { kind: "tool_calls", calls: [{ id: "call_list_skills", name: "list_skills", input: {} }] };
        }
        if (modelStep === 2) {
          return { kind: "tool_calls", calls: [{ id: "call_load_skill", name: "load_skill", input: { name: "smoke" } }] };
        }
        if (modelStep === 3) {
          return { kind: "tool_calls", calls: [{ id: "call_private_web", name: "web_fetch", input: { url: "http://127.0.0.1/private" } }] };
        }
        if (modelStep === 4) {
          return {
            kind: "tool_calls",
            calls: [{ id: "call_smoke_write", name: "write_file", input: { path: "smoke.txt", content: "runtime-smoke-ok\n" } }],
          };
        }
        if (modelStep === 5) {
          return {
            kind: "tool_calls",
            calls: [{
              id: "call_memory_remember",
              name: "memory_remember",
              input: {
                scope: "account",
                kind: "preference",
                content: "User prefers concise evidence-backed responses.",
                keywords: ["concise", "evidence"],
              },
            }],
          };
        }
        if (modelStep === 6) return { kind: "assistant", content: "smoke complete" };
        if (modelStep === 7) return { kind: "assistant", content: "I remember your concise evidence-backed response preference and that the prior turn created smoke.txt." };
        if (modelStep === 8) return { kind: "assistant", content: "Third turn completed with compacted prior context." };
        if (modelStep === 9) return { kind: "tool_calls", calls: [{ id: "call_process_inspect", name: "process_inspect", input: { operation: "node_version" } }] };
        if (modelStep === 10) return { kind: "assistant", content: "Runtime inspection complete." };
        if (modelStep === 11) return { kind: "tool_calls", calls: [{ id: "call_process_approval", name: "run_package_script", input: { script: "test" } }] };
        if (modelStep === 12) return { kind: "assistant", content: "The test script needs your one-shot approval before it can run." };
        if (modelStep === 13) return { kind: "tool_calls", calls: [{ id: "call_process_approved", name: "run_package_script", input: { script: "test" } }] };
        return { kind: "assistant", content: "The approved test script completed." };
      },
    },
  });

  const bootstrapResponse = await app.inject({
    method: "GET",
    url: "/api/v1/bootstrap",
    headers: { host: "127.0.0.1:4677" },
  });
  assert(bootstrapResponse.statusCode === 200, "bootstrap failed");
  const bootstrap = bootstrapResponse.json();
  const rawCookie = bootstrapResponse.headers["set-cookie"];
  const cookie = Array.isArray(rawCookie) ? rawCookie[0] : rawCookie;
  assert(typeof cookie === "string" && cookie.includes("HttpOnly"), "bootstrap did not issue a secure local session cookie");
  assert(bootstrap.sandbox?.mode === "auto", "bootstrap did not expose sandbox mode");
  assert(typeof bootstrap.sandbox?.available === "boolean", "bootstrap did not expose sandbox availability");
  assert(bootstrap.health.capabilities.sandbox === (bootstrap.sandbox.available ? "ready" : "unavailable"), "sandbox health readiness disagrees with bootstrap status");
  const capabilityNames = new Set(bootstrap.tools.map((tool) => tool.name));
  for (const required of [
    "read_file", "write_file", "process_inspect", "run_package_script", "web_search", "web_fetch", "list_skills", "load_skill",
    "memory_search", "memory_remember", "memory_update", "memory_forget",
  ]) {
    assert(capabilityNames.has(required), `bootstrap is missing capability ${required}`);
  }

  const rejectedMutation = await app.inject({
    method: "POST",
    url: "/api/v1/sessions",
    headers: { host: "127.0.0.1:4677", "content-type": "application/json" },
    payload: {},
  });
  assert(rejectedMutation.statusCode === 403, "state-changing request without cookie/CSRF was not rejected");
  assert(rejectedMutation.json().error?.code === "CSRF_REJECTED", "CSRF rejection did not use the stable error code");

  const sessionResponse = await app.inject({
    method: "POST",
    url: "/api/v1/sessions",
    headers: {
      host: "127.0.0.1:4677",
      cookie,
      "x-daoyin-csrf": bootstrap.csrfToken,
      "content-type": "application/json",
    },
    payload: { title: "general agent smoke" },
  });
  assert(sessionResponse.statusCode === 201, `session creation failed: ${sessionResponse.body}`);
  const sessionId = sessionResponse.json().session.id;

  const firstMessage = "Use the local skill, refuse private web access, create the smoke file, and remember that I prefer concise evidence-backed responses.";
  await startTurn(sessionId, cookie, bootstrap.csrfToken, firstMessage, true);
  const firstEvents = await waitForTerminal(sessionId);
  const firstTypes = firstEvents.map((event) => event.type);
  assert(firstTypes.includes("tool.failed"), `private Web fetch did not produce a policy failure: ${JSON.stringify(firstTypes)}`);
  const privateWebFailure = firstEvents.find((event) => event.type === "tool.failed" && event.payload.toolName === "web_fetch");
  assert(privateWebFailure?.payload.code === "WEB_URL_DENIED", "private Web fetch was not blocked with WEB_URL_DENIED");
  assert(firstEvents.some((event) => event.type === "tool.completed" && event.payload.toolName === "load_skill"), "local skill was not loaded");
  assert(firstEvents.some((event) => event.type === "tool.completed" && event.payload.toolName === "write_file"), "workspace write did not complete");
  const memoryCompletion = firstEvents.find((event) => event.type === "tool.completed" && event.payload.toolName === "memory_remember");
  assert(memoryCompletion !== undefined, "memory_remember did not complete");
  assert(memoryCompletion.payload.evidence.result.sourceEventIds?.length >= 1, "stored memory did not expose source event provenance");
  assert(firstEvents.every((event, index) => event.eventSeq === index + 1), "first-turn eventSeq is not contiguous");
  assert(await readFile(join(workspaceRoot, "smoke.txt"), "utf8") === "runtime-smoke-ok\n", "workspace tool did not persist the file");

  const firstModelRequest = modelRequests[0];
  assert(firstModelRequest !== undefined, "first model request was not captured");
  assert(firstModelRequest.systemPrompt.stableText.includes("general-purpose local agent"), "stable Harness identity did not reach ModelRequest metadata");
  assert(firstModelRequest.systemPrompt.stableText.includes("Memory is derived, scoped, provenance-bound"), "stable memory behavior did not reach ModelRequest metadata");
  assert(firstModelRequest.systemPrompt.dynamicText.includes("runtime_context"), "runtime dynamic prompt section is missing");
  assert(firstModelRequest.systemPrompt.dynamicText.includes("workspace_context"), "workspace dynamic prompt section is missing");
  assert(firstModelRequest.systemPrompt.dynamicText.includes("sandbox_context"), "sandbox dynamic prompt section is missing");
  assert(firstModelRequest.systemPrompt.dynamicText.includes(`Sandbox provider: ${bootstrap.sandbox.provider}`), "sandbox provider status did not reach the model prompt");
  assert(firstModelRequest.systemPrompt.dynamicText.includes("skill_catalog"), "skill catalog dynamic prompt section is missing");
  assert(firstModelRequest.systemPrompt.dynamicText.includes("Use concise evidence-backed results."), "skill catalog description did not reach the prompt");
  assert(firstModelRequest.systemPrompt.dynamicText.includes("turn_instruction"), "planning turn instruction did not reach the dynamic prompt");

  const firstLastSeq = firstEvents.at(-1).eventSeq;
  const secondMessage = "What concise response style did I ask you to remember, and what file did you create?";
  await startTurn(sessionId, cookie, bootstrap.csrfToken, secondMessage);
  const secondEvents = await waitForTerminal(sessionId, firstLastSeq);
  assert(secondEvents.at(-1)?.eventSeq === firstLastSeq + secondEvents.length, "incremental replay eventSeq is not contiguous");

  const secondTurnModelRequest = modelRequests[6];
  assert(secondTurnModelRequest !== undefined, "second-turn model request was not captured");
  const secondConversation = secondTurnModelRequest.messages.filter((message) => message.role !== "system").map((message) => "content" in message ? message.content : "").join("\n");
  assert(secondConversation.includes(firstMessage), "prior user message was not restored into second-turn dialogue");
  assert(secondConversation.includes("smoke complete"), "prior assistant response was not restored into second-turn dialogue");
  assert(secondTurnModelRequest.messages.at(-1)?.content === secondMessage, "current user message is not the final conversation item");
  assert(secondTurnModelRequest.systemPrompt.dynamicText.includes("recent_tool_evidence"), "recent tool evidence was not projected into the next turn");
  assert(secondTurnModelRequest.systemPrompt.dynamicText.includes("smoke.txt"), "persisted write_file input was not available in recent tool evidence");
  assert(secondTurnModelRequest.systemPrompt.dynamicText.includes("WEB_URL_DENIED"), "persisted Web policy failure was not available in recent tool evidence");
  assert(secondTurnModelRequest.systemPrompt.dynamicText.includes("<system_section name=\"memory\""), "relevant memory section was not injected");
  assert(secondTurnModelRequest.systemPrompt.dynamicText.includes("User prefers concise evidence-backed responses."), "stored memory was not retrieved into the second turn");

  const secondLastSeq = secondEvents.at(-1).eventSeq;
  const thirdMessage = "Continue for one more turn using the context you have.";
  await startTurn(sessionId, cookie, bootstrap.csrfToken, thirdMessage);
  const thirdEvents = await waitForTerminal(sessionId, secondLastSeq);
  const thirdTurnModelRequest = modelRequests[7];
  assert(thirdTurnModelRequest !== undefined, "third-turn model request was not captured");
  assert(thirdTurnModelRequest.systemPrompt.dynamicText.includes("session_compaction"), "session compaction was not injected on the third turn");
  assert(thirdTurnModelRequest.systemPrompt.dynamicText.includes("deterministic-trajectory-v1"), "compaction strategy metadata is missing");
  assert(thirdTurnModelRequest.systemPrompt.dynamicText.includes("write_file"), "compacted summary did not retain prior tool evidence");
  const thirdDialogue = thirdTurnModelRequest.messages.filter((message) => message.role !== "system").map((message) => "content" in message ? message.content : "").join("\n");
  assert(!thirdDialogue.includes(firstMessage), "raw first-turn dialogue was not removed after compaction");
  assert(thirdDialogue.includes(secondMessage), "recent un-compacted second turn was not retained");

  const compactionText = await readFile(join(dataDir, "compactions", `${sessionId}.jsonl`), "utf8");
  const compaction = JSON.parse(compactionText.trim().split("\n").at(-1));
  assert(compaction.sourceStartSeq === 1, "compaction did not retain the original source range start");
  assert(compaction.sourceEndSeq === firstLastSeq, "compaction did not cover exactly the first completed turn");

  const thirdLastSeq = thirdEvents.at(-1).eventSeq;
  await startTurn(sessionId, cookie, bootstrap.csrfToken, "Inspect the local Node runtime version using the safe process capability.");
  const fourthEvents = await waitForTerminal(sessionId, thirdLastSeq);
  const processInspect = fourthEvents.find((event) => event.type === "tool.completed" && event.payload.toolName === "process_inspect");
  assert(processInspect !== undefined, "read-only process inspection did not complete");
  assert(processInspect.payload.evidence.result.risk === "inspect", "process inspection was not classified as read-only inspect risk");
  assert(processInspect.payload.evidence.result.sandboxRequested === true, "process inspection did not request sandbox execution");
  if (bootstrap.sandbox.available) {
    assert(processInspect.payload.evidence.result.osIsolation === "bubblewrap", "available Bubblewrap sandbox was not used for process inspection");
    assert(processInspect.payload.evidence.result.networkIsolation === "blocked", "sandboxed process inspection did not block network access");
  } else {
    assert(processInspect.payload.evidence.result.osIsolation === "none", "unavailable sandbox was falsely reported as OS isolation");
    assert(processInspect.payload.evidence.result.sandboxProvider === "none", "unavailable sandbox was falsely reported as a provider");
  }

  const fourthLastSeq = fourthEvents.at(-1).eventSeq;
  await startTurn(sessionId, cookie, bootstrap.csrfToken, "Run the workspace test package script.");
  const fifthEvents = await waitForTerminal(sessionId, fourthLastSeq);
  const approvalFailure = fifthEvents.find((event) => event.type === "tool.failed" && event.payload.toolName === "run_package_script");
  assert(approvalFailure?.payload.code === "PROCESS_APPROVAL_REQUIRED", "workspace package script did not require explicit approval");
  const permissionRequestId = approvalFailure.payload.details?.permissionRequestId;
  assert(typeof permissionRequestId === "string", "process approval failure did not persist a permission request id");

  const pendingPermissions = await app.inject({
    method: "GET",
    url: `/api/v1/process/permissions?sessionId=${encodeURIComponent(sessionId)}`,
    headers: { host: "127.0.0.1:4677" },
  });
  assert(pendingPermissions.statusCode === 200, `permission list failed: ${pendingPermissions.body}`);
  assert(pendingPermissions.json().some((permission) => permission.id === permissionRequestId && permission.status === "pending"), "pending process permission was not queryable");

  const approveResponse = await app.inject({
    method: "POST",
    url: `/api/v1/process/permissions/${encodeURIComponent(permissionRequestId)}/decision`,
    headers: {
      host: "127.0.0.1:4677",
      cookie,
      "x-daoyin-csrf": bootstrap.csrfToken,
      "content-type": "application/json",
    },
    payload: { approve: true },
  });
  assert(approveResponse.statusCode === 200, `permission approval failed: ${approveResponse.body}`);
  assert(approveResponse.json().status === "approved", "process permission did not enter approved state");

  const fifthLastSeq = fifthEvents.at(-1).eventSeq;
  await startTurn(sessionId, cookie, bootstrap.csrfToken, "Continue and consume the exact one-shot package-script approval.");
  const sixthEvents = await waitForTerminal(sessionId, fifthLastSeq);
  const approvedProcess = sixthEvents.find((event) => event.type === "tool.completed" && event.payload.toolName === "run_package_script");
  assert(approvedProcess !== undefined, "approved package script did not execute");
  assert(String(approvedProcess.payload.evidence.result.stdout ?? "").includes("runtime-process-ok"), "approved package script output was not captured");
  assert(approvedProcess.payload.evidence.result.sandboxRequested === true, "approved package script did not request sandbox execution");
  assert(approvedProcess.payload.evidence.result.osIsolation === (bootstrap.sandbox.available ? "bubblewrap" : "none"), "package-script OS isolation evidence disagrees with runtime sandbox status");

  const consumedPermissions = await app.inject({
    method: "GET",
    url: `/api/v1/process/permissions?sessionId=${encodeURIComponent(sessionId)}`,
    headers: { host: "127.0.0.1:4677" },
  });
  assert(consumedPermissions.json().some((permission) => permission.id === permissionRequestId && permission.status === "consumed"), "one-shot permission was not consumed after execution");

  const allEventsResponse = await app.inject({
    method: "GET",
    url: `/api/v1/sessions/${sessionId}/events?after=0`,
    headers: { host: "127.0.0.1:4677" },
  });
  const allEvents = allEventsResponse.json().events;
  const expectedEventCount = firstEvents.length + secondEvents.length + thirdEvents.length + fourthEvents.length + fifthEvents.length + sixthEvents.length;
  assert(allEvents.length === expectedEventCount, "compaction or permission handling changed the canonical transcript event count");
  assert(allEvents[0]?.payload?.userMessage === firstMessage, "compaction removed or rewrote the original first user event");

  console.log("DaoyinHarness general-agent smoke passed: skills -> Web policy -> workspace -> memory -> compaction -> process permission -> replay.");
} finally {
  await app?.close();
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
}
