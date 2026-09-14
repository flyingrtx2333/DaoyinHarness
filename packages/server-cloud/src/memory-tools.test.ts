import { describe, expect, it, vi } from "vitest";
import type { ExecutionIdentity, SessionEventStore } from "@daoyin/harness-contracts";
import type { MemoryContextRequest } from "@daoyin/harness-agent-core";
import { createCloudMemoryRuntime } from "./memory-tools.js";
import type { CloudMemoryRepository } from "./memory-repository.js";
import type { CloudRun } from "./repository.js";

describe("cloud memory runtime authorization boundary", () => {
  it("does not repeat remote authorization checks for each snapshot assertion", async () => {
    const identity: ExecutionIdentity = {
      actorUserId: "alice",
      space: { kind: "personal", id: "personal-alice", ownerUserId: "alice" },
      appInstallationId: "harness",
      authorizationId: "grant-alice",
      billingAccountId: "payer",
      expiresAt: Date.now() + 60_000,
      permissions: ["agent.use", "memory.read"],
      allowedTools: ["memory_search"],
    };
    const run: CloudRun = {
      id: "run-a",
      sessionId: "session-a",
      requestId: "request-a",
      userMessage: "continue",
      status: "running",
      finalText: "",
      lastEventSeq: 0,
      cancelRequested: false,
      authorizationId: identity.authorizationId,
      billingAccountId: identity.billingAccountId,
      createdAt: new Date().toISOString(),
    };
    const assertCurrent = vi.fn(async () => undefined);
    const prepare = vi.fn(async () => ({ text: "", excludedTurns: [], assertCurrent }));
    const memory = { prepare } as unknown as CloudMemoryRepository;
    const events = {
      read: vi.fn(async () => []),
      append: vi.fn(async () => { throw new Error("not used"); }),
    } as unknown as SessionEventStore;
    const ensureActive = vi.fn(async () => undefined);
    const runtime = createCloudMemoryRuntime({ memory, identity, run, events, profileId: "test", ensureActive });
    const signal = new AbortController().signal;
    const request: MemoryContextRequest = {
      turn: { accountId: "alice", scopeId: "personal-alice", sessionId: run.sessionId, turnId: run.id,
        userMessage: run.userMessage, executionIdentity: identity },
      step: 0,
      priorEvents: [],
      inheritedEvents: [],
      signal,
    };

    const snapshot = await runtime.provider.load(request);
    await snapshot.assertCurrent(signal);
    await snapshot.assertCurrent(signal);

    expect(ensureActive).toHaveBeenCalledTimes(1);
    expect(assertCurrent).toHaveBeenCalledTimes(2);
  });
});
