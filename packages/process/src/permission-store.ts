import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import type { ProcessPermissionRequest, ProcessRisk } from "@daoyin/harness-protocol";

const SAFE_ID = /^[A-Za-z0-9_-]{1,180}$/u;

export interface RequestProcessPermissionInput {
  accountId: string;
  resourceScopeId: string;
  sessionId: string;
  turnId: string;
  operation: string;
  displayCommand: string;
  fingerprint: string;
  risk: ProcessRisk;
  reason: string;
}

export interface ProcessPermissionStore {
  request(input: RequestProcessPermissionInput): Promise<ProcessPermissionRequest>;
  list(accountId: string, resourceScopeId: string, sessionId?: string): Promise<ProcessPermissionRequest[]>;
  get(requestId: string): Promise<ProcessPermissionRequest | undefined>;
  decide(requestId: string, accountId: string, resourceScopeId: string, approve: boolean): Promise<ProcessPermissionRequest>;
  consumeApproved(fingerprint: string, accountId: string, resourceScopeId: string, sessionId: string): Promise<ProcessPermissionRequest | undefined>;
}

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${label} must contain only safe identifier characters.`);
}

function fingerprintKey(input: Pick<RequestProcessPermissionInput, "accountId" | "resourceScopeId" | "sessionId" | "fingerprint">): string {
  return createHash("sha256").update(`${input.accountId}\n${input.resourceScopeId}\n${input.sessionId}\n${input.fingerprint}`).digest("hex");
}

export class JsonlProcessPermissionStore implements ProcessPermissionStore {
  readonly #file: string;
  #queue: Promise<void> = Promise.resolve();

  public constructor(file: string) {
    this.#file = path.resolve(file);
  }

  public async request(input: RequestProcessPermissionInput): Promise<ProcessPermissionRequest> {
    for (const [label, value] of Object.entries({ accountId: input.accountId, resourceScopeId: input.resourceScopeId, sessionId: input.sessionId, turnId: input.turnId })) {
      assertSafeId(value, label);
    }
    if (!input.operation.trim() || !input.displayCommand.trim() || !input.fingerprint.trim() || !input.reason.trim()) {
      throw new Error("Process permission request is missing required context.");
    }

    let result: ProcessPermissionRequest | undefined;
    const operation = this.#queue.then(async () => {
      const current = await this.#latest();
      const key = fingerprintKey(input);
      const reusable = current.find((request) =>
        fingerprintKey(request) === key && (request.status === "pending" || request.status === "approved" || request.status === "denied"),
      );
      if (reusable !== undefined) {
        result = reusable;
        return;
      }
      const createdAt = new Date().toISOString();
      const request: ProcessPermissionRequest = {
        id: `perm_${crypto.randomUUID().replaceAll("-", "")}`,
        accountId: input.accountId,
        resourceScopeId: input.resourceScopeId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        operation: input.operation,
        displayCommand: input.displayCommand.slice(0, 1_000),
        fingerprint: input.fingerprint,
        risk: input.risk,
        reason: input.reason.slice(0, 1_500),
        status: "pending",
        createdAt,
        decidedAt: null,
      };
      await this.#append(request);
      result = request;
    });
    this.#queue = operation.catch(() => undefined);
    await operation;
    if (result === undefined) throw new Error("Process permission request completed without a result.");
    return result;
  }

  public async list(accountId: string, resourceScopeId: string, sessionId?: string): Promise<ProcessPermissionRequest[]> {
    assertSafeId(accountId, "accountId");
    assertSafeId(resourceScopeId, "resourceScopeId");
    if (sessionId !== undefined) assertSafeId(sessionId, "sessionId");
    await this.#queue;
    return (await this.#latest())
      .filter((request) => request.accountId === accountId && request.resourceScopeId === resourceScopeId && (sessionId === undefined || request.sessionId === sessionId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  public async get(requestId: string): Promise<ProcessPermissionRequest | undefined> {
    assertSafeId(requestId, "requestId");
    await this.#queue;
    return (await this.#latest()).find((request) => request.id === requestId);
  }

  public async decide(requestId: string, accountId: string, resourceScopeId: string, approve: boolean): Promise<ProcessPermissionRequest> {
    assertSafeId(requestId, "requestId");
    assertSafeId(accountId, "accountId");
    assertSafeId(resourceScopeId, "resourceScopeId");
    let result: ProcessPermissionRequest | undefined;
    const operation = this.#queue.then(async () => {
      const current = (await this.#latest()).find((request) => request.id === requestId);
      if (current === undefined) throw Object.assign(new Error("Process permission request does not exist."), { code: "PROCESS_PERMISSION_NOT_FOUND" });
      if (current.accountId !== accountId || current.resourceScopeId !== resourceScopeId) {
        throw Object.assign(new Error("Process permission request is outside the current resource scope."), { code: "PROCESS_PERMISSION_SCOPE_DENIED" });
      }
      if (current.status === "consumed") throw Object.assign(new Error("Process permission was already consumed."), { code: "PROCESS_PERMISSION_CONSUMED" });
      const desired = approve ? "approved" : "denied";
      if (current.status === desired) {
        result = current;
        return;
      }
      const next: ProcessPermissionRequest = {
        ...current,
        status: approve ? "approved" : "denied",
        decidedAt: new Date().toISOString(),
      };
      await this.#append(next);
      result = next;
    });
    this.#queue = operation.catch(() => undefined);
    await operation;
    if (result === undefined) throw new Error("Process permission decision completed without a result.");
    return result;
  }

  public async consumeApproved(fingerprint: string, accountId: string, resourceScopeId: string, sessionId: string): Promise<ProcessPermissionRequest | undefined> {
    assertSafeId(accountId, "accountId");
    assertSafeId(resourceScopeId, "resourceScopeId");
    assertSafeId(sessionId, "sessionId");
    let result: ProcessPermissionRequest | undefined;
    const operation = this.#queue.then(async () => {
      const requests = await this.#latest();
      const current = requests.find((request) =>
        request.accountId === accountId && request.resourceScopeId === resourceScopeId && request.sessionId === sessionId &&
        request.fingerprint === fingerprint && request.status === "approved",
      );
      if (current === undefined) return;
      const consumed: ProcessPermissionRequest = { ...current, status: "consumed", decidedAt: new Date().toISOString() };
      await this.#append(consumed);
      result = consumed;
    });
    this.#queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  async #append(request: ProcessPermissionRequest): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true });
    const handle = await open(this.#file, "a", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(request)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #latest(): Promise<ProcessPermissionRequest[]> {
    try {
      const text = await readFile(this.#file, "utf8");
      const latest = new Map<string, ProcessPermissionRequest>();
      for (const [index, line] of text.split("\n").entries()) {
        if (!line.trim()) continue;
        try {
          const request = JSON.parse(line) as ProcessPermissionRequest;
          latest.set(request.id, request);
        } catch (error) {
          throw new Error(`Process permission store contains invalid JSON at line ${String(index + 1)}.`, { cause: error });
        }
      }
      return [...latest.values()];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
