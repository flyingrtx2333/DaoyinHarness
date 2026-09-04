import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PendingAgentEvent } from "@daoyin/harness-protocol";
import { JsonlSessionStore } from "./session-store.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "daoyin-harness-transcript-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function startedEvent(index: number): PendingAgentEvent<"turn.started"> {
  return {
    type: "turn.started",
    accountId: "account_test",
    scopeId: "scope_test",
    sessionId: "session_test",
    turnId: `turn_${String(index)}`,
    payload: {
      status: "running",
      userMessageId: `message_${String(index)}`,
      userMessage: `request ${String(index)}`,
    },
  };
}

describe("JsonlSessionStore", () => {
  it("serializes concurrent appends with monotonic event sequences", async () => {
    const directory = await temporaryDirectory();
    const store = new JsonlSessionStore(directory);

    await Promise.all(Array.from({ length: 12 }, (_, index) => store.append(startedEvent(index))));

    const events = await store.read("session_test");
    expect(events.map((event) => event.eventSeq)).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    const transcript = await readFile(path.join(directory, "session_test.jsonl"), "utf8");
    expect(transcript.trim().split("\n")).toHaveLength(12);
  });

  it("ignores a truncated final line while preserving complete events", async () => {
    const directory = await temporaryDirectory();
    const store = new JsonlSessionStore(directory);
    await store.append(startedEvent(1));
    const transcriptPath = path.join(directory, "session_test.jsonl");
    const transcript = await readFile(transcriptPath, "utf8");
    await writeFile(transcriptPath, `${transcript}{"partial":`, "utf8");

    const events = await store.read("session_test");
    expect(events).toHaveLength(1);
    expect(events[0]?.eventSeq).toBe(1);

    await store.append(startedEvent(2));
    const recoveredEvents = await store.read("session_test");
    expect(recoveredEvents.map((event) => event.eventSeq)).toEqual([1, 2]);
    expect((await readFile(transcriptPath, "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("rejects unsafe session identifiers", async () => {
    const store = new JsonlSessionStore(await temporaryDirectory());
    await expect(store.read("../outside")).rejects.toThrow(/sessionId/u);
  });
});
