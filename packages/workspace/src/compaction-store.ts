import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import type { SessionCompaction } from "@daoyin/harness-protocol";

const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/u;

import type { AppendCompactionInput, SessionCompactionStore } from "@daoyin/harness-contracts";
export type { AppendCompactionInput, SessionCompactionStore } from "@daoyin/harness-contracts";

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${label} must contain only letters, numbers, underscores, or hyphens.`);
}

export class JsonlCompactionStore implements SessionCompactionStore {
  readonly #directory: string;
  readonly #queues = new Map<string, Promise<void>>();

  public constructor(directory: string) {
    this.#directory = path.resolve(directory);
  }

  public async append(input: AppendCompactionInput): Promise<SessionCompaction> {
    assertSafeId(input.sessionId, "sessionId");
    if (!Number.isSafeInteger(input.sourceStartSeq) || input.sourceStartSeq < 1) throw new Error("sourceStartSeq must be a positive integer.");
    if (!Number.isSafeInteger(input.sourceEndSeq) || input.sourceEndSeq < input.sourceStartSeq) throw new Error("sourceEndSeq must be greater than or equal to sourceStartSeq.");
    const summary = input.summary.trim();
    if (!summary) throw new Error("Compaction summary cannot be empty.");
    if (summary.length > 24_000) throw new Error("Compaction summary exceeds the storage limit.");
    const strategy = input.strategy.trim().slice(0, 80);
    if (!strategy) throw new Error("Compaction strategy cannot be empty.");

    const record: SessionCompaction = {
      id: `cmp_${crypto.randomUUID().replaceAll("-", "")}`,
      sessionId: input.sessionId,
      sourceStartSeq: input.sourceStartSeq,
      sourceEndSeq: input.sourceEndSeq,
      summary,
      strategy,
      createdAt: new Date().toISOString(),
    };

    const prior = this.#queues.get(input.sessionId) ?? Promise.resolve();
    const operation = prior.then(async () => {
      const previous = (await this.#readList(input.sessionId)).at(-1);
      if (previous !== undefined && record.sourceEndSeq <= previous.sourceEndSeq) {
        throw Object.assign(new Error("Compaction does not advance the covered event range."), { code: "COMPACTION_NOT_ADVANCED" });
      }
      await mkdir(this.#directory, { recursive: true });
      const handle = await open(this.#pathFor(input.sessionId), "a", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    this.#queues.set(input.sessionId, operation);
    try {
      await operation;
    } finally {
      if (this.#queues.get(input.sessionId) === operation) this.#queues.delete(input.sessionId);
    }
    return record;
  }

  public async list(sessionId: string): Promise<SessionCompaction[]> {
    assertSafeId(sessionId, "sessionId");
    const queued = this.#queues.get(sessionId);
    if (queued !== undefined) await queued.catch(() => undefined);
    return this.#readList(sessionId);
  }

  public async latest(sessionId: string): Promise<SessionCompaction | undefined> {
    const records = await this.list(sessionId);
    return records.at(-1);
  }

  async #readList(sessionId: string): Promise<SessionCompaction[]> {
    try {
      const text = await readFile(this.#pathFor(sessionId), "utf8");
      const records: SessionCompaction[] = [];
      for (const [index, line] of text.split("\n").entries()) {
        if (!line.trim()) continue;
        try {
          records.push(JSON.parse(line) as SessionCompaction);
        } catch (error) {
          throw new Error(`Compaction store contains invalid JSON at line ${String(index + 1)}.`, { cause: error });
        }
      }
      return records.sort((left, right) => left.sourceEndSeq - right.sourceEndSeq);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  #pathFor(sessionId: string): string {
    return path.join(this.#directory, `${sessionId}.jsonl`);
  }
}
