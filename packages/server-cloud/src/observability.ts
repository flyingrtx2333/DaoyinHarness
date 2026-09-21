import { randomBytes } from "node:crypto";
import type { AgentEvent } from "@daoyin/harness-protocol";

export type TelemetryAttribute = string | number | boolean;
export interface TelemetrySpanContext { traceId: string; spanId: string }
export interface TelemetrySpanEnd {
  attributes?: Readonly<Record<string, TelemetryAttribute | undefined>>;
  error?: unknown;
}
export interface TelemetrySpan {
  readonly context: TelemetrySpanContext;
  setAttribute(name: string, value: TelemetryAttribute): void;
  end(result?: TelemetrySpanEnd): void;
}
export interface Telemetry {
  startSpan(name: string, options?: {
    parent?: TelemetrySpanContext;
    attributes?: Readonly<Record<string, TelemetryAttribute | undefined>>;
  }): TelemetrySpan;
  recordAudit(event: AgentEvent): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

interface FinishedSpan {
  traceId: string; spanId: string; parentSpanId: string; name: string;
  startTimeUnixNano: string; endTimeUnixNano: string;
  attributes: Record<string, TelemetryAttribute>; errorType?: string;
}

const hex = (bytes: number): string => randomBytes(bytes).toString("hex");
const safeName = (value: string, max = 120): string => value.replace(/[^A-Za-z0-9_.:/-]/gu, "_").slice(0, max);
const safeAttributes = (values: Readonly<Record<string, TelemetryAttribute | undefined>> = {}): Record<string, TelemetryAttribute> =>
  Object.fromEntries(Object.entries(values).filter(([key, value]) => /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(key) &&
    (typeof value === "string" && value.length <= 240 || typeof value === "number" && Number.isFinite(value) || typeof value === "boolean"))
    .map(([key, value]) => [key, value!]));

const auditSecretKey = /(?:authorization|cookie|credential|password|passwd|secret|token|api[-_]?key|access[-_]?key|reasoning(?:_content)?)/iu;
const auditSecretText = /(?:bearer\s+[a-z0-9._~+/-]{8,}|\bsk-[a-z0-9_-]{8,}\b)/giu;
function safeAuditEvent(event: AgentEvent): AgentEvent {
  return JSON.parse(JSON.stringify(event, (key, value: unknown) => {
    if (auditSecretKey.test(key)) return "[REDACTED]";
    return typeof value === "string" ? value.replace(auditSecretText, "[REDACTED]") : value;
  })) as AgentEvent;
}
function otlpValue(value: TelemetryAttribute): Record<string, string | number | boolean> {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") return Number.isSafeInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  return { stringValue: value };
}

class DisabledTelemetry implements Telemetry {
  public startSpan(): TelemetrySpan {
    return { context: { traceId: "", spanId: "" }, setAttribute: () => undefined, end: () => undefined };
  }
  public recordAudit(): void { /* disabled */ }
  public async flush(): Promise<void> { /* disabled */ }
  public async shutdown(): Promise<void> { /* disabled */ }
}
export const disabledTelemetry: Telemetry = new DisabledTelemetry();

export class OtlpHttpTelemetry implements Telemetry {
  readonly #queue: FinishedSpan[] = [];
  readonly #auditQueue: AgentEvent[] = [];
  readonly #timer: ReturnType<typeof setInterval>;
  #sending: Promise<void> | undefined;
  #closed = false;
  #dropped = 0;
  public constructor(private readonly config: {
    endpoint: URL; token: string; serviceName: string; serviceVersion: string; environment: string;
  }) {
    this.#timer = setInterval(() => { void this.flush(); }, 1_000);
    this.#timer.unref();
  }
  public startSpan(name: string, options: {
    parent?: TelemetrySpanContext;
    attributes?: Readonly<Record<string, TelemetryAttribute | undefined>>;
  } = {}): TelemetrySpan {
    const startedUnix = BigInt(Date.now()) * 1_000_000n;
    const startedHr = process.hrtime.bigint();
    const context = { traceId: options.parent?.traceId || hex(16), spanId: hex(8) };
    const attributes = safeAttributes(options.attributes);
    let ended = false;
    return {
      context,
      setAttribute: (key, value) => { if (!ended) Object.assign(attributes, safeAttributes({ [key]: value })); },
      end: (result = {}) => {
        if (ended) return; ended = true;
        Object.assign(attributes, safeAttributes(result.attributes));
        const elapsed = process.hrtime.bigint() - startedHr;
        const errorType = result.error instanceof Error ? safeName(result.error.name || "Error", 80) : result.error === undefined ? undefined : "UnknownError";
        const span: FinishedSpan = { traceId: context.traceId, spanId: context.spanId,
          parentSpanId: options.parent?.spanId ?? "", name: safeName(name), startTimeUnixNano: String(startedUnix),
          endTimeUnixNano: String(startedUnix + elapsed), attributes, ...(errorType ? { errorType } : {}) };
        if (this.#closed || this.#queue.length >= 2_000) { this.#dropped++; return; }
        this.#queue.push(span);
        if (this.#queue.length >= 64) void this.flush();
      },
    };
  }
  public recordAudit(event: AgentEvent): void {
    if (this.#closed || this.#auditQueue.length >= 5_000) { this.#dropped++; return; }
    this.#auditQueue.push(safeAuditEvent(event));
    if (this.#auditQueue.length >= 64) void this.flush();
  }

  public async flush(): Promise<void> {
    if (this.#sending) return this.#sending;
    if (!this.#queue.length && !this.#auditQueue.length) return;
    const batch = this.#queue.splice(0, 128);
    const auditBatch = this.#auditQueue.splice(0, 128);
    this.#sending = Promise.all([this.#export(batch), this.#exportAudit(auditBatch)]).then(() => undefined)
      .finally(() => { this.#sending = undefined; });
    return this.#sending;
  }
  async #export(spans: FinishedSpan[]): Promise<void> {
    if (!spans.length) return;
    const attributes = [
      { key: "service.name", value: { stringValue: this.config.serviceName } },
      { key: "service.version", value: { stringValue: this.config.serviceVersion } },
      { key: "deployment.environment.name", value: { stringValue: this.config.environment } },
    ];
    const payload = { resourceSpans: [{ resource: { attributes }, scopeSpans: [{
      scope: { name: "@daoyin/harness", version: "1" },
      spans: spans.map(span => ({ traceId: span.traceId, spanId: span.spanId, parentSpanId: span.parentSpanId,
        name: span.name, kind: 1, startTimeUnixNano: span.startTimeUnixNano, endTimeUnixNano: span.endTimeUnixNano,
        attributes: [...Object.entries(span.attributes).map(([key, value]) => ({ key, value: otlpValue(value) })),
          ...(span.errorType ? [{ key: "error.type", value: { stringValue: span.errorType } }] : [])],
        status: { code: span.errorType ? 2 : 1 }, flags: 1 })),
    }] }] };
    try {
      const response = await fetch(this.config.endpoint, { method: "POST", redirect: "error",
        signal: AbortSignal.timeout(3_000), headers: { "Content-Type": "application/json", "x-otlp-token": this.config.token },
        body: JSON.stringify(payload) });
      if (!response.ok) throw new Error(`OTLP status ${String(response.status)}`);
      await response.body?.cancel();
    } catch {
      const available = Math.max(0, 2_000 - this.#queue.length);
      this.#queue.unshift(...spans.slice(-available));
      this.#dropped += Math.max(0, spans.length - available);
      if (this.#dropped > 0) process.stderr.write(JSON.stringify({ event: "telemetry.dropped", count: this.#dropped }) + "\n");
    }
  }
  async #exportAudit(events: AgentEvent[]): Promise<void> {
    if (!events.length) return;
    const endpoint = new URL(this.config.endpoint);
    endpoint.pathname = endpoint.pathname.replace(/\/v1\/traces\/?$/u, "/v1/audit");
    try {
      const response = await fetch(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(3_000),
        headers: { "Content-Type": "application/json", "x-otlp-token": this.config.token }, body: JSON.stringify({ events }) });
      if (!response.ok) throw new Error(`Audit status ${String(response.status)}`);
      await response.body?.cancel();
    } catch {
      const available = Math.max(0, 5_000 - this.#auditQueue.length);
      this.#auditQueue.unshift(...events.slice(-available));
      this.#dropped += Math.max(0, events.length - available);
    }
  }

  public async shutdown(): Promise<void> {
    if (this.#closed) return;
    clearInterval(this.#timer);
    await this.flush();
    this.#closed = true;
  }
}

export function configuredTelemetry(env: NodeJS.ProcessEnv, serviceVersion: string): Telemetry {
  const raw = env.DAOYIN_OTEL_EXPORT_URL;
  const token = env.DAOYIN_OTEL_EXPORT_TOKEN ?? "";
  if (!raw && !token) return disabledTelemetry;
  let endpoint: URL;
  try { endpoint = new URL(raw ?? "invalid:"); } catch { throw new Error("DAOYIN_OTEL_EXPORT_URL is invalid."); }
  if ((endpoint.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(endpoint.hostname)) && endpoint.protocol !== "https:") {
    throw new Error("DAOYIN_OTEL_EXPORT_URL must use loopback HTTP or HTTPS.");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !/^[\x21-\x7e]{32,256}$/u.test(token)) {
    throw new Error("OpenTelemetry export endpoint or token is invalid.");
  }
  return new OtlpHttpTelemetry({ endpoint, token, serviceName: "daoyin-harness-cloud", serviceVersion,
    environment: env.NODE_ENV === "production" ? "production" : "development" });
}
