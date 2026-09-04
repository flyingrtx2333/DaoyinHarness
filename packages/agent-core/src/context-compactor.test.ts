import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlCompactionStore, JsonlSessionStore } from "@daoyin/harness-workspace";
import { ContextCompactor } from "./context-compactor.js";

const temporaryDirectories: string[] = [];

async function fixture(): Promise<{ events: JsonlSessionStore; compactions: JsonlCompactionStore }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "daoyin-compactor-"));
  temporaryDirectories.push(root);
  return {
    events: new JsonlSessionStore(path.join(root, "events")),
    compactions: new JsonlCompactionStore(path.join(root, "compactions")),
  };
}

async function appendTurn(events: JsonlSessionStore, index: number): Promise<void> {
  const base = {
    accountId: "account_test",
    scopeId: "scope_test",
    sessionId: "session_test",
    turnId: `turn_${String(index)}`,
  } as const;
  await events.append({
    ...base,
    type: "turn.started",
    payload: { status: "running", userMessageId: `msg_user_${String(index)}`, userMessage: `User request ${String(index)}` },
  });
  await events.append({
    ...base,
    type: "assistant.delta",
    payload: { contentBlockId: `block_${String(index)}`, delta: `Assistant response ${String(index)}` },
  });
  await events.append({
    ...base,
    type: "turn.completed",
    payload: { status: "completed", assistantMessageId: `msg_assistant_${String(index)}`, outcomeSummary: `Assistant response ${String(index)}` },
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ContextCompactor", () => {
  it("writes a derived event-range summary without rewriting the canonical transcript", async () => {
    const { events, compactions } = await fixture();
    await appendTurn(events, 1);
    await appendTurn(events, 2);
    await appendTurn(events, 3);
    const before = await events.read("session_test");
    const compactor = new ContextCompactor({
      store: compactions,
      retainRecentTurns: 1,
      triggerUncompactedTurns: 2,
      triggerCharacters: 2_000,
      maxSummaryCharacters: 4_000,
    });

    const compacted = await compactor.compactIfNeeded("session_test", before);

    expect(compacted).toMatchObject({
      sourceStartSeq: 1,
      sourceEndSeq: 6,
      strategy: "deterministic-trajectory-v1",
    });
    expect(compacted?.summary).toContain("User request 1");
    expect(compacted?.summary).toContain("User request 2");
    await expect(events.read("session_test")).resolves.toHaveLength(before.length);
    await expect(compactor.compactIfNeeded("session_test", before)).resolves.toMatchObject({ id: compacted?.id });
  });
});
