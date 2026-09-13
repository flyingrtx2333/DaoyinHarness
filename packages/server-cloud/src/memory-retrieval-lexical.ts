import { recallRelevance, rankMemoryHits } from "./memory-agent-policy.js";
import type { RecalledMemory } from "./memory-policy.js";
import type { MemoryRetrievalRequest, SynchronousMemoryRetriever } from "./memory-retrieval.js";

/** Production-compatible lexical scorer extracted from the repositories. */
export class LexicalMemoryRetriever implements SynchronousMemoryRetriever {
  public readonly id = "lexical-v1";

  public recall(input: MemoryRetrievalRequest): RecalledMemory[] {
    const hits: RecalledMemory[] = [];
    for (const candidate of input.candidates) {
      const relevance = recallRelevance(candidate.memory, input.query, input.includeDefaults);
      if (relevance !== null) hits.push({ ...candidate, ...relevance });
    }
    return rankMemoryHits(hits, input.limit);
  }
}
