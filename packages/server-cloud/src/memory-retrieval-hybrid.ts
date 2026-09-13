import type { ExecutionIdentity } from "@daoyin/harness-contracts";
import type { Pool } from "pg";
import type { DurableMemory, RecalledMemory } from "./memory-policy.js";
import { LexicalMemoryRetriever } from "./memory-retrieval-lexical.js";
import type { MemoryRetrievalRequest, MemoryRetriever } from "./memory-retrieval.js";

export interface MemoryEmbeddingBatch {
  readonly model: string;
  readonly dimensions: number;
  readonly vectors: readonly (readonly number[])[];
}

export interface MemoryEmbeddingProvider {
  embed(identity: ExecutionIdentity, texts: readonly string[]): Promise<MemoryEmbeddingBatch>;
}

export interface MemoryRerankResult { readonly index: number; readonly score: number }
export interface MemoryReranker {
  rerank(identity: ExecutionIdentity, query: string, documents: readonly string[], topN: number): Promise<readonly MemoryRerankResult[]>;
}

export interface HybridMemoryRetrievalOptions {
  lexicalTopK?: number;
  vectorTopK?: number;
  mergeTopK?: number;
  vectorMinScore?: number;
}

const EMBEDDING_VERSION = 1;

function vectorLiteral(vector: readonly number[]): string {
  if (vector.length !== 512 || vector.some((value) => !Number.isFinite(value) || Math.abs(value) > 1000)) throw new Error("Invalid memory embedding.");
  return `[${vector.join(",")}]`;
}

function embeddingText(memory: DurableMemory): string {
  return [memory.key, memory.kind, memory.content, ...memory.keywords].join("\n").slice(0, 8_000);
}

/**
 * Hybrid relevance provider. The repository supplies only ACL-filtered candidates;
 * vector SQL is additionally restricted to those exact candidate ids.
 */
export class PostgresHybridMemoryRetriever implements MemoryRetriever {
  public readonly id = "hybrid-pgvector-v1";
  readonly #lexical = new LexicalMemoryRetriever();
  readonly #lexicalTopK: number;
  readonly #vectorTopK: number;
  readonly #mergeTopK: number;
  readonly #vectorMinScore: number;

  public constructor(private readonly pool: Pool, private readonly embeddings: MemoryEmbeddingProvider,
    private readonly reranker?: MemoryReranker, options: HybridMemoryRetrievalOptions = {}) {
    this.#lexicalTopK = Math.max(1, Math.min(options.lexicalTopK ?? 12, 50));
    this.#vectorTopK = Math.max(1, Math.min(options.vectorTopK ?? 12, 50));
    this.#mergeTopK = Math.max(1, Math.min(options.mergeTopK ?? 20, 50));
    this.#vectorMinScore = Math.max(-1, Math.min(options.vectorMinScore ?? 0.42, 1));
  }

  public async index(identity: ExecutionIdentity, memory: DurableMemory): Promise<void> {
    if (memory.state !== "active" || !memory.content.trim()) return;
    const batch = await this.embeddings.embed(identity, [embeddingText(memory)]);
    if (batch.dimensions !== 512 || batch.vectors.length !== 1) throw new Error("Memory embedding dimensions mismatch.");
    const vector = vectorLiteral(batch.vectors[0]!);
    await this.pool.query(`UPDATE durable_memories SET embedding=$1::vector,embedding_model=$2,embedding_version=$3,embedded_at=$4
      WHERE id=$5 AND revision=$6 AND state='active'`, [vector, batch.model, EMBEDDING_VERSION, Date.now(), memory.id, memory.revision]);
  }

  public async recall(input: MemoryRetrievalRequest): Promise<RecalledMemory[]> {
    const lexical = this.#lexical.recall({ ...input, limit: this.#lexicalTopK });
    if (input.candidates.length === 0) return lexical.slice(0, input.limit);
    let queryEmbedding: MemoryEmbeddingBatch;
    try {
      queryEmbedding = await this.embeddings.embed(input.identity, [input.query.slice(0, 2_000)]);
      if (queryEmbedding.dimensions !== 512 || queryEmbedding.vectors.length !== 1) throw new Error("Embedding response mismatch.");
    } catch {
      return lexical.slice(0, input.limit);
    }
    const ids = input.candidates.map((candidate) => candidate.memory.id);
    const vector = vectorLiteral(queryEmbedding.vectors[0]!);
    let vectorHits: Array<{ id: string; similarity: number }>;
    try {
      const vectorRows = await this.pool.query<{ id: string; similarity: number | string }>(`SELECT id,
          1-(embedding <=> $1::vector) AS similarity
        FROM durable_memories
        WHERE id=ANY($2::text[]) AND state='active' AND embedding IS NOT NULL
          AND embedding_model=$3 AND embedding_version=$4
        ORDER BY embedding <=> $1::vector LIMIT $5`, [vector, ids, queryEmbedding.model, EMBEDDING_VERSION, this.#vectorTopK]);
      vectorHits = vectorRows.rows.map((row) => ({ id: String(row.id), similarity: Number(row.similarity) }))
        .filter((item) => Number.isFinite(item.similarity) && item.similarity >= this.#vectorMinScore);
    } catch {
      return lexical.slice(0, input.limit);
    }
    const candidateById = new Map(input.candidates.map((candidate) => [candidate.memory.id, candidate]));
    const merged = new Map<string, { hit: RecalledMemory; rrf: number; vector?: number }>();
    lexical.forEach((hit, index) => merged.set(hit.memory.id, { hit, rrf: 1 / (60 + index + 1) }));
    vectorHits.forEach((item, index) => {
      const candidate = candidateById.get(item.id);
      if (!candidate) return;
      const existing = merged.get(item.id);
      const rrf = (existing?.rrf ?? 0) + 1 / (60 + index + 1);
      const reasons = [...(existing?.hit.reasons ?? []), `vector:${queryEmbedding.model}:${item.similarity.toFixed(3)}`];
      merged.set(item.id, { hit: { ...candidate, score: Math.round(rrf * 100_000), reasons }, rrf, vector: item.similarity });
    });
    const fused = [...merged.values()].sort((a, b) => b.rrf - a.rrf || (b.vector ?? -1) - (a.vector ?? -1) ||
      b.hit.score - a.hit.score || b.hit.memory.createdAt - a.hit.memory.createdAt || a.hit.memory.id.localeCompare(b.hit.memory.id))
      .slice(0, this.#mergeTopK).map((item) => ({ ...item.hit, score: Math.round(item.rrf * 100_000) }));
    if (this.reranker === undefined || fused.length <= 1) return fused.slice(0, input.limit);
    try {
      const reranked = await this.reranker.rerank(input.identity, input.query,
        fused.map((hit) => embeddingText(hit.memory)), Math.min(input.limit, fused.length));
      const seen = new Set<number>();
      const result: RecalledMemory[] = [];
      for (const item of reranked) {
        if (!Number.isSafeInteger(item.index) || item.index < 0 || item.index >= fused.length || !Number.isFinite(item.score) || seen.has(item.index)) continue;
        seen.add(item.index);
        const hit = fused[item.index]!;
        result.push({ ...hit, score: Math.round(item.score * 100_000), reasons: [...hit.reasons, `rerank:${item.score.toFixed(4)}`] });
      }
      return result.length ? result.slice(0, input.limit) : fused.slice(0, input.limit);
    } catch {
      return fused.slice(0, input.limit);
    }
  }
}

export class PlatformMemoryEmbeddingProvider implements MemoryEmbeddingProvider, MemoryReranker {
  public constructor(private readonly platformUrl: string, private readonly serviceToken: string, private readonly fetcher: typeof fetch = fetch) {
    const url = new URL(platformUrl);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
        (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) ||
        !/^[\x21-\x7e]{32,256}$/u.test(serviceToken)) throw new Error("Invalid memory embedding bridge configuration.");
  }

  public async embed(identity: ExecutionIdentity, texts: readonly string[]): Promise<MemoryEmbeddingBatch> {
    if (texts.length < 1 || texts.length > 32 || texts.some((text) => !text.trim() || text.length > 8_000)) throw new Error("Invalid embedding input.");
    const response = await this.fetcher(new URL("/api/internal/agent-apps/v1/memory-embed", this.platformUrl), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(12_000),
      headers: { "content-type": "application/json", "x-agent-service-token": this.serviceToken },
      body: JSON.stringify({ authorizationId: identity.authorizationId, texts }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error("Memory embedding bridge rejected."); }
    const raw = await response.json() as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid memory embedding response.");
    const value = raw as Record<string, unknown>;
    const vectors = value.vectors;
    if (value.schemaVersion !== 1 || typeof value.model !== "string" || value.model.length > 160 || value.dimensions !== 512 ||
        !Array.isArray(vectors) || vectors.length !== texts.length || vectors.some((vector) => !Array.isArray(vector) || vector.length !== 512 ||
          vector.some((item) => typeof item !== "number" || !Number.isFinite(item)))) throw new Error("Invalid memory embedding response.");
    return { model: value.model, dimensions: 512, vectors: vectors as number[][] };
  }

  public async rerank(identity: ExecutionIdentity, query: string, documents: readonly string[], topN: number): Promise<readonly MemoryRerankResult[]> {
    if (!query.trim() || query.length > 2_000 || documents.length < 1 || documents.length > 20 ||
        documents.some((document) => !document.trim() || document.length > 8_000) || !Number.isSafeInteger(topN) || topN < 1 || topN > documents.length) {
      throw new Error("Invalid memory rerank input.");
    }
    const response = await this.fetcher(new URL("/api/internal/agent-apps/v1/memory-rerank", this.platformUrl), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { "content-type": "application/json", "x-agent-service-token": this.serviceToken },
      body: JSON.stringify({ authorizationId: identity.authorizationId, query, documents, topN }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error("Memory rerank bridge rejected."); }
    const raw = await response.json() as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid memory rerank response.");
    const value = raw as Record<string, unknown>;
    const results = value.results;
    if (value.schemaVersion !== 1 || !Array.isArray(results) || results.length > topN || results.some((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return true;
      const row = item as Record<string, unknown>;
      return !Number.isSafeInteger(row.index) || Number(row.index) < 0 || Number(row.index) >= documents.length ||
        typeof row.score !== "number" || !Number.isFinite(row.score);
    })) throw new Error("Invalid memory rerank response.");
    return results as MemoryRerankResult[];
  }
}
