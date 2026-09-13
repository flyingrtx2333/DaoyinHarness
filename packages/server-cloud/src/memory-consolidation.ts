import type { ExecutionIdentity } from "@daoyin/harness-contracts";
import type { MaybePromise } from "./repository.js";
import type { MemoryProposal, RecalledMemory } from "./memory-policy.js";

export type MemoryConsolidationRelation = "same_key" | "possible_duplicate" | "needs_review" | "new";

export interface MemoryConsolidationCandidate {
  readonly id: string;
  readonly revision: number;
  readonly key: string;
  readonly relation: MemoryConsolidationRelation;
  readonly similarity: number;
  readonly reasons: readonly string[];
}

export interface MemoryConsolidationAssessment {
  readonly decision: MemoryConsolidationRelation;
  readonly candidates: readonly MemoryConsolidationCandidate[];
  readonly automaticOverwriteAllowed: false;
}

/** Maintenance providers may become model-assisted later; they may never overwrite solely from embedding similarity. */
export interface MemoryConsolidator {
  assess(identity: ExecutionIdentity, proposal: MemoryProposal): MaybePromise<MemoryConsolidationAssessment>;
}

export function strongSemanticSimilarity(hit: RecalledMemory): number | null {
  for (const reason of hit.reasons) {
    const rerank = /^rerank:(-?\d+(?:\.\d+)?)$/u.exec(reason);
    if (rerank && Number(rerank[1]) >= 0.82) return Number(rerank[1]);
    const vector = /^vector:[^:]+:(-?\d+(?:\.\d+)?)$/u.exec(reason);
    if (vector && Number(vector[1]) >= 0.88) return Number(vector[1]);
  }
  return hit.reasons.includes("phrase") && hit.score >= 10 ? 1 : null;
}

/**
 * Deliberately conservative: similarity can prove neither equality nor contradiction.
 * Different-key strong neighbors therefore require review rather than silent merge.
 */
export function assessConsolidationCandidates(proposal: MemoryProposal, hits: readonly RecalledMemory[]): MemoryConsolidationAssessment {
  const candidates: MemoryConsolidationCandidate[] = [];
  for (const hit of hits) {
    const similarity = strongSemanticSimilarity(hit);
    if (hit.memory.key === proposal.key) {
      candidates.push({ id: hit.memory.id, revision: hit.memory.revision, key: hit.memory.key,
        relation: "same_key", similarity: similarity ?? 1, reasons: hit.reasons });
    } else if (similarity !== null) {
      const sameNormalizedContent = hit.memory.content.normalize("NFKC").trim().toLocaleLowerCase() ===
        proposal.content.normalize("NFKC").trim().toLocaleLowerCase();
      candidates.push({ id: hit.memory.id, revision: hit.memory.revision, key: hit.memory.key,
        relation: sameNormalizedContent ? "possible_duplicate" : "needs_review", similarity, reasons: hit.reasons });
    }
  }
  const decision = candidates.some((item) => item.relation === "same_key") ? "same_key"
    : candidates.some((item) => item.relation === "needs_review") ? "needs_review"
    : candidates.some((item) => item.relation === "possible_duplicate") ? "possible_duplicate" : "new";
  return { decision, candidates, automaticOverwriteAllowed: false };
}
