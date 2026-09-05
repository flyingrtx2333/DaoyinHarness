import { describe, expect, it, vi } from "vitest";
import type { ExecutionIdentity } from "@daoyin/harness-contracts";
import { ToolRegistry, type ToolDefinition, type ToolExecutionContext, type ToolSuccess } from "./registry.js";

const localContext: ToolExecutionContext = { accountId: "alice", scopeId: "scope-a", sessionId: "session-a", turnId: "turn-a", sourceEventIds: [] };
function cloudContext(): ToolExecutionContext {
  const executionIdentity: ExecutionIdentity = {
    actorUserId: "alice", space: { kind: "organization", id: "team-a", tenantId: "tenant-a" },
    appInstallationId: "story-a", authorizationId: "grant-a", billingAccountId: "wallet-a",
    expiresAt: Date.now() + 60_000, permissions: ["agent.use", "story.read"], allowedTools: ["allowed"],
  };
  return { ...localContext, executionIdentity };
}
function tool(name = "allowed") {
  const execute = vi.fn(async (): Promise<ToolSuccess> => ({
    ok: true, summary: "read complete", evidence: { schemaVersion: 1, toolName: name, result: {}, artifacts: [], diagnostics: [] },
  }));
  const definition: ToolDefinition = { name, description: name, inputSchema: { type: "object" }, category: "extension", mutating: false, execute };
  return { definition, execute };
}
const request = { id: "call-a", name: "allowed", input: {} };
const signal = (): AbortSignal => new AbortController().signal;

describe("tool authorization boundary (mocked tool I/O)", () => {
  it("does not manufacture a test identity when context is omitted", async () => {
    const fixture = tool();
    const registry = new ToolRegistry([fixture.definition]);
    await expect(registry.execute(request, signal())).resolves.toMatchObject({ ok: false, code: "TOOL_CONTEXT_REQUIRED" });
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("preserves explicitly scoped local tool execution", async () => {
    const fixture = tool();
    await expect(new ToolRegistry([fixture.definition]).execute(request, signal(), localContext)).resolves.toMatchObject({ ok: true });
    expect(fixture.execute).toHaveBeenCalledOnce();
  });

  it("requires a policy for cloud identities and a cloud identity for policies", async () => {
    const fixture = tool();
    await expect(new ToolRegistry([fixture.definition]).execute(request, signal(), cloudContext()))
      .resolves.toMatchObject({ ok: false, code: "TOOL_AUTHORIZATION_REQUIRED" });
    await expect(new ToolRegistry([fixture.definition], { authorize: () => true }).execute(request, signal(), localContext))
      .resolves.toMatchObject({ ok: false, code: "EXECUTION_IDENTITY_INVALID" });
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("filters discovery and blocks direct invocation of a hidden tool", async () => {
    const allowed = tool();
    const hidden = tool("private_data");
    const registry = new ToolRegistry([allowed.definition, hidden.definition], {
      authorize: ({ tool: descriptor, context }) => context.executionIdentity?.allowedTools.includes(descriptor.name) === true,
    });
    expect((await registry.descriptorsFor(cloudContext())).map((entry) => entry.name)).toEqual(["allowed"]);
    await expect(registry.execute({ ...request, name: "private_data" }, signal(), cloudContext()))
      .resolves.toMatchObject({ ok: false, code: "TOOL_ACCESS_DENIED" });
    expect(hidden.execute).not.toHaveBeenCalled();
  });

  it("checks authorization again after discovery", async () => {
    let active = true;
    const fixture = tool();
    const registry = new ToolRegistry([fixture.definition], { authorize: () => active });
    expect(await registry.descriptorsFor(cloudContext())).toHaveLength(1);
    active = false;
    await expect(registry.execute(request, signal(), cloudContext())).resolves.toMatchObject({ ok: false, code: "TOOL_ACCESS_DENIED" });
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("denies expired grants and account mismatches", async () => {
    const fixture = tool();
    const registry = new ToolRegistry([fixture.definition], { authorize: () => true });
    const expired = cloudContext();
    if (expired.executionIdentity === undefined) throw new Error("fixture identity missing");
    expired.executionIdentity = { ...expired.executionIdentity, expiresAt: Date.now() - 1 };
    await expect(registry.execute(request, signal(), expired)).resolves.toMatchObject({ ok: false, code: "EXECUTION_AUTHORIZATION_EXPIRED" });
    await expect(registry.execute(request, signal(), { ...cloudContext(), accountId: "bob" })).resolves.toMatchObject({ ok: false });
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("fails closed and redacts errors when authorization throws", async () => {
    const fixture = tool();
    const registry = new ToolRegistry([fixture.definition], { authorize: () => { throw new Error("secret-provider-token"); } });
    expect(await registry.descriptorsFor(cloudContext())).toEqual([]);
    const result = await registry.execute(request, signal(), cloudContext());
    expect(result).toMatchObject({ ok: false, code: "TOOL_ACCESS_DENIED" });
    expect(JSON.stringify(result)).not.toContain("secret-provider-token");
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("does not execute after cancellation during authorization", async () => {
    const fixture = tool();
    const controller = new AbortController();
    const registry = new ToolRegistry([fixture.definition], { authorize: () => { controller.abort(); return true; } });
    await expect(registry.execute(request, controller.signal, cloudContext())).resolves.toMatchObject({ ok: false, code: "TOOL_CANCELLED" });
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("does not persist unreviewed cloud argument values or raw tool exceptions", async () => {
    const fixture = tool();
    fixture.execute.mockRejectedValue(new Error("secret-provider-token"));
    const registry = new ToolRegistry([fixture.definition], { authorize: () => true });
    expect(registry.auditInput("allowed", { credential: "secret-provider-token" })).toEqual({ keys: ["credential"] });
    const result = await registry.execute(request, signal(), cloudContext());
    expect(result).toMatchObject({ ok: false, code: "TOOL_EXECUTION_FAILED" });
    expect(JSON.stringify(result)).not.toContain("secret-provider-token");
  });
});
