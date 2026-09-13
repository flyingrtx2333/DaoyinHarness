import type { Pool } from "pg";
import { PlatformMemoryEmbeddingProvider, PostgresHybridMemoryRetriever } from "./memory-retrieval-hybrid.js";
import { LexicalMemoryRetriever } from "./memory-retrieval-lexical.js";
import type { MemoryRetriever } from "./memory-retrieval.js";

export type MemoryRetrievalMode = "lexical" | "hybrid";

export interface MemoryRetrieverConfig {
  readonly platformUrl?: string;
  readonly appServiceToken?: string;
  readonly mode?: string;
  readonly vectorMinScore?: number;
}

/**
 * Explicit startup selection keeps retrieval policy outside Agent Core. Unknown
 * modes fail closed instead of silently changing recall behavior.
 */
export function createConfiguredMemoryRetriever(pool: Pool, options: MemoryRetrieverConfig = {}): MemoryRetriever {
  const mode = (options.mode ?? process.env.DAOYIN_MEMORY_RETRIEVER ?? "lexical").trim().toLocaleLowerCase();
  if (mode === "lexical") return new LexicalMemoryRetriever();
  if (mode === "hybrid") {
    if (!options.platformUrl || !options.appServiceToken) throw new Error("Hybrid memory retrieval requires the private platform embedding bridge.");
    const provider = new PlatformMemoryEmbeddingProvider(options.platformUrl, options.appServiceToken);
    return new PostgresHybridMemoryRetriever(pool, provider, provider,
      options.vectorMinScore === undefined ? {} : { vectorMinScore: options.vectorMinScore });
  }
  throw new Error(`Unsupported DAOYIN_MEMORY_RETRIEVER mode: ${mode || "<empty>"}.`);
}
