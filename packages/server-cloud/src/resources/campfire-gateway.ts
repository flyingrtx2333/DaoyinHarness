import type { ExecutionIdentity } from "@daoyin/harness-contracts";
import { ResourceError } from "./repository.js";

export interface CampfireSpeechRequest { requestId: string; text: string; voice: "female" | "male"; speed: number }
export interface CampfireSpeech { bytes: Buffer; mediaType: "audio/mpeg"; requestId: string; model: string; provider: string }
export interface CampfireMediaGateway {
  speech(identity: ExecutionIdentity, request: CampfireSpeechRequest, signal: AbortSignal): Promise<CampfireSpeech>;
}

/** First-party service credential only; the main platform owns provider secrets and billing. */
export class PlatformCampfireGateway implements CampfireMediaGateway {
  private readonly endpoint: URL;
  constructor(platformUrl: string, private readonly serviceToken: string) {
    const base = new URL(platformUrl);
    if (base.username || base.password || base.search || base.hash || base.protocol !== "https:" && !(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))) throw new Error("Invalid media platform URL.");
    this.endpoint = new URL("/api/internal/agent-apps/v1/campfire-speech", base);
  }
  async speech(identity: ExecutionIdentity, request: CampfireSpeechRequest, signal: AbortSignal): Promise<CampfireSpeech> {
    const response = await fetch(this.endpoint, { method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json", "X-Agent-Service-Token": this.serviceToken },
      body: JSON.stringify({ authorizationId: identity.authorizationId, ...request }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]) });
    if (!response.ok) {
      const stages: Readonly<Record<string, string>> = {
        CAMPFIRE_SPEECH_ACCOUNT_OR_CONFIG: "当前账号的配音额度或供应商配置检查未通过。",
        CAMPFIRE_SPEECH_PROVIDER_FAILED: "语音供应商未能完成配音。",
        CAMPFIRE_SPEECH_DOWNLOAD_FAILED: "旁白已请求，但主平台未能下载已保存音频。",
        CAMPFIRE_SPEECH_STORAGE_INVALID: "主平台旁白的存储来源校验未通过。",
        CAMPFIRE_SPEECH_NOT_FINISHED: "原旁白请求尚未完成，请查询原请求状态。",
      };
      let code = "CAMPFIRE_SPEECH_GATEWAY_FAILED";
      const reader = response.body?.getReader();
      if (reader) {
        const chunks: Uint8Array[] = []; let length = 0;
        try {
          for (;;) { const item = await reader.read(); if (item.done) break; length += item.value.length; if (length > 4096) break; chunks.push(item.value); }
          if (length <= 4096) {
            const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (value && typeof value === "object" && "detail" in value && value.detail && typeof value.detail === "object" && "code" in value.detail && typeof value.detail.code === "string" && Object.hasOwn(stages, value.detail.code)) code = value.detail.code;
          }
        } catch { /* Only known stage codes become public messages. */ }
        finally { await reader.cancel().catch(() => undefined); }
      }
      throw new ResourceError(code, stages[code] ?? (response.status === 403 ? "当前账号的配音请求未通过主平台权限或额度检查。" : "主平台配音未完成，请查询原请求状态；不要重复生成。"), response.status === 403 ? 403 : 502);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ResourceError("CAMPFIRE_SPEECH_RESULT_INVALID", "配音网关没有返回结果。", 502);
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) {
        const item = await reader.read(); if (item.done) break;
        length += item.value.length;
        if (length > 3_000_000) throw new ResourceError("CAMPFIRE_SPEECH_RESULT_INVALID", "配音结果超出单句大小限制。", 502);
        chunks.push(item.value);
      }
    } finally { await reader.cancel(); }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!data || typeof data !== "object" || !("audioBase64" in data) || typeof data.audioBase64 !== "string" || !("requestId" in data) || data.requestId !== request.requestId || !("mediaType" in data) || data.mediaType !== "audio/mpeg" || !("model" in data) || typeof data.model !== "string" || !("provider" in data) || typeof data.provider !== "string") throw new ResourceError("CAMPFIRE_SPEECH_RESULT_INVALID", "配音网关回执格式无效，未标记成功。", 502);
    const bytes = Buffer.from(data.audioBase64, "base64");
    if (!bytes.length || bytes.length > 2_000_000 || bytes.toString("base64") !== data.audioBase64) throw new ResourceError("CAMPFIRE_SPEECH_RESULT_INVALID", "配音音频内容无效，未标记成功。", 502);
    return { bytes, mediaType: "audio/mpeg", requestId: request.requestId, model: data.model, provider: data.provider };
  }
}
