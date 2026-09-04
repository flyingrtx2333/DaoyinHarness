import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlProcessPermissionStore } from "./permission-store.js";

const temporaryDirectories: string[] = [];

async function fixture(): Promise<JsonlProcessPermissionStore> {
  const root = await mkdtemp(path.join(os.tmpdir(), "daoyin-process-permission-"));
  temporaryDirectories.push(root);
  return new JsonlProcessPermissionStore(path.join(root, "permissions.jsonl"));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("JsonlProcessPermissionStore", () => {
  it("grants an exact fingerprint once and then marks it consumed", async () => {
    const store = await fixture();
    const request = await store.request({
      accountId: "local",
      resourceScopeId: "resource_test",
      sessionId: "session_test",
      turnId: "turn_test",
      operation: "package_script",
      displayCommand: "npm run test",
      fingerprint: "fingerprint_test",
      risk: "workspace_exec",
      reason: "workspace code",
    });
    expect(request.status).toBe("pending");
    await expect(store.decide(request.id, "local", "resource_test", true)).resolves.toMatchObject({ status: "approved" });

    const consumed = await store.consumeApproved("fingerprint_test", "local", "resource_test", "session_test");
    expect(consumed).toMatchObject({ id: request.id, status: "consumed" });
    await expect(store.consumeApproved("fingerprint_test", "local", "resource_test", "session_test")).resolves.toBeUndefined();
  });

  it("does not allow a decision from another resource scope", async () => {
    const store = await fixture();
    const request = await store.request({
      accountId: "local",
      resourceScopeId: "resource_a",
      sessionId: "session_test",
      turnId: "turn_test",
      operation: "package_script",
      displayCommand: "npm run build",
      fingerprint: "fingerprint_build",
      risk: "workspace_exec",
      reason: "workspace code",
    });
    await expect(store.decide(request.id, "local", "resource_b", true)).rejects.toMatchObject({ code: "PROCESS_PERMISSION_SCOPE_DENIED" });
  });
});
