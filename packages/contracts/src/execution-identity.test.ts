import { describe, expect, it } from "vitest";
import { assertExecutionIdentity, executionScopeKey, sameExecutionScope, snapshotExecutionIdentity, type ExecutionIdentity } from "./index.js";

function identity(): ExecutionIdentity {
  return {
    actorUserId: "alice", space: { kind: "personal", id: "alice-personal", ownerUserId: "alice" },
    appInstallationId: "story-personal", authorizationId: "grant-1", billingAccountId: "alice-wallet",
    expiresAt: Date.now() + 60_000, permissions: ["agent.use", "story.read"], allowedTools: ["story_list"],
  };
}

describe("execution identity contracts (pure policy, no auth/provider I/O)", () => {
  it("accepts explicit personal and organization scopes", () => {
    expect(() => assertExecutionIdentity(identity())).not.toThrow();
    expect(() => assertExecutionIdentity({ ...identity(), space: { kind: "organization", id: "team-a", tenantId: "tenant-a" } })).not.toThrow();
  });

  it.each([
    ["missing identity", (): unknown => undefined],
    ["missing payer", () => ({ ...identity(), billingAccountId: undefined })],
    ["expired grant", () => ({ ...identity(), expiresAt: Date.now() - 1 })],
    ["foreign personal owner", () => ({ ...identity(), space: { kind: "personal", id: "alice-personal", ownerUserId: "bob" } })],
    ["ambiguous personal tenant", () => ({ ...identity(), space: { kind: "personal", id: "alice-personal", ownerUserId: "alice", tenantId: "tenant-a" } })],
    ["missing tenant", () => ({ ...identity(), space: { kind: "organization", id: "team-a" } })],
    ["unknown scope kind", () => ({ ...identity(), space: { kind: "auto", id: "team-a" } })],
    ["wildcard tools", () => ({ ...identity(), allowedTools: ["*"] })],
  ] as const)("rejects %s without supplying a default", (_label, candidate) => {
    expect(() => assertExecutionIdentity(candidate())).toThrow();
  });

  it("separates the same actor by application and organization", () => {
    const original = identity();
    const otherApp = { ...original, appInstallationId: "youji-personal" };
    const tenantA: ExecutionIdentity = { ...original, space: { kind: "organization", id: "team", tenantId: "tenant-a" } };
    const tenantB: ExecutionIdentity = { ...original, space: { kind: "organization", id: "team", tenantId: "tenant-b" } };
    expect(new Set([original, otherApp, tenantA, tenantB].map(executionScopeKey)).size).toBe(4);
  });

  it("does not change resource ownership when a grant is refreshed or payer changes", () => {
    const refreshed: ExecutionIdentity = { ...identity(), authorizationId: "new-grant", billingAccountId: "new-wallet" };
    expect(sameExecutionScope(identity(), refreshed)).toBe(true);
  });

  it("snapshots grants without retaining mutable authenticator arrays", () => {
    const permissions = ["agent.use"];
    const original = { ...identity(), permissions };
    const copy = snapshotExecutionIdentity(original);
    permissions.push("private.read");
    expect(copy.permissions).toEqual(["agent.use"]);
    expect(Object.isFrozen(copy)).toBe(true);
    expect(Object.isFrozen(copy.space)).toBe(true);
    expect(Object.isFrozen(copy.allowedTools)).toBe(true);
  });
});
