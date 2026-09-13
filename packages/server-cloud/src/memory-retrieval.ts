import type { ExecutionIdentity } from "@daoyin/harness-contracts";
import type { MaybePromise } from "./repository.js";
import type { DurableMemory, MemoryReference, RecalledMemory } from "./memory-policy.js";

/**
 * A candidate has already passed repository-owned namespace, ACL, share, state,
 * expiry and revision visibility checks. Retrievers must never widen that set.
 */
export interface MemoryRecallCandidate {
  readonly memory: DurableMemory;
  readonly reference: MemoryReference;
}

export interface MemoryRetrievalRequest {
  readonly identity: ExecutionIdentity;
  readonly query: string;
  readonly limit: number;
  readonly includeDefaults: boolean;
  readonly candidates: readonly MemoryRecallCandidate[];
}

/**
 * Relevance-only seam. Storage, authorization, provenance and transactions stay
 * in the repository. A future vector implementation receives only candidates
 * that the repository has already admitted for this exact identity.
 */
export interface MemoryRetriever {
  readonly id: string;
  recall(input: MemoryRetrievalRequest): MaybePromise<RecalledMemory[]>;
  /** Best-effort relevance index refresh after an active memory commits. Never owns the memory transaction. */
  index?(identity: ExecutionIdentity, memory: DurableMemory): MaybePromise<void>;
}

/** SQLite preparation is intentionally synchronous; local retrievers must be too. */
export interface SynchronousMemoryRetriever extends MemoryRetriever {
  recall(input: MemoryRetrievalRequest): RecalledMemory[];
}
