import { describe, expect, it } from "vitest";
import { assertExecutionIdentity, executionScopeKey, type ExecutionIdentity } from "./index.js";

function identity(): ExecutionIdentity {
  return {
    actorUserId: "visitor-a", space: { kind: "public", id: "company-public", audience: "company-app" },
    appInstallationId: "company-app", authorizationId: "public-grant", billingAccountId: "public-sponsor",
    expiresAt: Date.now() + 60_000, permissions: ["agent.use"], allowedTools: [],
  };
}

describe("public entrance namespace (pure policy)", () => {
  it("accepts an explicit public audience without pretending it is a personal account", () => {
    expect(() => assertExecutionIdentity(identity())).not.toThrow();
  });

  it("rejects a public scope mixed with private ownership or tenancy", () => {
    for (const extra of [{ tenantId: "tenant-a" }, { ownerUserId: "visitor-a" }]) {
      expect(() => assertExecutionIdentity({ ...identity(), space: { ...identity().space, ...extra } })).toThrow();
    }
    expect(() => assertExecutionIdentity({ ...identity(), space: { kind: "public", id: "company-public" } })).toThrow();
  });

  it("keeps visitors, audiences and private spaces distinct", () => {
    const base = identity();
    const variants: ExecutionIdentity[] = [
      base,
      { ...base, actorUserId: "visitor-b" },
      { ...base, space: { kind: "public", id: "company-public", audience: "other-app" } },
      { ...base, space: { kind: "personal", id: "company-public", ownerUserId: "visitor-a" } },
      { ...base, space: { kind: "organization", id: "company-public", tenantId: "tenant-a" } },
    ];
    expect(new Set(variants.map(executionScopeKey)).size).toBe(variants.length);
  });
});
