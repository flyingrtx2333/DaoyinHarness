import type { ExecutionIdentity } from "@daoyin/harness-contracts";
import type { JsonValue } from "@daoyin/harness-protocol";
import { ResourceError } from "./repository.js";

export interface CampfireSpeechRequest { requestId: string; text: string; voice: "female" | "male"; speed: number }
export interface CampfireSpeech { bytes: Buffer; mediaType: "audio/mpeg"; requestId: string; model: string; provider: string }
export interface CampfireMediaGateway {
  speech(identity: ExecutionIdentity, request: CampfireSpeechRequest, signal: AbortSignal): Promise<CampfireSpeech>;
  video(identity: ExecutionIdentity, request: CampfireVideoRequest, signal: AbortSignal): Promise<Record<string, JsonValue>>;
}
export interface CampfireVideoRequest {
  operation: "quote" | "start" | "status" | "read";
  requestId: string;
  durationSeconds?: number;
  prompt?: string;
  aspectRatio?: "9:16" | "16:9";
  model?: string;
  resolution?: "480p" | "720p" | "1080p";
  pricingDigest?: string;
  offset?: number;
}

/** First-party service credential only; the main platform owns provider secrets and billing. */
export class PlatformCampfireGateway implements CampfireMediaGateway {
  private readonly endpoint: URL;
  private readonly videoEndpoint: URL;
  constructor(platformUrl: string, private readonly serviceToken: string) {
    const base = new URL(platformUrl);
    if (base.username || base.password || base.search || base.hash || base.protocol !== "https:" && !(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))) throw new Error("Invalid media platform URL.");
    this.endpoint = new URL("/api/internal/agent-apps/v1/campfire-speech", base);
    this.videoEndpoint = new URL("/api/internal/agent-apps/v1/campfire-video", base);
  }
  async video(identity: ExecutionIdentity, request: CampfireVideoRequest, signal: AbortSignal): Promise<Record<string, JsonValue>> {
    const response = await fetch(this.videoEndpoint, { method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json", "X-Agent-Service-Token": this.serviceToken },
      body: JSON.stringify({ authorizationId: identity.authorizationId, ...request }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]) });
    const reader = response.body?.getReader();
    if (!reader) throw new ResourceError("CAMPFIRE_VIDEO_GATEWAY_FAILED", "主平台补镜头网关没有返回结果。", 502);
    let data: unknown;
    try {
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.length;
        if (size > 500_000) throw new ResourceError("CAMPFIRE_VIDEO_RESULT_INVALID", "补镜头回执超出限制，未标记成功。", 502); chunks.push(item.value); }
      try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new ResourceError("CAMPFIRE_VIDEO_RESULT_INVALID", "补镜头回执格式无效，未标记成功。", 502); }
    } finally { await reader.cancel().catch(() => undefined); }
    if (!response.ok) {
      const messages: Readonly<Record<string, string>> = {
        CAMPFIRE_VIDEO_CONFIG_UNAVAILABLE: "当前账号的补镜头视频模型尚未配置。",
        CAMPFIRE_VIDEO_PRICING_UNAVAILABLE: "当前视频模型没有可用报价，未提交生成。",
        CAMPFIRE_VIDEO_CREDIT_INSUFFICIENT: "账号额度不足以覆盖本次预估费用，未提交生成。",
        CAMPFIRE_VIDEO_QUOTE_CHANGED: "视频报价或规格已变化，请重新报价并确认，未提交生成。",
        CAMPFIRE_VIDEO_REQUEST_NOT_FOUND: "主平台尚无该补镜头任务；请查询原请求，勿更换标识重复生成。",
        CAMPFIRE_VIDEO_NOT_FINISHED: "原补镜头任务尚未完成。",
        CAMPFIRE_VIDEO_STORAGE_INVALID: "补镜头结果存储来源校验未通过。",
        CAMPFIRE_VIDEO_DOWNLOAD_FAILED: "补镜头结果下载未完成，请查询原任务，不重复生成。",
      };
      const detail = data && typeof data === "object" && "detail" in data ? data.detail : undefined;
      const code = detail && typeof detail === "object" && "code" in detail && typeof detail.code === "string" && Object.hasOwn(messages, detail.code) ? detail.code : "CAMPFIRE_VIDEO_GATEWAY_FAILED";
      throw new ResourceError(code, messages[code] ?? "主平台补镜头请求未完成，请查询原请求，不重复生成。", response.status === 403 ? 403 : response.status === 409 ? 409 : 502);
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new ResourceError("CAMPFIRE_VIDEO_RESULT_INVALID", "补镜头回执格式无效。", 502);
    return data as Record<string, JsonValue>;
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
