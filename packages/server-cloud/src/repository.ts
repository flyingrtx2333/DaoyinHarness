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
}

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

export interface BoundRunStores {
  events: SessionEventStore;
  compactions: SessionCompactionStore;
  accountId: string;
  scopeId: string;
}

/** Every user-facing lookup is scoped. Implementations must atomically claim requests. */
export interface CloudRepository {
  readonly memory?: CloudMemoryRepository;
  /** Optional for isolated stores; production adapters fence stale executors before external work. */
  assertExecutionOwner?(): void;
  createSession(scope: ExecutionScope, input: Omit<CloudSession, "id" | "createdAt">): Promise<CloudSession>;
  listSessions(scope: ExecutionScope): Promise<CloudSession[]>;
  getSession(scope: ExecutionScope, sessionId: string): Promise<CloudSession>;
  acceptRun(identity: ExecutionIdentity, sessionId: string, requestId: string, userMessage: string): Promise<{ run: CloudRun; created: boolean }>;
  getRun(scope: ExecutionScope, runId: string): Promise<CloudRun>;
  findRequest(scope: ExecutionScope, sessionId: string, requestId: string): Promise<CloudRun | undefined>;
  listRuns(scope: ExecutionScope, sessionId: string): Promise<CloudRun[]>;
  readEvents(scope: ExecutionScope, sessionId: string, afterEventSeq: number, limit: number): Promise<AgentEvent[]>;
  bindRun(scope: ExecutionScope, sessionId: string, runId: string): BoundRunStores;
  requestCancellation(scope: ExecutionScope, runId: string): Promise<CloudRun>;
  interruptRun(scope: ExecutionScope, runId: string, reason: "runtime_restart" | "runtime_recovery"): Promise<void>;
}
