import type { AgentEvent, TurnStatus } from "@daoyin/harness-protocol";
import type { CloudMemoryRepository } from "./memory-repository.js";
import type { ExecutionIdentity, ExecutionScope, SessionCompactionStore, SessionEventStore } from "@daoyin/harness-contracts";

export class CloudError extends Error {
  public constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message);
    this.name = "CloudError";
  }
}

export interface CloudSession {
  id: string;
  title: string;
  profileId: string;
  profileVersion: string;
  createdAt: string;
  pinnedAt?: string | null;
  archivedAt?: string | null;
}

export const SESSION_ACTIONS = ["pin", "unpin", "archive", "restore", "delete"] as const;
export type SessionAction = typeof SESSION_ACTIONS[number];

export interface CloudRun {
  id: string;
  sessionId: string;
  requestId: string;
  userMessage: string;
  status: TurnStatus;
  finalText: string;
  lastEventSeq: number;
  cancelRequested: boolean;
  authorizationId: string;
  billingAccountId: string;
  createdAt: string;
}

export interface CloudChildInput {
  operationId: string;
  toolCallId: string;
  nodeId: string;
  instruction: string;
}

export interface CloudChildRun {
  parentRunId: string;
  parentSessionId: string;
  toolCallId: string;
  nodeId: string;
  operationId: string;
  run: CloudRun;
}

export interface BoundRunStores {
  events: SessionEventStore;
  compactions: SessionCompactionStore;
  accountId: string;
  scopeId: string;
}

/** SQLite stays synchronous for the local pilot; network-backed stores are asynchronous. */
export type MaybePromise<T> = T | Promise<T>;

/** Every user-facing lookup is scoped. Implementations must atomically claim requests. */
export interface CloudRepository {
  readonly memory?: CloudMemoryRepository;
  /** Atomic child session/run/link admission; absent adapters cannot expose orchestration. */
  acceptChildRun?(identity: ExecutionIdentity, parentRunId: string, input: CloudChildInput): Promise<{ child: CloudChildRun; created: boolean }>;
  listChildRuns?(scope: ExecutionScope, parentRunId: string): Promise<CloudChildRun[]>;
  /** Read-only database/schema/lease probe. Never claims a write transaction was tested. */
  checkReadiness?(): MaybePromise<void>;
  /** Optional for isolated stores; production adapters fence stale executors before external work. */
  assertExecutionOwner?(): MaybePromise<void>;
  /** Invalidation only, emitted after commit. Optional stores retain HTTP replay. */
  subscribeSession?(scope: ExecutionScope, sessionId: string, listener: () => void): () => void;
  createSession(scope: ExecutionScope, input: Omit<CloudSession, "id" | "createdAt">): Promise<CloudSession>;
  listSessions(scope: ExecutionScope): Promise<CloudSession[]>;
  getSession(scope: ExecutionScope, sessionId: string): Promise<CloudSession>;
  /** Desired-state actions are idempotent. null means soft-deleted; events remain immutable. */
  manageSession?(scope: ExecutionScope, sessionId: string, action: SessionAction): Promise<CloudSession | null>;
  acceptRun(identity: ExecutionIdentity, sessionId: string, requestId: string, userMessage: string): Promise<{ run: CloudRun; created: boolean }>;
  getRun(scope: ExecutionScope, runId: string): Promise<CloudRun>;
  findRequest(scope: ExecutionScope, sessionId: string, requestId: string): Promise<CloudRun | undefined>;
  listRuns(scope: ExecutionScope, sessionId: string): Promise<CloudRun[]>;
  readEvents(scope: ExecutionScope, sessionId: string, afterEventSeq: number, limit: number): Promise<AgentEvent[]>;
  bindRun(scope: ExecutionScope, sessionId: string, runId: string): MaybePromise<BoundRunStores>;
  requestCancellation(scope: ExecutionScope, runId: string): Promise<CloudRun>;
  interruptRun(scope: ExecutionScope, runId: string, reason: "runtime_restart" | "runtime_recovery"): Promise<void>;
}
