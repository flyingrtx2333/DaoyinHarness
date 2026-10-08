import { CloudError } from "./repository.js";

const CONTEXT_ERROR_CODES = new Set([
  "MODEL_CONTEXT_TOO_LARGE", "context_length_exceeded", "context_window_exceeded", "model_context_window_exceeded",
]);
const AUTH_ERROR_CODES = new Set([
  "MODEL_AUTH_REQUIRED", "MODEL_ACCESS_DENIED", "MODEL_AUTHORIZATION_FAILED",
  "AUTHORIZATION_REVOKED", "AUTHENTICATION_REQUIRED", "APP_ACCESS_DENIED", "RUN_IDENTITY_MISMATCH",
]);
const MAX_MODEL_ERROR_BYTES = 16_384;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Inspect only explicit structured codes; provider messages are not trusted diagnostics. */
export function structuredModelError(payload: unknown): CloudError | undefined {
  if (!record(payload)) return undefined;
  const candidates = [payload, payload.error, payload.detail].filter(record);
  if (candidates.some((candidate) => typeof candidate.code === "string" && AUTH_ERROR_CODES.has(candidate.code))) {
    return new CloudError(401, "AUTHENTICATION_REQUIRED", "模型执行授权已失效，请重新连接工作台。");
  }
  if (candidates.some((candidate) => typeof candidate.code === "string" && CONTEXT_ERROR_CODES.has(candidate.code))) {
    return new CloudError(400, "MODEL_CONTEXT_TOO_LARGE", "模型上下文超过服务允许的长度，请缩小读取范围后重试。");
  }
  return undefined;
}

/** Bounded error-body inspection. Invalid or oversized bodies never become user-facing text. */
export async function readModelErrorPayload(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const abort = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_MODEL_ERROR_BYTES) return undefined;
      chunks.push(chunk.value);
    }
    signal.throwIfAborted();
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
    catch { return undefined; }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
