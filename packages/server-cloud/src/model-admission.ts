import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CloudError } from "./repository.js";

interface AdmissionRequest {
  sessionId: string; runId: string; operationId: string; kind: "model" | "capability"; input: unknown;
}
interface Policy {
  schemaVersion: 1; expiresAt: number; sessionIds: string[]; maxRequests: number; maxMicroCny: number;
  provider: string; model: string; inputMicroCnyPerMillion: number; outputMicroCnyPerMillion: number;
  maxOutputTokens: number; additionalInputTokenBound: number;
}
interface Reservation {
  runId: string; operationId: string; kind: AdmissionRequest["kind"]; inputDigest: string;
  reservedMicroCny: number; settledMicroCny?: number; createdAt: string;
}
interface Ledger { schemaVersion: 1; reservations: Reservation[] }
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const integer = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/u.test(value);

function policy(value: unknown): Policy {
  if (!object(value) || value.schemaVersion !== 1 || !integer(value.expiresAt, 1, Number.MAX_SAFE_INTEGER) ||
      !Array.isArray(value.sessionIds) || value.sessionIds.length > 200 || !value.sessionIds.every(identifier) ||
      !integer(value.maxRequests, 1, 10000) || !integer(value.maxMicroCny, 1, 1_000_000_000) ||
      !integer(value.inputMicroCnyPerMillion, 0, 1_000_000_000) || !integer(value.outputMicroCnyPerMillion, 0, 1_000_000_000) ||
      !integer(value.maxOutputTokens, 1, 100000) || !integer(value.additionalInputTokenBound, 0, 1_000_000) ||
      !identifier(value.provider) || !identifier(value.model)) throw new Error("Invalid trusted model admission policy.");
  return value as unknown as Policy;
}

function ledger(value: unknown): Ledger {
  if (!object(value) || value.schemaVersion !== 1 || !Array.isArray(value.reservations) || value.reservations.length > 10000 ||
      !value.reservations.every(item => object(item) && identifier(item.runId) && identifier(item.operationId) &&
        ["model", "capability"].includes(String(item.kind)) && typeof item.inputDigest === "string" && /^[a-f0-9]{64}$/u.test(item.inputDigest) &&
        integer(item.reservedMicroCny, 0, 1_000_000_000) && (item.settledMicroCny === undefined || integer(item.settledMicroCny, 0, 1_000_000_000)) &&
        typeof item.createdAt === "string")) throw new Error("Invalid model admission ledger; retained reservations require inspection.");
  const result = value as unknown as Ledger;
  if (new Set(result.reservations.map(item => `${item.runId}:${item.operationId}`)).size !== result.reservations.length) throw new Error("Conflicting model reservations.");
  return result;
}

/** Optional operator-owned admission policy. Never read policy paths or prices from client inputs.
 * The ledger contains request digests and conservative reservations, never model text or credentials.
 * A controller may settle a reservation only from actual priced usage; unknown outcomes retain it.
 */
export function fileModelAdmission(policyPath: string, ledgerPath: string): (request: AdmissionRequest, signal: AbortSignal) => Promise<void> {
  if (!isAbsolute(policyPath) || !isAbsolute(ledgerPath) || policyPath === ledgerPath) throw new Error("Model admission paths must be separate absolute trusted paths.");
  return async (request, signal) => {
    signal.throwIfAborted();
    let configured: Policy;
    try { configured = policy(JSON.parse(await readFile(policyPath, "utf8"))); }
    catch { throw new CloudError(503, "MODEL_ADMISSION_UNAVAILABLE", "模型请求额度预留不可用；本次请求未发出。"); }
    if (!configured.sessionIds.includes(request.sessionId)) return;
    if (configured.expiresAt <= Date.now()) throw new CloudError(429, "MODEL_ADMISSION_EXPIRED", "模型验证额度已到期，进展已保留。");
    const lockPath = ledgerPath + ".lock";
    const deadline = performance.now() + 5000;
    while (true) {
      signal.throwIfAborted();
      try { await mkdir(lockPath, { mode: 0o700 }); break; }
      catch (error) {
        if (!object(error) || error.code !== "EEXIST" || performance.now() >= deadline) throw new CloudError(503, "MODEL_ADMISSION_UNAVAILABLE", "模型额度记录正在处理或不可用；本次请求未发出。");
        await delay(50, undefined, { signal });
      }
    }
    try {
      const current = ledger(JSON.parse(await readFile(ledgerPath, "utf8")));
      const bytes = Buffer.from(JSON.stringify(request.input), "utf8");
      const inputDigest = createHash("sha256").update(bytes).digest("hex");
      const previous = current.reservations.find(item => item.runId === request.runId && item.operationId === request.operationId);
      // No replay of a reserved request, including an uncertain outcome.
      if (previous !== undefined) throw new CloudError(409, "MODEL_ADMISSION_UNCERTAIN", "原模型请求已有额度回执，不能重复发出。");
      // One UTF-8 byte is a conservative token upper bound for the configured byte-token model.
      // Additional platform-owned prompt material must have an independently bounded allowance.
      const amount = Math.ceil(((bytes.byteLength + configured.additionalInputTokenBound) * configured.inputMicroCnyPerMillion +
        configured.maxOutputTokens * configured.outputMicroCnyPerMillion) / 1_000_000);
      const spent = current.reservations.reduce((sum, item) => sum + (item.settledMicroCny ?? item.reservedMicroCny), 0);
      if (current.reservations.length >= configured.maxRequests || spent + amount > configured.maxMicroCny) {
        throw new CloudError(429, "MODEL_ADMISSION_EXHAUSTED", "本轮验证调用或费用预留不足，已保存进展，等待用户继续。");
      }
      current.reservations.push({ runId: request.runId, operationId: request.operationId, kind: request.kind, inputDigest,
        reservedMicroCny: amount, createdAt: new Date().toISOString() });
      const temporary = ledgerPath + ".next-" + randomUUID();
      try { await writeFile(temporary, JSON.stringify(current) + "\n", { mode: 0o600, flag: "wx" }); await rename(temporary, ledgerPath); }
      finally { await rm(temporary, { force: true }); }
      signal.throwIfAborted();
    } catch (error) {
      if (error instanceof CloudError) throw error;
      signal.throwIfAborted();
      throw new CloudError(503, "MODEL_ADMISSION_UNAVAILABLE", "模型费用预留未完成；本次请求未发出。");
    } finally { await rm(lockPath, { recursive: true }); }
  };
}
