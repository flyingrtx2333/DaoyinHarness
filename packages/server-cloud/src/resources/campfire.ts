import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { defaultRuntimeSpec, type ExecutionIdentity, type WorkspaceEntry } from "@daoyin/harness-contracts";
import type { JsonValue } from "@daoyin/harness-protocol";
import { validateStoryInput } from "../story-profile.js";
import { CAMPFIRE_DEFINITIONS } from "./campfire-contract.js";
import type { ContentStore } from "./content-store.js";
import type { ExecutorProcessRequest, ResourceControlRequest } from "./contracts.js";
import { ResourceError, type ResourceRepository } from "./repository.js";
import { campfireAudioFilter, campfireCaptions, campfireDimensions, campfireVideoFilter, type CampfireAudio, type CampfireCaption, type CampfireSegment } from "./campfire-timeline.js";
import type { CampfireMediaGateway, CampfireVideoRequest } from "./campfire-gateway.js";

type Data = Record<string, JsonValue>;
const record = (value: unknown): value is Data => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (data: Data, key: string): string => typeof data[key] === "string" ? data[key] : "";
function fail(code: string, message: string, status = 400): never { throw new ResourceError(code, message, status); }
const CHUNK = 256 * 1024;
const LIMIT = 128 * 1024 * 1024;
const idOf = (input: ResourceControlRequest): string => input.resourceId ?? fail("CAMPFIRE_INPUT_INVALID", "请选择真实素材或剪辑计划。");
function mediaHeaderMatches(type: string, bytes: Buffer): boolean {
  if (type === "video/mp4" || type === "audio/mp4") return bytes.subarray(4, 8).toString() === "ftyp";
  if (type === "audio/wav") return bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WAVE";
  if (type === "audio/mpeg") return bytes.subarray(0, 3).toString() === "ID3" || bytes[0] === 255 && ((bytes[1] ?? 0) & 224) === 224;
  if (type === "image/jpeg") return bytes[0] === 255 && bytes[1] === 216;
  if (type === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (type === "image/webp") return bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
  if (type !== "text/plain" || bytes.length > 40000 || bytes.includes(0)) return false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return true; } catch { return false; }
}

/** Capability implementation; all decoding and rendering use the existing gVisor executor. */
export class CampfireService {
  public constructor(private readonly repository: ResourceRepository, private readonly content: ContentStore,
    private readonly executor: (request: ExecutorProcessRequest, signal?: AbortSignal) => Promise<Record<string, unknown>>,
    private readonly images: Record<string, { digest?: unknown }>, private readonly gateway?: CampfireMediaGateway) {}

  async #facts(auth: ExecutionIdentity, id: string): Promise<Array<{ eventType: string; payload: Data }>> {
    return (await this.repository.businessFacts(auth, id)).map(item => ({ eventType: item.eventType, payload: record(item.payload) ? item.payload : {} }));
  }
  async #manifest(auth: ExecutionIdentity, id: string): Promise<Data> {
    const facts = await this.#facts(auth, id);
    const ready = facts.findLast(item => ["campfire.media.ready", "campfire.profile.ready", "campfire.render.completed"].includes(item.eventType));
    if (!ready) fail("CAMPFIRE_ASSET_NOT_READY", "该素材尚未完成上传或制作，请选择已就绪的素材。", 409);
    return { ...ready.payload, id };
  }
  async #append(auth: ExecutionIdentity, id: string, eventType: string, payload: Data, request: ResourceControlRequest): Promise<void> {
    await this.repository.appendEvent(auth, { resourceId: id, eventType, payload,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}), ...(request.sourceRun ? { runId: request.sourceRun } : {}) });
  }
  async #supplementQuote(auth: ExecutionIdentity, id: string): Promise<{ input: Data; quote: Data; facts: Array<{ eventType: string; payload: Data }> }> {
    const facts = await this.#facts(auth, id);
    const input = facts.find(item => item.eventType === "campfire.supplement.requested")?.payload;
    const quote = facts.findLast(item => item.eventType === "campfire.supplement.quoted")?.payload;
    if (!input || !quote) fail("CAMPFIRE_QUOTE_NOT_FOUND", "请选择已经保存的本账号补镜头报价。", 404);
    return { input, quote, facts };
  }
  #videoQuoteValid(quote: Data): boolean {
    const creditUnits = (value: JsonValue | undefined): bigint | undefined => {
      if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/u.test(value)) return undefined;
      const [whole, fraction = ""] = value.split("."); return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
    };
    const estimated = creditUnits(quote.estimatedCredits); const reserve = creditUnits(quote.reserveCredits);
    return typeof quote.model === "string" && quote.model.length > 0 && quote.provider === "ark" && quote.currency === "CNY" &&
      ["480p", "720p", "1080p"].includes(text(quote, "resolution")) && /^[a-f0-9]{64}$/u.test(text(quote, "pricingDigest")) &&
      estimated !== undefined && reserve !== undefined && reserve >= estimated;
  }
  async #supplementState(auth: ExecutionIdentity, id: string, request: ResourceControlRequest, signal: AbortSignal): Promise<Data> {
    const { input, quote, facts } = await this.#supplementQuote(auth, id);
    if (facts.some(item => item.eventType === "campfire.media.ready")) return { summary: "已读取本店AI演绎素材", asset: await this.#manifest(auth, id), status: "succeeded", reused: true, untrusted: true };
    if (!facts.some(item => item.eventType === "campfire.supplement.started")) return { summary: "补镜头尚未提交生成", status: facts.some(item => item.eventType === "campfire.supplement.approved") ? "approved" : "awaiting_confirmation", quote: { ...input, ...quote, id }, untrusted: true };
    if (!this.gateway) fail("CAMPFIRE_VIDEO_UNAVAILABLE", "主平台补镜头网关尚未配置。", 503);
    const state = await this.gateway.video(auth, { operation: "status", requestId: id }, signal);
    if (state.requestId !== id || !["processing", "queued", "running", "succeeded", "failed", "cancelled", "expired"].includes(text(state, "status"))) fail("CAMPFIRE_VIDEO_RESULT_INVALID", "补镜头状态回执无效，未标记成功。", 502);
    if (state.status !== "succeeded") {
      await this.#append(auth, id, "campfire.supplement.status", { status: state.status!, errorCode: state.errorCode ?? null }, request);
      return { summary: ["failed", "cancelled", "expired"].includes(text(state, "status")) ? "原补镜头任务未完成，请查看原任务状态" : "补镜头仍在制作，请继续查询原任务", status: state.status!, resourceId: id, untrusted: true };
    }
    const chunks: Buffer[] = []; let offset = 0; let total: number | undefined;
    for (;;) {
      signal.throwIfAborted();
      const part = await this.gateway.video(auth, { operation: "read", requestId: id, offset }, signal);
      if (part.requestId !== id || part.mediaType !== "video/mp4" || typeof part.contentBase64 !== "string" || typeof part.totalBytes !== "number" || !Number.isInteger(part.totalBytes) || part.totalBytes < 1 || part.totalBytes > LIMIT || total !== undefined && part.totalBytes !== total) fail("CAMPFIRE_VIDEO_RESULT_INVALID", "补镜头下载回执无效，未标记成功。", 502);
      total = part.totalBytes; const bytes = Buffer.from(part.contentBase64, "base64");
      if (!bytes.length || bytes.length > CHUNK || bytes.toString("base64") !== part.contentBase64 || part.nextOffset !== offset + bytes.length || part.nextOffset > total || part.done !== (part.nextOffset === total)) fail("CAMPFIRE_VIDEO_RESULT_INVALID", "补镜头字节范围不完整，未标记成功。", 502);
      chunks.push(bytes); offset += bytes.length; if (part.done) break;
    }
    const bytes = Buffer.concat(chunks);
    if (!mediaHeaderMatches("video/mp4", bytes)) fail("CAMPFIRE_VIDEO_RESULT_INVALID", "补镜头未返回实际MP4，未标记成功。", 502);
    const blob = await this.content.put(bytes);
    const asset: Data = { title: input.title!, shopId: input.shopId!, role: "shop_video", mediaType: "video/mp4", size: blob.size, digest: blob.digest,
      generated: true, origin: "ai", supplementQuoteId: id, sourcePlanId: input.planId!, missingShot: input.missingShot!,
      model: quote.model!, provider: quote.provider!, createdAt: new Date().toISOString() };
    const inspected = await this.#inspection(auth, request, { ...asset, id }, signal);
    await this.#append(auth, id, "campfire.media.ready", { ...asset, durationSeconds: inspected.durationSeconds! }, request);
    return { summary: "本店AI演绎补镜头已保存，请检查画面后保存新计划", asset: { ...asset, id, durationSeconds: inspected.durationSeconds! }, status: "succeeded", untrusted: true };
  }
  async #workspace(auth: ExecutionIdentity, request: ResourceControlRequest, assets: Data[]): Promise<string> {
    const digest = this.images.media?.digest;
    if (typeof digest !== "string") fail("CAMPFIRE_RUNTIME_UNAVAILABLE", "媒体剪辑运行环境尚未配置，未开始处理素材。", 503);
    const runtime = { ...defaultRuntimeSpec({ kind: "builtin", id: "media", digest }), network: "none" as const };
    const workspace = await this.repository.createWorkspace(auth, { title: "营火媒体处理", source: { kind: "empty" }, runtime });
    const entries: WorkspaceEntry[] = assets.map(asset => ({ path: `${text(asset, "id")}.${this.#extension(text(asset, "mediaType"))}`,
      kind: "file", mode: 0o644, size: Number(asset.size), blobHash: text(asset, "digest") }));
    try {
      const snapshot = await this.repository.recordSnapshot(auth, workspace.id, entries);
      await this.executor({ action: "workspace_prepare", workspaceId: workspace.id, runtime,
        source: { kind: "snapshot", snapshotId: snapshot.id }, entries, runId: request.sourceRun });
      await this.repository.setWorkspaceState(auth, workspace.id, "ready");
      return workspace.id;
    } catch (error) { await this.repository.setWorkspaceState(auth, workspace.id, "failed", "媒体处理环境初始化失败。"); throw error; }
  }
  #extension(type: string): string { return ({ "video/mp4": "mp4", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "text/plain": "txt", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/mp4": "m4a" } as Record<string, string>)[type] ?? fail("CAMPFIRE_TYPE_INVALID", "素材格式不支持。"); }
  async #process(workspaceId: string, executable: string, args: string[], request: ResourceControlRequest, signal: AbortSignal): Promise<Record<string, unknown>> {
    const boundedArgs = executable === "/usr/bin/ffmpeg" ? ["-threads", "1", "-filter_threads", "1", "-filter_complex_threads", "1", ...args] : args;
    const value = await this.executor({ action: "process", operation: "run", workspaceId, executable, args: boundedArgs, cwd: ".", timeoutMs: 180_000, runId: request.sourceRun }, signal);
    if (value.exitCode !== 0) fail("CAMPFIRE_PROCESS_FAILED", "媒体解析或剪辑失败；原素材及此前的成片已保留。", 422);
    return value;
  }
  async #inspection(auth: ExecutionIdentity, request: ResourceControlRequest, asset: Data, signal: AbortSignal): Promise<Data> {
    if (text(asset, "role") === "shop_profile") return asset;
    if (text(asset, "mediaType") === "text/plain") return { ...asset, content: (await this.content.read(text(asset, "digest"), 40000)).toString("utf8") };
    const requestedStart = request.startSeconds ?? null;
    const requestedDuration = request.durationSeconds ?? null;
    const prior = (await this.#facts(auth, text(asset, "id"))).findLast(item => item.eventType === "campfire.media.inspected" && item.payload.analysisVersion === 2 && item.payload.requestedStart === requestedStart && item.payload.requestedDuration === requestedDuration);
    if (prior) return { ...asset, ...prior.payload };
    const workspaceId = await this.#workspace(auth, request, [asset]);
    const path = `${text(asset, "id")}.${this.#extension(text(asset, "mediaType"))}`;
    const probeResult = await this.#process(workspaceId, "/usr/bin/ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", path], request, signal);
    let probe: { format?: { duration?: string }; streams?: Array<{ codec_type?: string; width?: number; height?: number }> };
    try { probe = JSON.parse(String(probeResult.stdout)); } catch { fail("CAMPFIRE_PROBE_INVALID", "无法解析真实素材信息。", 422); }
    if (text(asset, "mediaType").startsWith("audio/")) {
      const duration = Number(probe.format?.duration);
      if (!probe.streams?.some(stream => stream.codec_type === "audio") || !Number.isFinite(duration) || duration <= 0 || duration > 3600) fail("CAMPFIRE_AUDIO_INVALID", "音轨没有可用音频，或时长超出1小时限制。", 422);
      const data: Data = { analysisVersion: 2, requestedStart, requestedDuration, durationSeconds: duration, hasAudio: true };
      await this.#append(auth, text(asset, "id"), "campfire.media.inspected", data, request);
      return { ...asset, ...data };
    }
    const video = probe.streams?.find(stream => stream.codec_type === "video");
    if (!video || !video.width || !video.height || video.width > 8192 || video.height > 8192) fail("CAMPFIRE_MEDIA_INVALID", "素材没有可用画面或分辨率超出处理范围。", 422);
    const isVideo = text(asset, "mediaType") === "video/mp4";
    const duration = isVideo ? Number(probe.format?.duration) : 0;
    if (isVideo && (!Number.isFinite(duration) || duration <= 0 || duration > 3600)) fail("CAMPFIRE_DURATION_INVALID", "视频时长须在 1 小时以内。", 422);
    if (!isVideo && (requestedStart !== null || requestedDuration !== null)) fail("CAMPFIRE_WINDOW_INVALID", "只有视频支持按时间窗口查看。");
    const windowStart = request.startSeconds ?? 0;
    const windowDuration = request.durationSeconds ?? (duration - windowStart);
    if (isVideo && (windowStart >= duration || windowDuration > duration - windowStart + 0.05)) fail("CAMPFIRE_WINDOW_INVALID", "分析窗口超出真实视频时长。");
    const windowArgs = isVideo ? ["-ss", String(windowStart), "-t", String(Math.min(windowDuration, duration - windowStart))] : [];
    const filter = isVideo ? `fps=1/${Math.max(windowDuration / 6, 0.01)},scale=160:160:force_original_aspect_ratio=decrease,pad=160:160:(ow-iw)/2:(oh-ih)/2,tile=3x2` : "scale=320:320:force_original_aspect_ratio=decrease";
    await this.#process(workspaceId, "/usr/bin/ffmpeg", ["-v", "error", "-nostdin", "-y", ...windowArgs, "-i", path, "-vf", filter, "-frames:v", "1", "-q:v", "25", "frames.jpg"], request, signal);
    const exported = await this.executor({ action: "workspace_prepare", operation: "snapshot", workspaceId }, signal);
    const frame = (exported.entries as WorkspaceEntry[]).find(entry => entry.path === "frames.jpg");
    if (!frame || frame.kind !== "file" || frame.size > 14000) fail("CAMPFIRE_FRAME_INVALID", "抽样画面未能保存，未分析画面内容。", 422);
    const data: Data = { analysisVersion: 2, requestedStart, requestedDuration, durationSeconds: duration, width: video.width, height: video.height, hasAudio: Boolean(probe.streams?.some(stream => stream.codec_type === "audio")),
      ...(isVideo ? { windowStartSeconds: windowStart, windowDurationSeconds: windowDuration, sampleTimesSeconds: Array.from({ length: 6 }, (_, index) => Number((windowStart + index * windowDuration / 6).toFixed(3))) } : {}),
      sampledFrames: isVideo ? 6 : 1, visualEvidence: { mimeType: "image/jpeg", dataBase64: (await this.content.read(frame.blobHash, 14000)).toString("base64") } };
    if (isVideo && asset.role === "reference_video") {
      const cuts = await this.#process(workspaceId, "/usr/bin/ffmpeg", ["-v", "info", "-nostdin", ...windowArgs, "-i", path, "-vf", "select=gt(scene\\,0.35),showinfo", "-an", "-f", "null", "-"], request, signal);
      const detected = [...String(cuts.stderr).matchAll(/pts_time:([0-9.]+)/gu)].map(match => Number(match[1]) + windowStart).filter(time => Number.isFinite(time) && time > windowStart && time < windowStart + windowDuration);
      const unique = [...new Set(detected)].sort((a, b) => a - b);
      data.cutTimesSeconds = unique.slice(0, 80);
      const boundaries = [windowStart, ...unique.slice(0, 80), windowStart + windowDuration];
      data.shotIntervals = boundaries.slice(0, -1).map((start, index) => ({ startSeconds: start, endSeconds: boundaries[index + 1]!, durationSeconds: Number((boundaries[index + 1]! - start).toFixed(3)) }));
      data.cutDetection = "画面变化阈值 0.35 的启发式切点，不代表逐镜头语义识别";
      data.cutTimesTruncated = unique.length > 80;
    }
    await this.#append(auth, text(asset, "id"), "campfire.media.inspected", data, request);
    return { ...asset, ...data };
  }

  public async call(auth: ExecutionIdentity, request: ResourceControlRequest, signal: AbortSignal): Promise<Record<string, unknown>> {
    const definition = CAMPFIRE_DEFINITIONS[request.action as keyof typeof CAMPFIRE_DEFINITIONS];
    if (!definition) fail("CAMPFIRE_ACTION_INVALID", "营火操作不存在。");
    const schema = definition.inputSchema;
    const properties = schema.properties as Record<string, unknown>;
    const input = Object.fromEntries(Object.entries(request).filter(([key]) => Object.hasOwn(properties, key)));
    if (!validateStoryInput(schema, input)) fail("CAMPFIRE_INPUT_INVALID", "营火参数无效，未执行操作。");
    if (request.action === "resource_campfire_supplement_quote") {
      if (!this.gateway) fail("CAMPFIRE_VIDEO_UNAVAILABLE", "主平台补镜头网关尚未配置，未提交生成。", 503);
      const plan = (await this.#facts(auth, idOf(request))).find(item => item.eventType === "campfire.plan.saved")?.payload;
      const missing = plan && Array.isArray(plan.missingShots) ? plan.missingShots[request.shotIndex!] : undefined;
      if (!plan || typeof missing !== "string" || !missing.trim()) fail("CAMPFIRE_MISSING_SHOT_INVALID", "请选择该计划中真实记录的一条缺失镜头。");
      if (plan.aspectRatio !== "9:16" && plan.aspectRatio !== "16:9") fail("CAMPFIRE_VIDEO_ASPECT_INVALID", "补镜头目前支持9:16或16:9计划。");
      if (!request.prompt!.trim()) fail("CAMPFIRE_INPUT_INVALID", "请描述需要补充的AI演绎画面。");
      const data: Data = { title: `AI演绎 · ${missing}`.slice(0, 120), planId: request.resourceId!, shopId: plan.shopId!, missingShot: missing,
        shotIndex: request.shotIndex!, prompt: request.prompt!.trim(), durationSeconds: request.durationSeconds!, aspectRatio: plan.aspectRatio };
      const id = await this.repository.createBusiness(auth, text(data, "title"), "campfire.supplement.requested", data);
      const quote = await this.gateway.video(auth, { operation: "quote", requestId: id, durationSeconds: request.durationSeconds! }, signal);
      if (!this.#videoQuoteValid(quote)) fail("CAMPFIRE_VIDEO_RESULT_INVALID", "补镜头报价回执无效，未提交生成。", 502);
      const saved = { ...quote, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
      await this.#append(auth, id, "campfire.supplement.quoted", saved, request);
      return { summary: "AI演绎补镜头方案与报价已保存，等待用户确认", quote: { ...data, ...saved, id }, requiresConfirmation: true, untrusted: true };
    }
    if (request.action === "resource_media_supplement_approve" || request.action === "resource_campfire_supplement" || request.action === "resource_campfire_supplement_status") {
      const id = idOf(request);
      return this.repository.serializeBusiness(auth, id, async () => {
        const { input: original, quote, facts } = await this.#supplementQuote(auth, id);
        if (request.action === "resource_campfire_supplement_status" || facts.some(item => item.eventType === "campfire.supplement.started")) return this.#supplementState(auth, id, request, signal);
        const expiry = Date.parse(text(quote, "expiresAt"));
        if (!Number.isFinite(expiry) || expiry <= Date.now()) fail("CAMPFIRE_QUOTE_EXPIRED", "补镜头报价已过期，请重新报价并确认。", 409);
        if (!this.gateway) fail("CAMPFIRE_VIDEO_UNAVAILABLE", "主平台补镜头网关尚未配置。", 503);
        if (request.action === "resource_media_supplement_approve") {
          if (request.sourceRun) fail("CAMPFIRE_CONFIRMATION_REQUIRED", "AI补镜头须由用户在报价卡确认，模型不能代为确认。", 409);
          const current = await this.gateway.video(auth, { operation: "quote", requestId: id, durationSeconds: Number(original.durationSeconds) }, signal);
          if (current.pricingDigest !== quote.pricingDigest || current.model !== quote.model || current.resolution !== quote.resolution) fail("CAMPFIRE_QUOTE_CHANGED", "报价或规格已变化，请重新报价并确认。", 409);
          if (!facts.some(item => item.eventType === "campfire.supplement.approved")) await this.#append(auth, id, "campfire.supplement.approved", { approvedAt: new Date().toISOString(), pricingDigest: quote.pricingDigest! }, request);
          return { summary: "已确认这条AI演绎补镜头报价", resourceId: id, status: "approved" };
        }
        if (!facts.some(item => item.eventType === "campfire.supplement.approved" && item.payload.pricingDigest === quote.pricingDigest)) fail("CAMPFIRE_CONFIRMATION_REQUIRED", "AI补镜头尚未由用户确认，请先在报价卡确认，未提交生成。", 409);
        const video: CampfireVideoRequest = { operation: "start", requestId: id, prompt: text(original, "prompt"), durationSeconds: Number(original.durationSeconds),
          aspectRatio: original.aspectRatio as "9:16" | "16:9", model: text(quote, "model"), resolution: quote.resolution as "480p" | "720p" | "1080p", pricingDigest: text(quote, "pricingDigest") };
        await this.#append(auth, id, "campfire.supplement.started", { startedAt: new Date().toISOString() }, request);
        try {
          const result = await this.gateway.video(auth, video, signal);
          if (result.requestId !== id || typeof result.status !== "string") fail("CAMPFIRE_VIDEO_RESULT_INVALID", "补镜头提交回执无效，请查询原请求。", 502);
          await this.#append(auth, id, "campfire.supplement.submitted", { status: result.status }, request);
          return { summary: "AI演绎补镜头请求已提交，请查询原任务", resourceId: id, status: result.status, untrusted: true };
        } catch (error) {
          await this.#append(auth, id, "campfire.supplement.submission_uncertain", { code: error instanceof ResourceError ? error.code : "CAMPFIRE_VIDEO_GATEWAY_FAILED", cancelled: signal.aborted }, request);
          throw error;
        }
      });
    }
    if (request.action === "resource_media_begin") {
      if (request.shopId) {
        const shop = await this.#manifest(auth, request.shopId);
        if (text(shop, "role") !== "shop_profile") fail("CAMPFIRE_SHOP_INVALID", "请选择真实店铺资料。");
      }
      if (request.role !== "reference_video" && !request.shopId) fail("CAMPFIRE_SHOP_REQUIRED", "请先选择店铺，再上传本店素材。");
      if ((request.role === "reference_video" || request.role === "shop_video") && request.mediaType !== "video/mp4" || request.role === "shop_image" && !request.mediaType?.startsWith("image/") || request.role === "shop_document" && request.mediaType !== "text/plain" || ["narration_audio", "background_music"].includes(request.role!) && !request.mediaType?.startsWith("audio/")) fail("CAMPFIRE_TYPE_INVALID", "素材格式与用途不匹配。");
      const id = await this.repository.createBusiness(auth, request.title!, "campfire.upload.started", { title: request.title!, role: request.role!, shopId: request.shopId ?? null, mediaType: request.mediaType!, size: request.size! });
      return { resourceId: id, chunkBytes: CHUNK };
    }
    if (request.action === "resource_media_chunk" || request.action === "resource_media_commit") {
      const id = idOf(request);
      return this.repository.serializeBusiness(auth, id, async () => {
        const facts = await this.#facts(auth, id);
        const start = facts.find(item => item.eventType === "campfire.upload.started")?.payload;
        if (!start) fail("CAMPFIRE_UPLOAD_INVALID", "上传不存在。");
        const ready = facts.find(item => item.eventType === "campfire.media.ready");
        if (ready) return { asset: { ...ready.payload, id }, reused: true };
        const chunks = facts.filter(item => item.eventType === "campfire.upload.chunk").map(item => item.payload).sort((a, b) => Number(a.index) - Number(b.index));
        if (request.action === "resource_media_chunk") {
          const bytes = Buffer.from(request.contentBase64!, "base64");
          if (!bytes.length || bytes.length > CHUNK || bytes.toString("base64") !== request.contentBase64) fail("CAMPFIRE_CHUNK_INVALID", "上传分块格式无效。");
          const count = Math.ceil(Number(start.size) / CHUNK);
          if (request.index! >= count || bytes.length !== Math.min(CHUNK, Number(start.size) - request.index! * CHUNK)) fail("CAMPFIRE_CHUNK_INVALID", "上传分块长度或序号不匹配。");
          const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
          const previous = chunks.find(chunk => chunk.index === request.index);
          if (previous) { if (previous.digest !== digest) fail("CAMPFIRE_UPLOAD_CONFLICT", "同一上传分块内容已变化，请重新上传。", 409); return { accepted: true, reused: true }; }
          const stored = await this.content.put(bytes);
          await this.#append(auth, id, "campfire.upload.chunk", { index: request.index!, digest: stored.digest, size: stored.size }, request);
          return { accepted: true };
        }
        if (chunks.length !== Math.ceil(Number(start.size) / CHUNK) || chunks.some((chunk, index) => chunk.index !== index)) fail("CAMPFIRE_UPLOAD_INCOMPLETE", "素材尚未完整上传，不能使用。", 409);
        const bytes = Buffer.concat(await Promise.all(chunks.map(chunk => this.content.read(text(chunk, "digest"), CHUNK))));
        if (bytes.length !== start.size || bytes.length > LIMIT) fail("CAMPFIRE_UPLOAD_INCOMPLETE", "上传大小不匹配。", 409);
        const type = text(start, "mediaType");
        if (!mediaHeaderMatches(type, bytes)) fail("CAMPFIRE_MEDIA_INVALID", "文件内容与声明的媒体格式不匹配。");
        const blob = await this.content.put(bytes);
        const asset: Data = { ...start, digest: blob.digest, createdAt: new Date().toISOString() };
        await this.#append(auth, id, "campfire.media.ready", asset, request);
        return { asset: { ...asset, id } };
      });
    }
    if (request.action === "resource_media_profile") {
      if (Boolean(request.resourceId) !== Boolean(request.expectedVersion)) fail("CAMPFIRE_PROFILE_VERSION_REQUIRED", "修改资料须提供店铺ID和当前版本，请先刷新店铺资料。");
      if (!request.title!.trim() || !request.content!.trim()) fail("CAMPFIRE_PROFILE_EMPTY", "店铺名称和真实资料不能为空。");
      if (request.resourceId) return this.repository.serializeBusiness(auth, request.resourceId, async () => {
        const previous = await this.#manifest(auth, request.resourceId!);
        if (previous.role !== "shop_profile") fail("CAMPFIRE_SHOP_INVALID", "只能修改当前账号的店铺资料。");
        const version = Number(previous.version ?? 1);
        if (version === request.expectedVersion! + 1 && previous.title === request.title && previous.content === request.content) return { asset: previous, reused: true, untrusted: true };
        if (version !== request.expectedVersion) fail("CAMPFIRE_PROFILE_CONFLICT", "店铺资料已被修改。本次内容未保存，请刷新资料后再编辑。", 409);
        const asset: Data & { title: string; version: number } = { ...previous, title: request.title!, content: request.content!, size: Buffer.byteLength(request.content!), version: version + 1, updatedAt: new Date().toISOString() };
        delete asset.id;
        await this.repository.appendProfileVersion(auth, request.resourceId!, asset);
        return { asset: { ...asset, id: request.resourceId! }, untrusted: true };
      });
      const asset: Data = { title: request.title!, content: request.content!, role: "shop_profile", mediaType: "text/plain", size: Buffer.byteLength(request.content!), version: 1, createdAt: new Date().toISOString() };
      const id = await this.repository.createBusiness(auth, request.title!, "campfire.profile.ready", asset);
      return { asset: { ...asset, id } };
    }
    if (request.action === "resource_campfire_list") {
      const limit = request.limit ?? 100;
      let before: { createdAt: string; id: string } | undefined;
      if (request.shopId && (await this.#manifest(auth, request.shopId)).role !== "shop_profile") fail("CAMPFIRE_SHOP_INVALID", "请选择本店资料。");
      if (request.pageCursor) {
        try {
          const decoded: unknown = JSON.parse(Buffer.from(request.pageCursor, "base64url").toString("utf8"));
          if (!record(decoded) || Object.keys(decoded).length !== 4 || typeof decoded.createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(decoded.createdAt) || !Number.isFinite(Date.parse(decoded.createdAt)) || typeof decoded.id !== "string" || !/^res_[a-f0-9]{24}$/u.test(decoded.id) || decoded.shopId !== (request.shopId ?? null) || decoded.filterRole !== (request.filterRole ?? null)) throw new Error("Invalid page cursor");
          before = { createdAt: decoded.createdAt, id: decoded.id };
        } catch { fail("CAMPFIRE_CURSOR_INVALID", "分页位置无效或筛选条件已变化，请刷新素材列表。"); }
      }
      const rows = await this.repository.businessManifests(auth, { limit, ...(request.shopId ? { shopId: request.shopId } : {}), ...(request.filterRole ? { filterRole: request.filterRole } : {}), ...(before ? { before } : {}) });
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id, shopId: request.shopId ?? null, filterRole: request.filterRole ?? null })).toString("base64url") : null;
      const items = page.map((row): Data => {
        const data = record(row.payload) ? row.payload : {};
        const metadata = Object.fromEntries(Object.entries(data).filter(([key]) => key !== "content" && key !== "digest"));
        return { ...metadata, id: row.id };
      });
      return { summary: "已读取 Harness 营火素材页", items, hasMore, nextCursor, untrusted: true };
    }
    if (request.action === "resource_media_read") {
      const asset = await this.#manifest(auth, idOf(request));
      if (!asset.digest) fail("CAMPFIRE_MEDIA_UNAVAILABLE", "该资料没有可下载文件。");
      const offset = request.offset!;
      if (offset > Number(asset.size)) fail("CAMPFIRE_RANGE_INVALID", "素材读取位置无效。");
      const end = Math.min(offset + CHUNK, Number(asset.size));
      const bytes = this.content.readRange ? await this.content.readRange(text(asset, "digest"), offset, CHUNK) : (await this.content.read(text(asset, "digest"), LIMIT)).subarray(offset, end);
      return { contentBase64: bytes.toString("base64"), nextOffset: end, size: asset.size, mediaType: asset.mediaType, done: end === asset.size };
    }
    if (request.action === "resource_campfire_inspect") {
      const asset = await this.#manifest(auth, idOf(request));
      if ((request.startSeconds !== undefined || request.durationSeconds !== undefined) && asset.mediaType !== "video/mp4") fail("CAMPFIRE_WINDOW_INVALID", "只有视频支持按时间窗口查看。");
      return { summary: "已读取真实素材", asset: await this.#inspection(auth, request, asset, signal), untrusted: true };
    }
    if (request.action === "resource_campfire_music") {
      const shop = await this.#manifest(auth, request.shopId!);
      if (shop.role !== "shop_profile") fail("CAMPFIRE_SHOP_INVALID", "请选择本店真实资料。");
      const digest = "e05c1bd683174cff77d492b7ac77262ff4617f99f69d82564b66831cf48352d6";
      const bytes = await readFile(new URL("./music/city-sunshine.mp3", import.meta.url));
      if (createHash("sha256").update(bytes).digest("hex") !== digest) fail("CAMPFIRE_MUSIC_INVALID", "内置音乐版本校验未通过，未加入素材库。", 503);
      const blob = await this.content.put(bytes);
      const asset: Data = { title: "City Sunshine · 轻快配乐", shopId: request.shopId!, role: "background_music", mediaType: "audio/mpeg", size: blob.size, digest: blob.digest,
        preset: request.preset!, license: "CC0-1.0", artist: "Kevin MacLeod", sourceUrl: "https://github.com/0lhi/FreePD/blob/cf011c7016595833b550a88ff127f089188b25f8/Upbeat/City%20Sunshine.mp3", sourceSha256: digest };
      const id = await this.repository.createBusiness(auth, String(asset.title), "campfire.media.ready", asset, `music:${request.shopId}:${request.preset}:v1`);
      return { summary: "已保存本店可用的CC0配乐，请inspect实际时长后用于制作计划", asset: { ...asset, id }, untrusted: true };
    }
    if (request.action === "resource_campfire_narrate") {
      if (!this.gateway) fail("CAMPFIRE_SPEECH_UNAVAILABLE", "主平台配音网关尚未配置，未开始生成。", 503);
      const shop = await this.#manifest(auth, request.shopId!);
      if (shop.role !== "shop_profile") fail("CAMPFIRE_SHOP_INVALID", "请选择本店真实资料。");
      const sentences = request.sentences!.map(sentence => sentence.trim());
      if (sentences.some(sentence => !sentence) || sentences.join("").length > 2000) fail("CAMPFIRE_SPEECH_TOO_LONG", "旁白须为1至12句、合计2000字以内。");
      const input: Data = { title: request.title!, shopId: request.shopId!, sentences, voice: request.voice!, speed: request.speed! };
      const id = await this.repository.createBusiness(auth, request.title!, "campfire.narration.requested", input, request.requestKey!);
      return this.repository.serializeBusiness(auth, id, async () => {
        const facts = await this.#facts(auth, id);
        if (facts.some(item => item.eventType === "campfire.media.ready")) return { summary: "已读取原旁白及真实字幕时间轴", asset: await this.#manifest(auth, id), reused: true, untrusted: true };
        if (facts.some(item => item.eventType === "campfire.narration.started")) fail("CAMPFIRE_NARRATION_EXISTS", `原旁白请求已有制作记录，请查询 ${id} 的真实状态，不重复生成。`, 409);
        await this.#append(auth, id, "campfire.narration.started", { startedAt: new Date().toISOString() }, request);
        try {
          const parts: Data[] = [];
          for (const [index, sentence] of sentences.entries()) {
            signal.throwIfAborted();
            const speech = await this.gateway!.speech(auth, { requestId: `cf_${id.slice(4)}_${index}`, text: sentence, voice: request.voice!, speed: request.speed! }, signal);
            if (!mediaHeaderMatches(speech.mediaType, speech.bytes)) fail("CAMPFIRE_SPEECH_RESULT_INVALID", "网关返回的音频格式无效，未标记生成成功。", 502);
            const blob = await this.content.put(speech.bytes);
            const part: Data = { id: `speech-${index}`, mediaType: speech.mediaType, digest: blob.digest, size: blob.size, sentence, requestId: speech.requestId, model: speech.model, provider: speech.provider };
            parts.push(part);
            await this.#append(auth, id, "campfire.narration.part.ready", { ...part, index, total: sentences.length }, request);
          }
          const workspaceId = await this.#workspace(auth, request, parts);
          let elapsed = 0; const captions: CampfireCaption[] = [];
          for (const [index, part] of parts.entries()) {
            await this.#process(workspaceId, "/usr/bin/ffmpeg", ["-v", "error", "-nostdin", "-y", "-i", `${text(part, "id")}.mp3`, "-vn", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", `speech-${index}.wav`], request, signal);
            const result = await this.#process(workspaceId, "/usr/bin/ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", `speech-${index}.wav`], request, signal);
            const duration = Number(JSON.parse(String(result.stdout)).format?.duration);
            if (!Number.isFinite(duration) || duration <= 0 || elapsed + duration > 180) fail("CAMPFIRE_SPEECH_DURATION_INVALID", "真实旁白长度超出180秒限制，请修改文案；原音频已保留。", 422);
            captions.push({ text: text(part, "sentence"), startSeconds: elapsed, durationSeconds: duration }); elapsed += duration;
          }
          await this.executor({ action: "file", operation: "write", workspaceId, path: "speech.txt", content: parts.map((_, index) => `file 'speech-${index}.wav'`).join("\n") }, signal);
          await this.#process(workspaceId, "/usr/bin/ffmpeg", ["-v", "error", "-nostdin", "-y", "-f", "concat", "-safe", "1", "-i", "speech.txt", "-c:a", "pcm_s16le", "narration.wav"], request, signal);
          const exported = await this.executor({ action: "workspace_prepare", operation: "snapshot", workspaceId }, signal);
          const entries = exported.entries as WorkspaceEntry[];
          const snapshot = await this.repository.recordSnapshot(auth, workspaceId, entries);
          const output = entries.find(entry => entry.path === "narration.wav");
          if (!output || output.kind !== "file" || output.size <= 44 || output.size > LIMIT) fail("CAMPFIRE_SPEECH_RESULT_INVALID", "旁白音轨未能保存。", 422);
          const asset: Data = { ...input, role: "narration_audio", mediaType: "audio/wav", size: output.size, digest: output.blobHash, durationSeconds: elapsed, captions: captions as unknown as JsonValue, generated: true, workspaceId, snapshotId: snapshot.id, createdAt: new Date().toISOString() };
          await this.#append(auth, id, "campfire.media.inspected", { analysisVersion: 2, requestedStart: null, requestedDuration: null, durationSeconds: elapsed, hasAudio: true }, request);
          await this.#append(auth, id, "campfire.media.ready", asset, request);
          return { summary: "旁白已实际生成，字幕时间轴按逐句真实音频测量", asset: { ...asset, id }, untrusted: true };
        } catch (error) {
          await this.#append(auth, id, "campfire.narration.failed", { code: error instanceof ResourceError ? error.code : "CAMPFIRE_NARRATION_FAILED", cancelled: signal.aborted }, request);
          if (signal.aborted) throw error;
          fail(error instanceof ResourceError ? error.code : "CAMPFIRE_NARRATION_FAILED", `旁白制作未完成：${error instanceof ResourceError ? error.message : "音频处理或保存失败"} 原请求 ${id} 和已生成音频已保留；请先查询状态，不重复生成。`, error instanceof ResourceError ? error.status : 502);
        }
      });
    }
    if (request.action === "resource_campfire_plan") {
      const shop = await this.#manifest(auth, request.shopId!);
      if (shop.role !== "shop_profile") fail("CAMPFIRE_SHOP_INVALID", "请选择本店资料。");
      if (request.referenceId && (await this.#manifest(auth, request.referenceId)).role !== "reference_video") fail("CAMPFIRE_REFERENCE_INVALID", "请选择明确标记为参考的视频。");
      const segments = request.segments!;
      if (!segments.length) fail("CAMPFIRE_PLAN_EMPTY", "剪辑计划至少需要一个真实素材片段。");
      const plannedDuration = segments.reduce((sum, item) => sum + item.durationSeconds, 0);
      if (plannedDuration > 180) fail("CAMPFIRE_PLAN_TOO_LONG", "成片长度不超过180秒。");
      const invalidRanges: string[] = [];
      for (const [index, segment] of segments.entries()) {
        const asset = await this.#manifest(auth, segment.assetId);
        if (asset.shopId !== request.shopId || !["shop_video", "shop_image"].includes(text(asset, "role"))) fail("CAMPFIRE_REFERENCE_NOT_FOOTAGE", "成片只能使用所选店铺的图片或视频，不能使用参考视频或其他店铺素材。", 403);
        const inspected = (await this.#facts(auth, segment.assetId)).findLast(item => item.eventType === "campfire.media.inspected");
        if (!inspected) fail("CAMPFIRE_INSPECT_REQUIRED", "请先实际读取每个待用素材的时长和抽样画面。", 409);
        if (asset.mediaType === "video/mp4") {
          const sourceDuration = Number(inspected.payload.durationSeconds);
          if (segment.startSeconds + segment.durationSeconds > sourceDuration + 0.05) {
            invalidRanges.push(`镜头${index + 1} ${segment.assetId}：真实总长${sourceDuration}秒，当前从${segment.startSeconds}秒取${segment.durationSeconds}秒；保持起点时最多取${Number(Math.max(0, sourceDuration - segment.startSeconds).toFixed(6))}秒`);
          }
        } else if (segment.startSeconds !== 0) {
          invalidRanges.push(`镜头${index + 1} ${segment.assetId}：图片起点必须为0秒，当前为${segment.startSeconds}秒`);
        }
      }
      if (invalidRanges.length) fail("CAMPFIRE_SEGMENT_RANGE_INVALID", `计划未保存，旧成片保留。${invalidRanges.join("；")}。请直接根据上述真实范围修正全部越界镜头后保存新计划；无需重复inspect已检查素材。`);
      for (const [key, role] of [["narrationId", "narration_audio"], ["musicId", "background_music"]] as const) {
        const id = request.audio?.[key];
        if (!id) continue;
        const asset = await this.#manifest(auth, id);
        if (asset.shopId !== request.shopId || asset.role !== role || !text(asset, "mediaType").startsWith("audio/")) fail("CAMPFIRE_AUDIO_SCOPE_INVALID", "旁白和音乐必须是本店明确标记用途的音轨，不能使用参考视频音轨。", 403);
        const inspected = (await this.#facts(auth, id)).findLast(item => item.eventType === "campfire.media.inspected");
        if (!inspected) fail("CAMPFIRE_INSPECT_REQUIRED", "请先读取待用音轨的实际时长。", 409);
        if (key === "narrationId" && Number(inspected.payload.durationSeconds) > plannedDuration + 0.1) fail("CAMPFIRE_NARRATION_TOO_LONG", "真实旁白长于剪辑时间轴，请延长镜头或修改旁白；不能截断口播。", 409);
      }
      const plan: Data = { title: request.title!, shopId: request.shopId!, shopProfile: { title: shop.title!, content: shop.content!, version: shop.version ?? 1 }, referenceId: request.referenceId ?? null, aspectRatio: request.aspectRatio!, segments: segments as unknown as JsonValue, audio: request.audio ? request.audio as unknown as JsonValue : {}, missingShots: request.missingShots!, renderVersion: 2, createdAt: new Date().toISOString() };
      const id = await this.repository.createBusiness(auth, request.title!, "campfire.plan.saved", plan);
      return { summary: request.missingShots!.length ? "计划已保存，需先补齐缺失镜头" : "剪辑计划已保存", plan: { ...plan, id }, canRender: request.missingShots!.length === 0, untrusted: true };
    }
    if (request.action === "resource_campfire_status") {
      return { summary: "已读取营火计划实际状态", resourceId: idOf(request), facts: await this.#facts(auth, idOf(request)) };
    }
    if (request.action === "resource_campfire_render") {
      const planId = idOf(request);
      return this.repository.serializeBusiness(auth, planId, async () => {
        const facts = await this.#facts(auth, planId);
        const plan = facts.find(item => item.eventType === "campfire.plan.saved")?.payload;
        if (!plan) fail("CAMPFIRE_PLAN_REQUIRED", "请先保存真实素材剪辑计划。", 409);
        const completed = facts.find(item => item.eventType === "campfire.render.result");
        if (completed) return { summary: "原成片已保存", asset: await this.#manifest(auth, text(completed.payload, "assetId")), reused: true };
        if (facts.some(item => item.eventType === "campfire.render.started")) fail("CAMPFIRE_ORIGINAL_RENDER_EXISTS", "原计划已有剪辑记录，请查询原状态；修改时保存新计划，不重复执行。", 409);
        if (!Array.isArray(plan.missingShots) || plan.missingShots.length) fail("CAMPFIRE_MISSING_SHOTS", "计划仍有缺失镜头。请先告知用户并询问补充方式，不能自动生成画面。", 409);
        await this.#append(auth, planId, "campfire.render.started", { startedAt: new Date().toISOString() }, request);
        try {
          const segments = plan.segments as unknown as CampfireSegment[];
          const audio = (record(plan.audio) ? plan.audio : {}) as unknown as CampfireAudio;
          const assetIds = [...new Set([...segments.map(segment => segment.assetId), ...[audio.narrationId, audio.musicId].filter((id): id is string => Boolean(id))])];
          const assets = await Promise.all(assetIds.map(id => this.#manifest(auth, id)));
          const workspaceId = await this.#workspace(auth, request, assets);
          const [width, height] = campfireDimensions(String(plan.aspectRatio));
          let elapsed = 0;
          for (const [index, segment] of segments.entries()) {
            const asset = assets.find(item => item.id === segment.assetId)!;
            const inspected = (await this.#facts(auth, segment.assetId)).findLast(item => item.eventType === "campfire.media.inspected")!.payload;
            const args = ["-v", "error", "-nostdin", "-y", ...(asset.mediaType === "video/mp4" ? ["-ss", String(segment.startSeconds)] : ["-loop", "1"]), "-i", `${segment.assetId}.${this.#extension(text(asset, "mediaType"))}`];
            if (!inspected.hasAudio) args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
            args.push("-t", String(segment.durationSeconds), "-map", "[video]", "-map", inspected.hasAudio ? "0:a:0" : "1:a:0", "-filter_complex", campfireVideoFilter(segment, width, height, asset.mediaType !== "video/mp4"), "-af", "apad,aresample=48000", "-c:v", "libx264", "-threads", "1", "-preset", "veryfast", "-crf", "21", "-c:a", "aac", "-ar", "48000", "-ac", "2", `clip-${index}.mp4`);
            await this.#process(workspaceId, "/usr/bin/ffmpeg", args, request, signal);
            elapsed += segment.durationSeconds;
            await this.#append(auth, planId, "campfire.render.progress", { stage: "shots", completed: index + 1, total: segments.length }, request);
          }
          await this.executor({ action: "file", operation: "write", workspaceId, path: "clips.txt", content: segments.map((_, index) => `file 'clip-${index}.mp4'`).join("\n") }, signal);
          const narration = assets.find(item => item.id === audio.narrationId);
          const narrationCaptions = narration?.generated === true && Array.isArray(narration.captions) ? narration.captions as unknown as CampfireCaption[] : undefined;
          const generatedIndices = segments.flatMap((segment, index) => assets.find(item => item.id === segment.assetId)?.origin === "ai" ? [index] : []);
          const hasCaptions = Boolean(narrationCaptions?.length) || segments.some(segment => segment.caption?.trim()) || generatedIndices.length > 0;
          if (hasCaptions) await this.executor({ action: "file", operation: "write", workspaceId, path: "captions.ass", content: campfireCaptions(segments, width, height, narrationCaptions, generatedIndices) }, signal);
          const mixArgs = ["-v", "error", "-nostdin", "-y", "-f", "concat", "-safe", "1", "-i", "clips.txt"];
          let inputIndex = 1;
          let narrationInput: number | undefined; let musicInput: number | undefined;
          if (audio.narrationId) { const asset = assets.find(item => item.id === audio.narrationId)!; mixArgs.push("-i", `${audio.narrationId}.${this.#extension(text(asset, "mediaType"))}`); narrationInput = inputIndex++; }
          if (audio.musicId) { const asset = assets.find(item => item.id === audio.musicId)!; mixArgs.push("-stream_loop", "-1", "-i", `${audio.musicId}.${this.#extension(text(asset, "mediaType"))}`); musicInput = inputIndex; }
          await this.#append(auth, planId, "campfire.render.progress", { stage: "mixing", completed: segments.length, total: segments.length }, request);
          mixArgs.push("-t", String(elapsed), "-map", "0:v:0", "-map", "[audio]", "-filter_complex", campfireAudioFilter(elapsed, audio, narrationInput, musicInput), ...(hasCaptions ? ["-vf", "ass=captions.ass"] : []), "-c:v", "libx264", "-threads", "1", "-preset", "veryfast", "-crf", "21", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", "output.mp4");
          await this.#process(workspaceId, "/usr/bin/ffmpeg", mixArgs, request, signal);
          const outputProbe = await this.#process(workspaceId, "/usr/bin/ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", "output.mp4"], request, signal);
          const actualDuration = Number(JSON.parse(String(outputProbe.stdout)).format?.duration);
          if (!Number.isFinite(actualDuration) || Math.abs(actualDuration - elapsed) > 1) fail("CAMPFIRE_OUTPUT_INVALID", "实际成片时长与计划不一致，未标记制作成功。", 422);
          const exported = await this.executor({ action: "workspace_prepare", operation: "snapshot", workspaceId }, signal);
          const entries = exported.entries as WorkspaceEntry[];
          const snapshot = await this.repository.recordSnapshot(auth, workspaceId, entries);
          const output = entries.find(entry => entry.path === "output.mp4");
          if (!output || output.kind !== "file" || output.size <= 0 || output.size > LIMIT) fail("CAMPFIRE_OUTPUT_INVALID", "成片未能保存或超出大小限制。", 422);
          const asset: Data = { title: plan.title!, role: "output_video", shopId: plan.shopId!, mediaType: "video/mp4", size: output.size, digest: output.blobHash, durationSeconds: actualDuration, width, height, fps: 30, renderVersion: 2, audio: audio as unknown as JsonValue, generatedSegments: generatedIndices, planId, workspaceId, snapshotId: snapshot.id, createdAt: new Date().toISOString() };
          const assetId = await this.repository.createBusiness(auth, text(plan, "title"), "campfire.render.completed", asset);
          await this.#append(auth, planId, "campfire.render.result", { assetId, durationSeconds: actualDuration }, request);
          return { summary: "剪辑成片已保存，可在素材库预览", asset: { ...asset, id: assetId }, untrusted: true };
        } catch (error) {
          await this.#append(auth, planId, "campfire.render.failed", { code: error instanceof ResourceError ? error.code : "CAMPFIRE_RENDER_FAILED", cancelled: signal.aborted }, request);
          throw error;
        }
      });
    }
    fail("CAMPFIRE_ACTION_INVALID", "营火操作不存在。");
  }
}
