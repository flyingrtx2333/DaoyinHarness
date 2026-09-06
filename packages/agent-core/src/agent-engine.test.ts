import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolRegistry, createWorkspaceTools } from "@daoyin/harness-tools";
import { JsonlSessionStore, Workspace } from "@daoyin/harness-workspace";
import { AgentEngine, type ModelClient, type ModelReply, type ModelRequest } from "./agent-engine.js";
import { createDefaultPromptRegistry, promptSection } from "./prompt-registry.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "daoyin-harness-agent-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

class ReplayModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  readonly #replies: ModelReply[];

  public constructor(replies: ModelReply[]) {
    this.#replies = [...replies];
  }

  public async complete(request: ModelRequest): Promise<ModelReply> {
    this.requests.push(request);
    const reply = this.#replies.shift();
    if (reply === undefined) {
      throw new Error("Replay exhausted.");
    }
    return reply;
  }
}

async function fixture(model: ModelClient): Promise<{
  engine: AgentEngine;
  root: string;
  store: JsonlSessionStore;
}> {
  const root = await temporaryDirectory();
  const workspace = await Workspace.open(root);
  const store = new JsonlSessionStore(path.join(root, ".events"));
  const tools = new ToolRegistry(createWorkspaceTools(workspace));
  return { engine: new AgentEngine({ model, tools, events: store }), root, store };
}

const turnInput = {
  accountId: "account_test",
  scopeId: "scope_test",
  sessionId: "session_test",
  turnId: "turn_test",
  userMessage: "Create a greeting file.",
} as const;

describe("AgentEngine", () => {
  it("persists real model chunks before completion without duplicating the final reply", async () => {
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    let received!: () => void;
    const first = new Promise<void>(resolve => { received = resolve; });
    const { engine, store } = await fixture({ complete: async request => {
      await request.onTextDelta?.("第一段"); received(); await paused;
      await request.onTextDelta?.("，第二段");
      return { kind: "assistant", content: "第一段，第二段" };
    } });
    const running = engine.runTurn(turnInput);
    await first;
    const during = await store.read(turnInput.sessionId);
    expect(during.at(-1)).toMatchObject({ type: "assistant.delta", payload: { delta: "第一段" } });
    expect(during.some(event => event.type === "turn.completed")).toBe(false);
    release(); await running;
    const events = await store.read(turnInput.sessionId);
    expect(events.filter(event => event.type === "assistant.delta").map(event => event.payload.delta).join("")).toBe("第一段，第二段");
    expect(events.at(-1)?.type).toBe("turn.completed");
  });
  it("continues after a 2000-file result while retaining full append-only evidence", async () => {
    const files = Array.from({ length: 2000 }, (_, index) => `docs/${index}/${"long-folder/".repeat(6)}file.md`);
    const root = await temporaryDirectory();
    const store = new JsonlSessionStore(path.join(root, ".events"));
    const requests: ModelRequest[] = [];
    const model: ModelClient = {
      async complete(request) {
        requests.push(request);
        for (const message of request.messages) {
          if (message.content.length > 100_000) throw Object.assign(new Error("Gateway 422: string_too_long"), { code: "MODEL_CONTEXT_TOO_LARGE" });
        }
        return requests.length === 1
          ? { kind: "tool_calls", calls: [{ id: "call_large_list", name: "list_files", input: { path: "." } }] }
          : { kind: "assistant", content: "已读取目录预览，可继续按子目录查看。" };
      },
    };
    const tools = new ToolRegistry([{
      name: "list_files", description: "Large file list replay fixture", category: "workspace", mutating: false, inputSchema: { type: "object" },
      async execute() {
        return { ok: true, summary: "Listed 2000 files.", evidence: { schemaVersion: 1, toolName: "list_files", result: { files }, artifacts: [], diagnostics: [] } };
      },
    }]);
    const engine = new AgentEngine({ model, tools, events: store });
    const result = await engine.runTurn({ ...turnInput, userMessage: "浏览本地文件" });
    expect(result.status).toBe("completed");
    expect(requests).toHaveLength(2);
    const returned = requests[1]?.messages.at(-1);
    expect(returned).toMatchObject({ role: "tool", toolCallId: "call_large_list", toolName: "list_files" });
    expect(JSON.parse(returned?.content ?? "{}")).toHaveProperty("modelContext.truncated", true);
    const events = await store.read(turnInput.sessionId);
    const completed = events.find(event => event.type === "tool.completed");
    expect(completed).toMatchObject({ payload: { evidence: { result: { files } } } });
    expect(events.at(-1)?.type).toBe("turn.completed");
  });

  it("runs a tool loop, persists evidence, and returns a final response", async () => {
    const model = new ReplayModel([
      {
        kind: "tool_calls",
        calls: [{ id: "call_write", name: "write_file", input: { path: "hello.txt", content: "hello\n" } }],
      },
      { kind: "assistant", content: "Created hello.txt." },
    ]);
    const { engine, root, store } = await fixture(model);

    const result = await engine.runTurn(turnInput);

    expect(result.status).toBe("completed");
    expect(await readFile(path.join(root, "hello.txt"), "utf8")).toBe("hello\n");
    const events = await store.read("session_test");
    expect(events.map((event) => event.type)).toEqual([
      "turn.started",
      "tool.started",
      "tool.completed",
      "assistant.delta",
      "turn.completed",
    ]);
    expect(events.map((event) => event.eventSeq)).toEqual([1, 2, 3, 4, 5]);
    expect(model.requests[1]?.messages.at(-1)).toMatchObject({ role: "tool", toolName: "write_file" });
  });

  it("persists a tool's sanitized audit input instead of sensitive execution input", async () => {
    const model = new ReplayModel([
      {
        kind: "tool_calls",
        calls: [{ id: "call_sensitive", name: "sensitive_tool", input: { text: "do not persist me" } }],
      },
      { kind: "assistant", content: "Sensitive tool complete." },
    ]);
    const root = await temporaryDirectory();
    const store = new JsonlSessionStore(path.join(root, ".events"));
    const tools = new ToolRegistry([{
      name: "sensitive_tool",
      description: "Test sensitive audit input.",
      category: "system",
      mutating: true,
      inputSchema: { type: "object" },
      auditInput: () => ({ text: "[redacted]" }),
      async execute() {
        return {
          ok: true,
          summary: "Sensitive operation completed.",
          evidence: { schemaVersion: 1, toolName: "sensitive_tool", result: { ok: true }, artifacts: [], diagnostics: [] },
        };
      },
    }]);
    const engine = new AgentEngine({ model, tools, events: store });

    await engine.runTurn({ ...turnInput, turnId: "turn_sensitive", userMessage: "Use the sensitive tool." });
    const started = (await store.read("session_test")).find((event) => event.type === "tool.started");
    expect(started).toMatchObject({ type: "tool.started", payload: { input: { text: "[redacted]" } } });
    expect(JSON.stringify(await store.read("session_test"))).not.toContain("do not persist me");
  });

  it("reassembles dynamic prompt sections for every step and persists tool inputs for later evidence", async () => {
    const model = new ReplayModel([
      {
        kind: "tool_calls",
        calls: [{ id: "call_write_dynamic", name: "write_file", input: { path: "dynamic.txt", content: "dynamic\n" } }],
      },
      { kind: "assistant", content: "First turn complete." },
      { kind: "assistant", content: "The previous tool wrote dynamic.txt." },
    ]);
    const root = await temporaryDirectory();
    const workspace = await Workspace.open(root);
    const store = new JsonlSessionStore(path.join(root, ".events"));
    const tools = new ToolRegistry(createWorkspaceTools(workspace));
    const promptRegistry = createDefaultPromptRegistry();
    promptRegistry.register(promptSection("step_probe", "dynamic", 1250, ({ step }) => `probe-step=${String(step)}`));
    const engine = new AgentEngine({ model, tools, events: store, promptRegistry });

    await engine.runTurn({ ...turnInput, turnId: "turn_dynamic_first", userMessage: "Write dynamic.txt." });
    const firstEvents = await store.read("session_test");
    const started = firstEvents.find((event) => event.type === "tool.started");
    expect(started).toMatchObject({
      type: "tool.started",
      payload: { input: { path: "dynamic.txt", content: "dynamic\n" } },
    });
    expect(model.requests[0]?.messages[0]).toMatchObject({ role: "system", content: expect.stringContaining("probe-step=0") });
    expect(model.requests[1]?.messages[0]).toMatchObject({ role: "system", content: expect.stringContaining("probe-step=1") });

    await engine.runTurn({ ...turnInput, turnId: "turn_dynamic_second", userMessage: "What did the previous tool write?" });
    const secondSystem = model.requests[2]?.messages[0];
    expect(secondSystem).toMatchObject({ role: "system", content: expect.stringContaining("recent_tool_evidence") });
    expect(secondSystem).toMatchObject({ role: "system", content: expect.stringContaining("dynamic.txt") });
    expect(secondSystem).toMatchObject({ role: "system", content: expect.stringContaining("write_file") });
  });

  it("restores prior dialogue from the append-only transcript on the next turn", async () => {
    const model = new ReplayModel([
      { kind: "assistant", content: "The preferred destination is Kyoto." },
      { kind: "assistant", content: "Yes, Kyoto was the destination we discussed." },
    ]);
    const { engine } = await fixture(model);

    await engine.runTurn({ ...turnInput, turnId: "turn_first", userMessage: "Remember that I prefer Kyoto for this trip." });
    await engine.runTurn({ ...turnInput, turnId: "turn_second", userMessage: "Which destination did we just discuss?", systemInstruction: "Answer from prior session context." });

    const secondRequest = model.requests[1];
    expect(secondRequest?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: "Remember that I prefer Kyoto for this trip." }),
      expect.objectContaining({ role: "assistant", content: "The preferred destination is Kyoto." }),
      expect.objectContaining({ role: "system", content: expect.stringContaining("prior session context") }),
      expect.objectContaining({ role: "user", content: "Which destination did we just discuss?" }),
    ]));
    expect(secondRequest?.messages.at(-1)).toMatchObject({ role: "user", content: "Which destination did we just discuss?" });
  });

  it("returns tool failures to the model for an accurate final summary", async () => {
    const model = new ReplayModel([
      {
        kind: "tool_calls",
        calls: [{ id: "call_patch", name: "apply_patch", input: { path: "missing.txt", expected: "old", replacement: "new" } }],
      },
      { kind: "assistant", content: "I could not patch missing.txt because it does not exist." },
    ]);
    const { engine, store } = await fixture(model);

    const result = await engine.runTurn(turnInput);

    expect(result.status).toBe("completed");
    const events = await store.read("session_test");
    expect(events.some((event) => event.type === "tool.failed")).toBe(true);
    expect(model.requests[1]?.messages.at(-1)).toMatchObject({ role: "tool", toolName: "apply_patch" });
  });

  it("records cancellation before calling the model", async () => {
    const model = new ReplayModel([{ kind: "assistant", content: "should not run" }]);
    const { engine, store } = await fixture(model);
    const controller = new AbortController();
    controller.abort();

    const result = await engine.runTurn({ ...turnInput, signal: controller.signal });

    expect(result.status).toBe("cancelled");
    expect(model.requests).toHaveLength(0);
    expect((await store.read("session_test")).map((event) => event.type)).toEqual([
      "turn.started",
      "assistant.delta",
      "turn.cancelled",
    ]);
  });

  it("fails with one terminal response when the model throws", async () => {
    const model: ModelClient = {
      async complete() {
        throw new Error("gateway unavailable");
      },
    };
    const { engine, store } = await fixture(model);

    const result = await engine.runTurn(turnInput);

    expect(result).toMatchObject({ status: "failed", lastEventSeq: 3 });
    expect((await store.read("session_test")).map((event) => event.type)).toEqual([
      "turn.started",
      "assistant.delta",
      "turn.failed",
    ]);
  });

  it("preserves stable MODEL_* gateway error codes in the terminal event", async () => {
    const model: ModelClient = {
      async complete() {
        throw Object.assign(new Error("login required"), { code: "MODEL_AUTH_REQUIRED" });
      },
    };
    const { engine, store } = await fixture(model);

    await expect(engine.runTurn(turnInput)).resolves.toMatchObject({ status: "failed" });
    const terminal = (await store.read("session_test")).find((event) => event.type === "turn.failed");
    expect(terminal).toMatchObject({ type: "turn.failed", payload: { code: "MODEL_AUTH_REQUIRED" } });
  });
});
