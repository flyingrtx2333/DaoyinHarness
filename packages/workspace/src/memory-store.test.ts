import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlMemoryStore } from "./memory-store.js";

const temporaryDirectories: string[] = [];

async function storeFixture(): Promise<JsonlMemoryStore> {
  const root = await mkdtemp(path.join(os.tmpdir(), "daoyin-memory-store-"));
  temporaryDirectories.push(root);
  return new JsonlMemoryStore(path.join(root, "memory.jsonl"));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("JsonlMemoryStore", () => {
  it("retrieves only authorized active memories with provenance", async () => {
    const store = await storeFixture();
    const first = await store.append({
      accountId: "account_a",
      scope: "account",
      scopeId: "account_a",
      kind: "preference",
      content: "User prefers concise evidence-backed answers.",
      keywords: ["concise", "evidence"],
      sourceEventIds: ["evt_source_a"],
    });
    await store.append({
      accountId: "account_b",
      scope: "account",
      scopeId: "account_b",
      kind: "preference",
      content: "Other account prefers verbose answers.",
      sourceEventIds: ["evt_source_b"],
    });

    const hits = await store.search({
      accountId: "account_a",
      sessionId: "session_a",
      resourceScopeId: "scope_a",
      query: "concise evidence answer",
    });

    expect(hits[0]?.record).toMatchObject({ id: first.id, accountId: "account_a", sourceEventIds: ["evt_source_a"] });
    expect(hits.some((hit) => hit.record.accountId === "account_b")).toBe(false);
  });

  it("supersedes and forgets append-only records without keeping stale memories active", async () => {
    const store = await storeFixture();
    const first = await store.append({
      accountId: "account_a",
      scope: "session",
      scopeId: "session_a",
      kind: "goal",
      content: "Use Kyoto as the destination.",
      sourceEventIds: ["evt_first"],
    });
    const second = await store.append({
      accountId: "account_a",
      scope: "session",
      scopeId: "session_a",
      kind: "goal",
      content: "Use Osaka as the destination.",
      sourceEventIds: ["evt_second"],
      supersedes: first.id,
    });
    await store.append({
      accountId: "account_a",
      scope: "session",
      scopeId: "session_a",
      kind: "goal",
      content: "",
      sourceEventIds: ["evt_forget"],
      supersedes: second.id,
      tombstone: true,
    });

    await expect(store.listActive("account_a")).resolves.toEqual([]);
    await expect(store.append({
      accountId: "account_a",
      scope: "session",
      scopeId: "session_a",
      kind: "goal",
      content: "Branch from stale Kyoto memory.",
      sourceEventIds: ["evt_branch"],
      supersedes: first.id,
    })).rejects.toMatchObject({ code: "MEMORY_ALREADY_SUPERSEDED" });
  });
});
