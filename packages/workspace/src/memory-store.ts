import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import type { MemoryKind, MemoryRecord, MemoryScope, MemorySearchHit } from "@daoyin/harness-protocol";

const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/u;
const MAX_CONTENT_CHARACTERS = 6_000;
const MAX_KEYWORDS = 32;
const MAX_KEYWORD_CHARACTERS = 96;
const MAX_SOURCE_EVENTS = 64;

export interface AppendMemoryInput {
  accountId: string;
  scope: MemoryScope;
  scopeId: string;
  kind: MemoryKind;
  content: string;
  keywords?: string[];
  confidence?: number;
  sourceEventIds: string[];
  supersedes?: string | null;
  tombstone?: boolean;
}

export interface MemorySearchInput {
  accountId: string;
  sessionId: string;
  resourceScopeId: string;
  query: string;
  limit?: number;
}

export interface MemoryStore {
  append(input: AppendMemoryInput): Promise<MemoryRecord>;
  get(memoryId: string): Promise<MemoryRecord | undefined>;
  listActive(accountId: string): Promise<MemoryRecord[]>;
  search(input: MemorySearchInput): Promise<MemorySearchHit[]>;
}

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${label} must contain only letters, numbers, underscores, or hyphens.`);
}

function normalizedContent(content: string, tombstone: boolean): string {
  const value = content.trim().replaceAll("\u0000", "");
  if (!tombstone && value.length === 0) throw new Error("Memory content cannot be empty.");
  if (value.length > MAX_CONTENT_CHARACTERS) throw new Error(`Memory content exceeds ${String(MAX_CONTENT_CHARACTERS)} characters.`);
  return tombstone ? "" : value;
}

function normalizedKeywords(keywords: readonly string[] | undefined): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const keyword of keywords ?? []) {
    const value = keyword.trim().normalize("NFKC").slice(0, MAX_KEYWORD_CHARACTERS);
    const key = value.toLocaleLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
    if (result.length >= MAX_KEYWORDS) break;
  }
  return result;
}

function normalizedConfidence(value: number | undefined): number {
  if (value === undefined) return 0.85;
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("Memory confidence must be between 0 and 1.");
  return Math.round(value * 1000) / 1000;
}

function activeRecords(records: readonly MemoryRecord[]): MemoryRecord[] {
  const superseded = new Set(records.map((record) => record.supersedes).filter((id): id is string => typeof id === "string"));
  return records.filter((record) => !superseded.has(record.id) && !record.tombstone);
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

function searchTokens(value: string): Set<string> {
  const normalized = normalizeSearchText(value);
  const tokens = new Set<string>();
  for (const match of normalized.matchAll(/[\p{L}\p{N}_-]{2,}/gu)) tokens.add(match[0]);
  for (const run of normalized.match(/\p{Script=Han}+/gu) ?? []) {
    for (const character of run) tokens.add(character);
    for (let index = 0; index < run.length - 1; index += 1) tokens.add(run.slice(index, index + 2));
  }
  return tokens;
}

function recordAllowed(record: MemoryRecord, input: MemorySearchInput): boolean {
  if (record.accountId !== input.accountId) return false;
  if (record.scope === "account") return record.scopeId === input.accountId;
  if (record.scope === "session") return record.scopeId === input.sessionId;
  return record.scopeId === input.resourceScopeId;
}

function scoreRecord(record: MemoryRecord, input: MemorySearchInput): MemorySearchHit | null {
  const query = normalizeSearchText(input.query);
  if (!query) return null;
  const queryTokens = searchTokens(query);
  const recordText = normalizeSearchText(`${record.content} ${record.keywords.join(" ")}`);
  const recordTokens = searchTokens(recordText);
  const reasons: string[] = [];
  let score = 0;

  if (recordText.includes(query)) {
    score += 8;
    reasons.push("phrase");
  }
  let overlap = 0;
  for (const token of queryTokens) {
    if (recordTokens.has(token)) overlap += 1;
  }
  if (overlap > 0) {
    score += Math.min(8, overlap * 1.6);
    reasons.push(`token_overlap:${String(overlap)}`);
  }
  const keywordTokens = new Set(record.keywords.flatMap((keyword) => [...searchTokens(keyword)]));
  let keywordOverlap = 0;
  for (const token of queryTokens) if (keywordTokens.has(token)) keywordOverlap += 1;
  if (keywordOverlap > 0) {
    score += Math.min(6, keywordOverlap * 2.2);
    reasons.push(`keyword_overlap:${String(keywordOverlap)}`);
  }

  if (record.scope === "session") score += 1.8;
  else if (record.scope === "resource") score += 1.1;
  else score += 0.6;
  score += record.confidence * 1.4;

  const ageMs = Math.max(0, Date.now() - Date.parse(record.createdAt));
  if (Number.isFinite(ageMs)) score += 1.2 / (1 + ageMs / 2_592_000_000);

  if (score < 3.2 || (overlap === 0 && !recordText.includes(query))) return null;
  return { record, score: Math.round(score * 1000) / 1000, reasons };
}

export class JsonlMemoryStore implements MemoryStore {
  readonly #file: string;
  #queue: Promise<void> = Promise.resolve();

  public constructor(file: string) {
    this.#file = path.resolve(file);
  }

  public async append(input: AppendMemoryInput): Promise<MemoryRecord> {
    assertSafeId(input.accountId, "accountId");
    assertSafeId(input.scopeId, "scopeId");
    for (const sourceEventId of input.sourceEventIds.slice(0, MAX_SOURCE_EVENTS)) assertSafeId(sourceEventId, "sourceEventId");
    const sourceEventIds = [...new Set(input.sourceEventIds)].slice(0, MAX_SOURCE_EVENTS);
    if (sourceEventIds.length === 0) throw Object.assign(new Error("Memory requires source event provenance."), { code: "MEMORY_PROVENANCE_REQUIRED" });
    if (input.supersedes) assertSafeId(input.supersedes, "supersedes");
    const tombstone = input.tombstone ?? false;
    const record: MemoryRecord = {
      id: `mem_${crypto.randomUUID().replaceAll("-", "")}`,
      accountId: input.accountId,
      scope: input.scope,
      scopeId: input.scopeId,
      kind: input.kind,
      content: normalizedContent(input.content, tombstone),
      keywords: normalizedKeywords(input.keywords),
      confidence: normalizedConfidence(input.confidence),
      sourceEventIds,
      createdAt: new Date().toISOString(),
      supersedes: input.supersedes ?? null,
      tombstone,
    };

    const operation = this.#queue.then(async () => {
      if (record.supersedes !== null) {
        const records = await this.#readAll();
        const prior = records.find((candidate) => candidate.id === record.supersedes);
        if (prior === undefined) throw Object.assign(new Error("Memory to supersede does not exist."), { code: "MEMORY_NOT_FOUND" });
        if (prior.accountId !== record.accountId || prior.scope !== record.scope || prior.scopeId !== record.scopeId) {
          throw Object.assign(new Error("Memory belongs to a different account or scope."), { code: "MEMORY_SCOPE_DENIED" });
        }
        if (records.some((candidate) => candidate.supersedes === prior.id)) {
          throw Object.assign(new Error("Memory has already been superseded."), { code: "MEMORY_ALREADY_SUPERSEDED" });
        }
      }
      await mkdir(path.dirname(this.#file), { recursive: true });
      const handle = await open(this.#file, "a", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    this.#queue = operation.catch(() => undefined);
    await operation;
    return record;
  }

  public async get(memoryId: string): Promise<MemoryRecord | undefined> {
    assertSafeId(memoryId, "memoryId");
    await this.#queue;
    return (await this.#readAll()).find((record) => record.id === memoryId);
  }

  public async listActive(accountId: string): Promise<MemoryRecord[]> {
    assertSafeId(accountId, "accountId");
    await this.#queue;
    return activeRecords((await this.#readAll()).filter((record) => record.accountId === accountId));
  }

  public async search(input: MemorySearchInput): Promise<MemorySearchHit[]> {
    assertSafeId(input.accountId, "accountId");
    assertSafeId(input.sessionId, "sessionId");
    assertSafeId(input.resourceScopeId, "resourceScopeId");
    const limit = Math.max(1, Math.min(12, input.limit ?? 5));
    const records = (await this.listActive(input.accountId)).filter((record) => recordAllowed(record, input));
    return records
      .map((record) => scoreRecord(record, input))
      .filter((hit): hit is MemorySearchHit => hit !== null)
      .sort((left, right) => right.score - left.score || right.record.createdAt.localeCompare(left.record.createdAt))
      .slice(0, limit);
  }

  async #readAll(): Promise<MemoryRecord[]> {
    try {
      const text = await readFile(this.#file, "utf8");
      const records: MemoryRecord[] = [];
      for (const [index, line] of text.split("\n").entries()) {
        if (!line.trim()) continue;
        try {
          records.push(JSON.parse(line) as MemoryRecord);
        } catch (error) {
          throw new Error(`Memory store contains invalid JSON at line ${String(index + 1)}.`, { cause: error });
        }
      }
      return records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
