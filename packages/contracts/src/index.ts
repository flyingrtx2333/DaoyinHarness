import type {
  AgentEvent,
  AgentEventType,
  PendingAgentEvent,
  SessionCompaction,
} from "@daoyin/harness-protocol";

/** Implementations must be bound to an authorized namespace, never a global ID lookup. */
export interface SessionEventStore {
  append<TType extends AgentEventType>(event: PendingAgentEvent<TType>): Promise<AgentEvent>;
  read(sessionId: string, afterEventSeq?: number): Promise<AgentEvent[]>;
}

export interface AppendCompactionInput {
  sessionId: string;
  sourceStartSeq: number;
  sourceEndSeq: number;
  summary: string;
  strategy: string;
}

export interface SessionCompactionStore {
  append(input: AppendCompactionInput): Promise<SessionCompaction>;
  list(sessionId: string): Promise<SessionCompaction[]>;
  latest(sessionId: string): Promise<SessionCompaction | undefined>;
}

export type ExecutionSpace =
  | { readonly kind: "personal"; readonly id: string; readonly ownerUserId: string }
  | { readonly kind: "organization"; readonly id: string; readonly tenantId: string }
  | { readonly kind: "public"; readonly id: string; readonly audience: string };

/** Stable data boundary. A changed grant or payer does not merge or move sessions. */
export interface ExecutionScope {
  readonly actorUserId: string;
  readonly space: ExecutionSpace;
  readonly appInstallationId: string;
}

/**
 * Resolved by a trusted server-side authenticator, NOT parsed from user/tool JSON.
 * Validation below checks shape/expiry; it is not cryptographic authentication.
 * Secrets and downstream credentials must never be included in this object.
 */
export interface ExecutionIdentity extends ExecutionScope {
  readonly authorizationId: string;
  readonly billingAccountId: string;
  readonly expiresAt: number;
  readonly permissions: readonly string[];
  readonly allowedTools: readonly string[];
}

export type MemoryScope =
  | { readonly kind: "session"; readonly scope: ExecutionScope; readonly sessionId: string }
  | { readonly kind: "resource"; readonly scope: ExecutionScope; readonly resourceId: string }
  | { readonly kind: "application"; readonly scope: ExecutionScope }
  | { readonly kind: "personal"; readonly ownerUserId: string }
  | { readonly kind: "organization"; readonly tenantId: string }
  | { readonly kind: "public"; readonly knowledgeBaseId: string };

/** Only an explicit grant may expose personal/resource memory in another application. */
export interface MemoryShareGrant {
  readonly id: string;
  readonly source: MemoryScope;
  readonly target: ExecutionScope;
  readonly purpose: string;
  readonly expiresAt: number;
}

export class ExecutionAccessError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "ExecutionAccessError";
    this.code = code;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/u.test(value);
}

function names(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 256 && value.every(identifier);
}

export function assertExecutionScope(value: unknown): asserts value is ExecutionScope {
  if (!record(value) || !identifier(value.actorUserId) || !identifier(value.appInstallationId) ||
      !record(value.space) || !identifier(value.space.id)) {
    throw new ExecutionAccessError("EXECUTION_IDENTITY_INVALID", "执行身份不完整。");
  }
  const space = value.space;
  if (space.kind === "personal") {
    if (space.ownerUserId !== value.actorUserId || !identifier(space.ownerUserId) || "tenantId" in space) {
      throw new ExecutionAccessError("EXECUTION_IDENTITY_INVALID", "个人空间身份无效。");
    }
  } else if (space.kind === "organization") {
    if (!identifier(space.tenantId) || "ownerUserId" in space) {
      throw new ExecutionAccessError("EXECUTION_IDENTITY_INVALID", "企业空间身份无效。");
    }
  } else if (space.kind === "public") {
    if (!identifier(space.audience) || "ownerUserId" in space || "tenantId" in space) {
      throw new ExecutionAccessError("EXECUTION_IDENTITY_INVALID", "公开入口不能携带个人或企业空间身份。");
    }
  } else {
    throw new ExecutionAccessError("EXECUTION_IDENTITY_INVALID", "必须明确选择个人、企业或公开入口空间。");
  }
}

export function assertExecutionIdentity(value: unknown, now = Date.now()): asserts value is ExecutionIdentity {
  assertExecutionScope(value);
  // Scope assertion narrows structural fields; the remaining fields still need runtime validation.
  const candidate = value as unknown as Record<string, unknown>;
  if (!identifier(candidate.authorizationId) || !identifier(candidate.billingAccountId) ||
      typeof candidate.expiresAt !== "number" || !Number.isSafeInteger(candidate.expiresAt) ||
      !names(candidate.permissions) || !names(candidate.allowedTools)) {
    throw new ExecutionAccessError("EXECUTION_IDENTITY_INVALID", "授权与付款身份不完整。");
  }
  if (candidate.expiresAt <= now) {
    throw new ExecutionAccessError("EXECUTION_AUTHORIZATION_EXPIRED", "本次授权已失效，请重新授权。");
  }
}

/** Collision-safe tuple, suitable for a bound repository namespace; not a credential. */
export function executionScopeKey(scope: ExecutionScope): string {
  assertExecutionScope(scope);
  return JSON.stringify([
    scope.actorUserId,
    scope.space.kind,
    scope.space.id,
    scope.space.kind === "personal" ? scope.space.ownerUserId
      : scope.space.kind === "organization" ? scope.space.tenantId : scope.space.audience,
    scope.appInstallationId,
  ]);
}

export function sameExecutionScope(left: ExecutionScope, right: ExecutionScope): boolean {
  return executionScopeKey(left) === executionScopeKey(right);
}

/** Copy an authenticator result so later mutation cannot silently broaden a running grant. */
export function snapshotExecutionIdentity(value: ExecutionIdentity): ExecutionIdentity {
  assertExecutionIdentity(value);
  return Object.freeze({
    actorUserId: value.actorUserId,
    space: Object.freeze({ ...value.space }),
    appInstallationId: value.appInstallationId,
    authorizationId: value.authorizationId,
    billingAccountId: value.billingAccountId,
    expiresAt: value.expiresAt,
    permissions: Object.freeze([...value.permissions]),
    allowedTools: Object.freeze([...value.allowedTools]),
  });
}
