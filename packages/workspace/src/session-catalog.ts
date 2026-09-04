import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { LocalSessionSummary } from "@daoyin/harness-protocol";

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

interface SessionCatalogDocument {
  schemaVersion: 1;
  sessions: LocalSessionSummary[];
}

function assertSafeId(id: string): void {
  if (!SAFE_ID.test(id)) {
    throw new Error("sessionId must contain only letters, numbers, underscores, or hyphens.");
  }
}

function normalizeTitle(title: string | undefined): string {
  const normalized = title?.trim().replace(/\s+/gu, " ") ?? "";
  return normalized.length > 0 ? normalized.slice(0, 80) : "新对话";
}

function sortSessions(sessions: LocalSessionSummary[]): LocalSessionSummary[] {
  return [...sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export class JsonSessionCatalog {
  readonly #directory: string;
  readonly #file: string;
  #queue: Promise<void> = Promise.resolve();

  public constructor(directory: string) {
    this.#directory = path.resolve(directory);
    this.#file = path.join(this.#directory, "sessions.json");
  }

  public async list(): Promise<LocalSessionSummary[]> {
    await this.#queue;
    const document = await this.#read();
    return sortSessions(document.sessions);
  }

  public async get(sessionId: string): Promise<LocalSessionSummary | undefined> {
    assertSafeId(sessionId);
    await this.#queue;
    const document = await this.#read();
    return document.sessions.find((session) => session.id === sessionId);
  }

  public async create(title?: string): Promise<LocalSessionSummary> {
    let result: LocalSessionSummary | undefined;
    await this.#mutate((document) => {
      const now = new Date().toISOString();
      result = {
        id: `ses_${crypto.randomUUID().replaceAll("-", "")}`,
        title: normalizeTitle(title),
        createdAt: now,
        updatedAt: now,
        lastEventSeq: 0,
        activeTurnId: null,
      };
      document.sessions.push(result);
    });
    if (result === undefined) throw new Error("Session creation completed without a result.");
    return result;
  }

  public async update(
    sessionId: string,
    patch: Partial<Pick<LocalSessionSummary, "title" | "updatedAt" | "lastEventSeq" | "activeTurnId">>,
  ): Promise<LocalSessionSummary> {
    assertSafeId(sessionId);
    let result: LocalSessionSummary | undefined;
    await this.#mutate((document) => {
      const index = document.sessions.findIndex((session) => session.id === sessionId);
      if (index < 0) throw Object.assign(new Error("Session not found."), { code: "SESSION_NOT_FOUND" });
      const current = document.sessions[index];
      if (current === undefined) throw new Error("Session index became invalid.");
      result = {
        ...current,
        ...patch,
        title: patch.title === undefined ? current.title : normalizeTitle(patch.title),
      };
      document.sessions[index] = result;
    });
    if (result === undefined) throw new Error("Session update completed without a result.");
    return result;
  }

  async #mutate(mutator: (document: SessionCatalogDocument) => void): Promise<void> {
    const operation = this.#queue.then(async () => {
      const document = await this.#read();
      mutator(document);
      await this.#write(document);
    });
    this.#queue = operation.catch(() => undefined);
    await operation;
  }

  async #read(): Promise<SessionCatalogDocument> {
    try {
      const raw = await readFile(this.#file, "utf8");
      const parsed = JSON.parse(raw) as SessionCatalogDocument;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.sessions)) {
        throw new Error("Session catalog has an unsupported shape.");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: 1, sessions: [] };
      }
      throw error;
    }
  }

  async #write(document: SessionCatalogDocument): Promise<void> {
    await mkdir(this.#directory, { recursive: true });
    const temporary = path.join(this.#directory, `.sessions.${crypto.randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, this.#file);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}
