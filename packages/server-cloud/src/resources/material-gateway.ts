import type { ExecutionIdentity } from "@daoyin/harness-contracts";
import type { JsonValue } from "@daoyin/harness-protocol";
import { ResourceError } from "./repository.js";

export interface MaterialFrame { dataBase64: string; timesSeconds: number[] }
export interface MaterialAction { label: string; startSeconds: number; endSeconds: number; confidence: number }
export interface MaterialRequest { resourceId: string; sourceDigest: string; phase: "actions" | "boundaries"; windowIndex: number; durationSeconds: number; frames: MaterialFrame[]; candidates: MaterialAction[] }
export type MaterialReceipt = Record<string, JsonValue> & { analysis: { summary: string; actions: MaterialAction[] }; model: string; provider: string };
export class PlatformMaterialGateway {
  readonly #endpoint: URL;
  constructor(platformUrl: string, private readonly serviceToken: string) {
    const base = new URL(platformUrl);
    if (base.username || base.password || base.search || base.hash || base.protocol !== "https:" && !(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) || serviceToken.length < 32) throw new Error("Invalid material gateway configuration.");
    this.#endpoint = new URL("/api/internal/agent-apps/v1/campfire-analysis", base);
  }
  async analyze(identity: ExecutionIdentity, input: MaterialRequest, signal: AbortSignal): Promise<MaterialReceipt> {
    const response = await fetch(this.#endpoint, { method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(140_000)]),
      headers: { "Content-Type": "application/json", "X-Agent-Service-Token": this.serviceToken }, body: JSON.stringify({ authorizationId: identity.authorizationId, ...input }) });
    const reader = response.body?.getReader();
    if (!reader) throw new ResourceError("MATERIAL_GATEWAY_FAILED", "素材解析网关没有返回结果。", 502);
    let value: unknown;
    try {
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.length;
        if (size > 96_000) throw new Error("Material result exceeded limit"); chunks.push(item.value); }
      value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally { await reader.cancel().catch(() => undefined); }
    if (!response.ok) {
      const uncertain = value && typeof value === "object" && "detail" in value && value.detail && typeof value.detail === "object" && "code" in value.detail && value.detail.code === "MODEL_OUTCOME_UNCERTAIN";
      throw new ResourceError(uncertain ? "MATERIAL_OUTCOME_UNCERTAIN" : "MATERIAL_GATEWAY_FAILED", uncertain ? "原解析模型请求结果不确定，未重复调用；原素材已保存。" : "素材模型解析未完成；原素材已保存，请检查后台模型配置后重试。", 502);
    }
    if (!value || typeof value !== "object" || Array.isArray(value) || !("analysis" in value) || !value.analysis || typeof value.analysis !== "object" || !("actions" in value.analysis) || !Array.isArray(value.analysis.actions) || !("summary" in value.analysis) || typeof value.analysis.summary !== "string" || !("model" in value) || typeof value.model !== "string" || !("provider" in value) || typeof value.provider !== "string") throw new ResourceError("MATERIAL_RESULT_INVALID", "素材解析回执无效，未标记完成。", 502);
    for (const item of value.analysis.actions) {
      if (!item || typeof item !== "object" || typeof item.label !== "string" || item.label.length > 300 || ![item.startSeconds, item.endSeconds, item.confidence].every(v => typeof v === "number" && Number.isFinite(v)) || item.startSeconds < 0 || item.endSeconds < item.startSeconds || item.endSeconds > input.durationSeconds || item.confidence < 0 || item.confidence > 1) throw new ResourceError("MATERIAL_RESULT_INVALID", "解析动作时间无效，未标记完成。", 502);
    }
    return value as MaterialReceipt;
  }
}
