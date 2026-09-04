import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentEvent, AgentEventType, PendingAgentEvent } from "@daoyin/harness-protocol";

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface SessionEventStore {
  append<TType extends AgentEventType>(event: PendingAgentEvent<TType>): Promise<AgentEvent>;
  read(sessionId: string, afterEventSeq?: number): Promise<AgentEvent[]>;
}

function assertSafeId(id: string, label: string): void {
  if (!SAFE_ID.test(id)) {
    throw new Error(`${label} must contain only letters, numbers, underscores, or hyphens.`);
  }
}

interface ParsedTranscript {
  events: AgentEvent[];
  validText: string;
  truncatedTail: boolean;
}

function parseTranscript(text: string): ParsedTranscript {
  const lines = text.split("\n");
  const events: AgentEvent[] = [];
  let validCharacterCount = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }
    if (line.length === 0) {
      if (index < lines.length - 1) {
        validCharacterCount += 1;
      }
      continue;
    }
    try {
      events.push(JSON.parse(line) as AgentEvent);
      validCharacterCount += line.length;
      if (index < lines.length - 1) {
        validCharacterCount += 1;
      }
    } catch (error) {
      const isTruncatedTail = index === lines.length - 1 && !text.endsWith("\n");
      if (isTruncatedTail) {
        return { events, validText: text.slice(0, validCharacterCount), truncatedTail: true };
      }
      throw new Error(`Transcript contains invalid JSON at line ${String(index + 1)}.`, { cause: error });
    }
  }
  return { events, validText: text, truncatedTail: false };
}

export class JsonlSessionStore implements SessionEventStore {
  readonly #transcriptDirectory: string;
  readonly #queues = new Map<string, Promise<void>>();

  public constructor(transcriptDirectory: string) {
    this.#transcriptDirectory = path.resolve(transcriptDirectory);
  }

  public async append<TType extends AgentEventType>(pending: PendingAgentEvent<TType>): Promise<AgentEvent> {
    assertSafeId(pending.sessionId, "sessionId");
    let result: AgentEvent | undefined;
    const prior = this.#queues.get(pending.sessionId) ?? Promise.resolve();
    const operation = prior.then(async () => {
      const transcript = await this.#readTranscript(pending.sessionId);
      if (transcript.truncatedTail) {
        const repairHandle = await open(this.#pathFor(pending.sessionId), "r+");
        try {
          await repairHandle.truncate(Buffer.byteLength(transcript.validText, "utf8"));
          await repairHandle.sync();
        } finally {
          await repairHandle.close();
        }
      }
      const previousSequence = transcript.events.at(-1)?.eventSeq ?? 0;
      const event = {
        ...pending,
        id: `evt_${crypto.randomUUID()}`,
        eventSeq: previousSequence + 1,
        occurredAt: new Date().toISOString(),
      } as AgentEvent;
      await mkdir(this.#transcriptDirectory, { recursive: true });
      const handle = await open(this.#pathFor(pending.sessionId), "a", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      result = event;
    });
    this.#queues.set(pending.sessionId, operation);
    try {
      await operation;
    } finally {
      if (this.#queues.get(pending.sessionId) === operation) {
        this.#queues.delete(pending.sessionId);
      }
    }
    if (result === undefined) {
      throw new Error("Event append completed without a result.");
    }
    return result;
  }

  public async read(sessionId: string, afterEventSeq = 0): Promise<AgentEvent[]> {
    assertSafeId(sessionId, "sessionId");
    const transcript = await this.#readTranscript(sessionId);
    return transcript.events.filter((event) => event.eventSeq > afterEventSeq);
  }

  async #readTranscript(sessionId: string): Promise<ParsedTranscript> {
    try {
      const text = await readFile(this.#pathFor(sessionId), "utf8");
      return parseTranscript(text);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { events: [], validText: "", truncatedTail: false };
      }
      throw error;
    }
  }

  #pathFor(sessionId: string): string {
    return path.join(this.#transcriptDirectory, `${sessionId}.jsonl`);
  }
}
