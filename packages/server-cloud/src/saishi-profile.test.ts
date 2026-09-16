import { expect, it, vi } from "vitest";
import type { ExecutionIdentity } from "@daoyin/harness-contracts";
import { ToolRegistry, type ToolExecutionContext } from "@daoyin/harness-tools/registry";
import { createSaishiProfile, parseSaishiResult } from "./saishi-profile.js";

const name = "saishi_list_images";
const result = { schemaVersion: 1, tool: name, readOnly: true, untrusted: true, data: { items: [{ id: 3, image_id: 1, event_id: 2, image_kind: "highlight", title: "photo", captured_at: null }], has_more: true, next_after_id: 3 } };
const identity: ExecutionIdentity = { actorUserId: "8", space: { kind: "organization", id: "tenant_7", tenantId: "7" },
  appInstallationId: `saishi-readonly:7:${"a".repeat(24)}`, authorizationId: `sag_${"a".repeat(48)}`, billingAccountId: "saishi:7:8",
  expiresAt: Date.now() + 60000, permissions: ["agent.use", "saishi.events.read", "saishi.materials.read"], allowedTools: [name] };

it("allows image references but rejects media URLs and credentials in persisted results", () => {
  expect(parseSaishiResult(result, name)).toEqual(result);
  expect(() => parseSaishiResult({ ...result, data: { items: [{ image_id: 1, url: "https://private.invalid" }] } }, name)).toThrow();
});

it("prevents repeated pages and unbounded automatic pagination, reset per turn (mocked business API)", async () => {
  const call = vi.fn(async () => result);
  const profile = createSaishiProfile({ id: "saishi-readonly", version: "2", instructions: "Show images", tools: [{ name, description: "Images", requiredPermissions: ["saishi.materials.read"],
    annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { type: "object", additionalProperties: false, required: ["event_id"], properties: { event_id: { type: "integer", minimum: 1 }, after_id: { type: "integer", minimum: 0 } } } }] }, identity, { call, authorize: async () => true });
  const context: ToolExecutionContext = { accountId: "8", scopeId: "scope", sessionId: "session", turnId: "turn", sourceEventIds: [], executionIdentity: identity, toolCallId: "call" };
  const execute = profile.tools[0]!.definition.execute;
  const signal = new AbortController().signal;
  await execute({ event_id: 2 }, signal, context);
  await expect(execute({ event_id: 2 }, signal, context)).resolves.toMatchObject({ ok: false, code: "MEDIA_PAGE_LIMIT", retryable: false });
  await execute({ event_id: 2, after_id: 3 }, signal, context);
  await expect(execute({ event_id: 2, after_id: 6 }, signal, context)).resolves.toMatchObject({ ok: false, code: "MEDIA_PAGE_LIMIT", retryable: false });
  await execute({ event_id: 2 }, signal, { ...context, turnId: "next-turn" });
  expect(call).toHaveBeenCalledTimes(3);
  const registry = new ToolRegistry([profile.tools[0]!.definition], { authorize: async () => true });
  const blocked = await registry.execute({ id: "another", name, input: { event_id: 2 } }, signal, context);
  expect(blocked).toMatchObject({ ok: false, code: "MEDIA_PAGE_LIMIT", message: expect.stringContaining("不重复翻页") });
});

it("accepts reviewed write tools and optional Pydantic fields while preserving mutating evidence", async () => {
  const writeName = "saishi_create_event";
  const writeIdentity: ExecutionIdentity = { ...identity, permissions: ["agent.use", "saishi.events.read", "saishi.events.write"],
    allowedTools: [writeName] };
  const response = { schemaVersion: 1, tool: writeName, readOnly: false, untrusted: true,
    data: { id: 9, tenant_id: 7, competition_id: 2, competition_name: "Cup", title: "Night race", description: null, status: 0,
      orienteering_map_published: false } };
  const call = vi.fn(async () => response);
  const schema = { type: "object", additionalProperties: false, required: ["competition_id", "title", "idempotency_key"], properties: {
    competition_id: { type: "integer", minimum: 1 }, title: { type: "string", minLength: 1, maxLength: 255 },
    idempotency_key: { type: "string", minLength: 8, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$" },
    description: { anyOf: [{ type: "string", maxLength: 2000 }, { type: "null" }], default: null },
  } };
  const profile = createSaishiProfile({ id: "saishi-readonly", version: "2", instructions: "Write only after confirmation", tools: [{
    name: writeName, description: "Create event", requiredPermissions: ["saishi.events.write"], inputSchema: schema,
    annotations: { readOnlyHint: false, destructiveHint: false },
  }] }, writeIdentity, { call, authorize: async () => true });
  expect(profile.version).toBe("2");
  expect(profile.tools[0]!.definition.mutating).toBe(true);
  expect(profile.tools[0]!.validateInput({ competition_id: 2, title: "Night race", idempotency_key: "night-001", description: null })).toBe(true);
  const output = await profile.tools[0]!.definition.execute({ competition_id: 2, title: "Night race", idempotency_key: "night-001" },
    new AbortController().signal, { accountId: "8", scopeId: "scope", sessionId: "session", turnId: "turn", sourceEventIds: [],
      executionIdentity: writeIdentity, toolCallId: "call" });
  expect(output).toMatchObject({ ok: true, summary: "赛事操作已完成", evidence: { result: response } });
});
