import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonSessionCatalog } from "./session-catalog.js";

const directories: string[] = [];

async function catalog(): Promise<JsonSessionCatalog> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "daoyin-session-catalog-"));
  directories.push(directory);
  return new JsonSessionCatalog(directory);
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

describe("JsonSessionCatalog fork metadata", () => {
  it("creates an empty branch that references an immutable source boundary", async () => {
    const store = await catalog();
    const source = await store.create("Source conversation");
    await store.update(source.id, { lastEventSeq: 9, updatedAt: "2026-09-04T01:00:00.000Z" });

    const fork = await store.createFork(source.id, 7);

    expect(fork).toMatchObject({
      title: "Source conversation · 分支",
      lastEventSeq: 0,
      activeTurnId: null,
      forkedFrom: { sourceSessionId: source.id, sourceEventSeq: 7 },
    });
    expect((await store.get(source.id))?.forkedFrom).toBeUndefined();
    expect((await store.get(fork.id))?.forkedFrom).toEqual({ sourceSessionId: source.id, sourceEventSeq: 7 });
  });

  it("rejects missing sources and invalid boundaries", async () => {
    const store = await catalog();
    await expect(store.createFork("missing", 0)).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    const source = await store.create("Source");
    await expect(store.createFork(source.id, -1)).rejects.toMatchObject({ code: "SESSION_FORK_BOUNDARY_INVALID" });
  });
});
