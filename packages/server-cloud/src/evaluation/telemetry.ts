import { EvaluationError, record } from "./contracts.js";

export interface StoredTelemetrySpan {
  traceId: string; spanId: string; parentSpanId: string; name: string; serviceName: string; serviceVersion: string;
  startedAt: string; durationMs: number; status: "ok" | "error"; attributes: Record<string, string | number | boolean>;
}
const allowedAttribute = /^(?:daoyin\.|gen_ai\.|tool\.|error\.|http\.response\.|deployment\.environment)/u;
function attributes(value: unknown): Record<string, string | number | boolean> {
  if (!Array.isArray(value) || value.length > 64) return {};
  const result: Record<string, string | number | boolean> = {};
  for (const item of value) {
    if (!record(item) || typeof item.key !== "string" || !allowedAttribute.test(item.key) || !record(item.value)) continue;
    const source = item.value;
    const candidate = typeof source.stringValue === "string" ? source.stringValue.slice(0, 240)
      : typeof source.boolValue === "boolean" ? source.boolValue
      : typeof source.intValue === "string" && /^-?[0-9]{1,16}$/u.test(source.intValue) ? Number(source.intValue)
      : typeof source.doubleValue === "number" && Number.isFinite(source.doubleValue) ? source.doubleValue : undefined;
    if (candidate !== undefined) result[item.key] = candidate;
  }
  return result;
}
function resourceAttributes(value: unknown): Record<string, string> {
  if (!record(value) || !Array.isArray(value.attributes)) return {};
  const result: Record<string, string> = {};
  for (const item of value.attributes) if (record(item) && typeof item.key === "string" && record(item.value) &&
      typeof item.value.stringValue === "string" && ["service.name", "service.version"].includes(item.key)) {
    result[item.key] = item.value.stringValue.slice(0, 120);
  }
  return result;
}
export function parseOtlpJson(value: unknown): StoredTelemetrySpan[] {
  if (!record(value) || !Array.isArray(value.resourceSpans) || value.resourceSpans.length > 8) {
    throw new EvaluationError(400, "OTLP_INPUT_INVALID", "遥测数据格式无效。");
  }
  const result: StoredTelemetrySpan[] = [];
  for (const resourceSpan of value.resourceSpans) {
    if (!record(resourceSpan)) continue;
    const resource = resourceAttributes(resourceSpan.resource);
    if (!Array.isArray(resourceSpan.scopeSpans)) continue;
    for (const scope of resourceSpan.scopeSpans) {
      if (!record(scope) || !Array.isArray(scope.spans)) continue;
      for (const span of scope.spans) {
        if (!record(span) || typeof span.traceId !== "string" || !/^[a-f0-9]{32}$/u.test(span.traceId) ||
            typeof span.spanId !== "string" || !/^[a-f0-9]{16}$/u.test(span.spanId) ||
            typeof span.parentSpanId !== "string" || !/^(?:[a-f0-9]{16})?$/u.test(span.parentSpanId) ||
            typeof span.name !== "string" || !/^[A-Za-z0-9_.:/-]{1,120}$/u.test(span.name) ||
            typeof span.startTimeUnixNano !== "string" || !/^[0-9]{16,20}$/u.test(span.startTimeUnixNano) ||
            typeof span.endTimeUnixNano !== "string" || !/^[0-9]{16,20}$/u.test(span.endTimeUnixNano)) continue;
        const start = BigInt(span.startTimeUnixNano); const end = BigInt(span.endTimeUnixNano);
        if (end < start || result.length >= 256) throw new EvaluationError(400, "OTLP_INPUT_INVALID", "遥测批次超出限制。");
        const status = record(span.status) && (span.status.code === 2 || span.status.code === "STATUS_CODE_ERROR") ? "error" : "ok";
        result.push({ traceId: span.traceId, spanId: span.spanId, parentSpanId: span.parentSpanId, name: span.name,
          serviceName: resource["service.name"] ?? "unknown", serviceVersion: resource["service.version"] ?? "unknown",
          startedAt: new Date(Number(start / 1_000_000n)).toISOString(), durationMs: Number(end - start) / 1_000_000,
          status, attributes: attributes(span.attributes) });
      }
    }
  }
  if (!result.length) throw new EvaluationError(400, "OTLP_INPUT_EMPTY", "遥测批次没有有效链路片段。");
  return result;
}
