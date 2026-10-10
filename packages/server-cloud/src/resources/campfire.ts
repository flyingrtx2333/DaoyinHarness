import { assertExecutionIdentity } from "@daoyin/harness-contracts";
import { PlatformMaterialGateway, type MaterialFrame, type MaterialAction } from "./material-gateway.js";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { defaultRuntimeSpec, type ExecutionIdentity, type WorkspaceEntry } from "@daoyin/harness-contracts";
import type { JsonValue } from "@daoyin/harness-protocol";
import { validateStoryInput } from "../story-profile.js";
import { CAMPFIRE_REFERENCE_PRESETS } from "./campfire-presets.js";
import { CAMPFIRE_DEFINITIONS } from "./campfire-contract.js";
import type { CampfireMediaGateway } from "./campfire-gateway.js";
import type { ContentStore } from "./content-store.js";
import type { ExecutorProcessRequest, ResourceControlRequest } from "./contracts.js";
import { ResourceError, type ResourceRepository } from "./repository.js";
import { campfireAudioFilter, campfireCaptions, campfireDimensions, campfireVideoFilter, type CampfireAudio, type CampfireCaption, type CampfireSegment } from "./campfire-timeline.js";

type Data = Record<string, JsonValue>;
const record = (value: unknown): value is Data => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (data: Data, key: string): string => typeof data[key] === "string" ? data[key] : "";
function presetDelivery(asset: Data): Data {
  const preset = CAMPFIRE_REFERENCE_PRESETS.find(item => asset.role === "reference_video" && item.key === asset.systemPreset && item.digest === asset.digest);
  return preset ? {playbackUrl:preset.playbackUrl, thumbnailUrl:preset.thumbnailUrl} : {};
}
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
  #thumbnailActive = 0;
  readonly #thumbnailQueue: Array<() => void> = [];
  public constructor(private readonly repository: ResourceRepository, private readonly content: ContentStore,
    private readonly executor: (request: ExecutorProcessRequest, signal?: AbortSignal) => Promise<Record<string, unknown>>,
    private readonly images: Record<string, { digest?: unknown }>, private readonly analysisGateway?: PlatformMaterialGateway, private readonly gateway?: CampfireMediaGateway) {}

  async #facts(auth: ExecutionIdentity, id: string): Promise<Array<{ eventType: string; payload: Data }>> {
    return (await this.repository.businessFacts(auth, id)).map(item => ({ eventType: item.eventType, payload: record(item.payload) ? item.payload : {} }));
  }
  async #manifest(auth: ExecutionIdentity, id: string): Promise<Data> {
    const facts = await this.#facts(auth, id);
    const ready = facts.findLast(item => ["campfire.media.ready", "campfire.profile.ready", "campfire.render.completed"].includes(item.eventType));
    if (!ready) fail("CAMPFIRE_ASSET_NOT_READY", "该素材尚未完成上传或制作，请选择已就绪的素材。", 409);
    const analyzed = facts.findLast(item => item.eventType === "campfire.analysis.completed");
    const state = facts.findLast(item => item.eventType.startsWith("campfire.analysis."));
    const asset = { ...ready.payload, ...analyzed?.payload, ...state?.payload, id };
    return {...asset,...presetDelivery(asset)};
  }
  async #append(auth: ExecutionIdentity, id: string, eventType: string, payload: Data, request: ResourceControlRequest): Promise<void> {
    await this.repository.appendEvent(auth, { resourceId: id, eventType, payload,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}), ...(request.sourceRun ? { runId: request.sourceRun } : {}) });
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
    const prior = (await this.#facts(auth, text(asset, "id"))).findLast(item => item.eventType === "campfire.media.inspected" && item.payload.analysisVersion === 4 && item.payload.requestedStart === requestedStart && item.payload.requestedDuration === requestedDuration);
    if (prior) return { ...asset, ...prior.payload };
    const workspaceId = await this.#workspace(auth, request, [asset]);
    const path = `${text(asset, "id")}.${this.#extension(text(asset, "mediaType"))}`;
    const probeResult = await this.#process(workspaceId, "/usr/bin/ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", path], request, signal);
    let probe: { format?: { duration?: string }; streams?: Array<{ codec_type?: string; width?: number; height?: number }> };
    try { probe = JSON.parse(String(probeResult.stdout)); } catch { fail("CAMPFIRE_PROBE_INVALID", "无法解析真实素材信息。", 422); }
    if (text(asset, "mediaType").startsWith("audio/")) {
      const duration = Number(probe.format?.duration);
      if (!probe.streams?.some(stream => stream.codec_type === "audio") || !Number.isFinite(duration) || duration <= 0 || duration > 3600) fail("CAMPFIRE_AUDIO_INVALID", "音轨没有可用音频，或时长超出1小时限制。", 422);
      const data: Data = { analysisVersion: 4, requestedStart, requestedDuration, durationSeconds: duration, hasAudio: true };
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
    const requestedWindowDuration = request.durationSeconds ?? (duration - windowStart);
    if (isVideo && windowStart >= duration)
      fail("CAMPFIRE_WINDOW_INVALID", `视频真实总长${duration}秒；当前起点${windowStart}秒不在素材内。请选择素材内的起点，或省略时间窗口查看完整素材。`);
    const windowDuration = isVideo ? Math.min(requestedWindowDuration, duration - windowStart) : requestedWindowDuration;
    const windowArgs = isVideo ? ["-ss", String(windowStart), "-t", String(Math.min(windowDuration, duration - windowStart))] : [];
    let sampleTargets = Array.from({ length: 6 }, (_, index) => index * windowDuration / 6);
    const referenceAnalysis: Data = {};
    if (isVideo && asset.role === "reference_video") {
      const cuts = await this.#process(workspaceId, "/usr/bin/ffmpeg", ["-v", "info", "-nostdin", ...windowArgs, "-i", path, "-vf", "select=gt(scene\\,0.35),showinfo", "-an", "-f", "null", "-"], request, signal);
      const detected = [...String(cuts.stderr).matchAll(/pts_time:([0-9.]+)/gu)].map(match => Number(match[1]) + windowStart).filter(time => Number.isFinite(time) && time > windowStart && time < windowStart + windowDuration);
      const unique = [...new Set(detected)].sort((a, b) => a - b);
      const boundaries = [windowStart, ...unique.slice(0, 80), windowStart + windowDuration];
      const intervals = boundaries.slice(0, -1).map((start, index) => ({ startSeconds: start, endSeconds: boundaries[index + 1]!, durationSeconds: Number((boundaries[index + 1]! - start).toFixed(3)) }));
      const candidates = intervals.filter(interval => interval.durationSeconds >= 0.5);
      if (candidates.length >= 6) sampleTargets = Array.from({ length: 6 }, (_, index) => {
        const interval = candidates[Math.round(index * (candidates.length - 1) / 5)]!;
        return (interval.startSeconds + interval.endSeconds) / 2 - windowStart;
      });
      Object.assign(referenceAnalysis, { cutTimesSeconds: unique.slice(0, 80), shotIntervals: intervals,
        cutDetection: "画面变化阈值 0.35 的启发式候选切点，不代表逐镜头语义识别", cutTimesTruncated: unique.length > 80,
        sampleStrategy: candidates.length >= 6 ? "六个分布于窗口的候选镜头中点；非全部镜头，空缺须按时间窗口继续查看" : "窗口内六个等距目标时间；候选切点不足以覆盖六个镜头" });
    }
    const selection = sampleTargets.map((target, index) => `${index === 0 ? "isnan(prev_selected_t)" : `lt(prev_selected_t,${target})`}*gte(t,${target})`).join("+");
    const filter = isVideo ? `select='${selection}',showinfo,scale=160:160:force_original_aspect_ratio=decrease,pad=160:160:(ow-iw)/2:(oh-ih)/2,tile=3x2` : "scale=320:320:force_original_aspect_ratio=decrease";
    const sampled = await this.#process(workspaceId, "/usr/bin/ffmpeg", ["-v", isVideo ? "info" : "error", "-nostdin", "-y", ...windowArgs, "-i", path, "-vf", filter, "-frames:v", "1", "-q:v", "25", "frames.jpg"], request, signal);
    const sampleTimes = isVideo ? [...String(sampled.stderr).matchAll(/pts_time:([0-9.]+)/gu)].map(match => Number((Number(match[1]) + windowStart).toFixed(6))) : [];
    if (isVideo && (sampleTimes.length === 0 || sampleTimes.length > 6)) fail("CAMPFIRE_FRAME_INVALID", "未能核对实际抽样视频帧，请调整分析窗口。", 422);
    const exported = await this.executor({ action: "workspace_prepare", operation: "snapshot", workspaceId }, signal);
    const frame = (exported.entries as WorkspaceEntry[]).find(entry => entry.path === "frames.jpg");
    if (!frame || frame.kind !== "file" || frame.size > 14000) fail("CAMPFIRE_FRAME_INVALID", "抽样画面未能保存，未分析画面内容。", 422);
    const data: Data = { analysisVersion: 4, requestedStart, requestedDuration, durationSeconds: duration, width: video.width, height: video.height, hasAudio: Boolean(probe.streams?.some(stream => stream.codec_type === "audio")),
      ...(isVideo ? { windowStartSeconds: windowStart, windowDurationSeconds: windowDuration, windowTruncated: windowDuration < requestedWindowDuration,
        ...(windowDuration < requestedWindowDuration ? { windowAdjustment: "请求窗口超过真实素材结尾；已截至实际结尾，抽样与候选区间均只覆盖 windowDurationSeconds 所示范围" } : {}),
        sampleTimesSeconds: sampleTimes, sampleOrder: "从左到右、从上到下；时间来自实际解码帧，不足六帧时剩余格为空白" } : {}), ...referenceAnalysis,
      sampledFrames: isVideo ? sampleTimes.length : 1, visualEvidence: { mimeType: "image/jpeg", dataBase64: (await this.content.read(frame.blobHash, 14000)).toString("base64") } };
    await this.#append(auth, text(asset, "id"), "campfire.media.inspected", data, request);
    return { ...asset, ...data };
  }

  public async processAnalysis(signal: AbortSignal): Promise<void> {
    await this.repository.processMaterial(async (auth, id) => {
      assertExecutionIdentity(auth);
      signal.throwIfAborted();
      const request: ResourceControlRequest = { action: "resource_campfire_inspect", resourceId: id };
      const asset = await this.#manifest(auth, id);
      if (asset.pipelineVersion === 1 && asset.analysis && asset.sourceDigest === asset.digest) return;
      if (!this.analysisGateway) fail("MATERIAL_GATEWAY_UNAVAILABLE", "素材解析网关尚未配置，原素材已保存。", 503);
      await this.#append(auth,id,"campfire.analysis.running",{analysisStatus:"running",pipelineVersion:1},request);
      const inspected = await this.#inspection(auth,request,asset,signal);
      const duration = Number(inspected.durationSeconds);
      const video = asset.mediaType === "video/mp4";
      if (video && duration > 180) fail("MATERIAL_DURATION_LIMIT", "素材已保存；自动动作解析支持180秒内视频，请上传分段素材。", 422);
      const frameOf = (value: Data): MaterialFrame => {
        const visual = value.visualEvidence;
        if (!record(visual) || typeof visual.dataBase64 !== "string") fail("MATERIAL_FRAME_INVALID", "解析画面不可用。", 422);
        return {dataBase64:visual.dataBase64,timesSeconds:Array.isArray(value.sampleTimesSeconds)?value.sampleTimesSeconds.filter((x):x is number=>typeof x === "number"):[]};
      };
      const actions: MaterialAction[] = []; const summaries: string[] = []; const receipts: Data[] = [];
      const count = video ? Math.ceil(duration / 20) : 1;
      for (let index=0;index<count;index++) {
        signal.throwIfAborted();
        const start=index*20;
        const window = video ? await this.#inspection(auth,{...request,startSeconds:start,durationSeconds:Math.min(20,duration-start)},asset,signal) : inspected;
        const input={resourceId:id,sourceDigest:text(asset,"digest"),windowIndex:index,durationSeconds:duration};
        const coarse=await this.analysisGateway.analyze(auth,{...input,phase:"actions",frames:[frameOf(window)],candidates:[]},signal);
        const candidates=coarse.analysis.actions;
        if (video && candidates.some(a=>a.startSeconds<start || a.endSeconds>Math.min(start+20,duration))) fail("MATERIAL_WINDOW_INVALID","解析动作超出实际采样窗口，未标记完成。",422);
        if (candidates.length>8) fail("MATERIAL_ACTION_LIMIT", "该段动作数量超出解析预算，请上传更短片段；原素材已保存。",422);
        let result=coarse;
        if (video && candidates.length) {
          const frames: MaterialFrame[]=[];
          for(const action of candidates) for(const boundary of [action.startSeconds,action.endSeconds]) {
            const at=Math.min(Math.max(0,boundary-1.5),Math.max(0,duration-0.5));
            frames.push(frameOf(await this.#inspection(auth,{...request,startSeconds:at,durationSeconds:Math.min(3,duration-at)},asset,signal)));
          }
          result=await this.analysisGateway.analyze(auth,{...input,phase:"boundaries",frames,candidates},signal);
        }
        summaries.push(result.analysis.summary);actions.push(...result.analysis.actions);
        receipts.push({windowIndex:index,model:result.model,provider:result.provider,actionsUsage:coarse.usage ?? null,boundariesUsage:result===coarse?null:result.usage ?? null});
        await this.#append(auth,id,"campfire.analysis.running",{analysisStatus:"running",pipelineVersion:1,analysisProgress:Math.round((index+1)/count*100)},request);
      }
      actions.sort((a,b)=>a.startSeconds-b.startSeconds);
      const data:Data={pipelineVersion:1,sourceDigest:asset.digest!,analysisStatus:"completed",analysisProgress:100,
        durationSeconds:duration,width:inspected.width!,height:inspected.height!,analysis:{summary:summaries.join("\n"),actions:actions.map(a=>({...a})),
        coverage:video ? "连续20秒窗口，每窗六个实际解码帧；动作边界在附近三秒窗口再次采样精修，非逐帧识别" : "单张实际图片，仅识别可见内容，不推断连续动作"},receipts,analyzedAt:new Date().toISOString()};
      await this.#append(auth,id,"campfire.analysis.completed",data,request);
    }, signal);
  }

  async #thumbnail(auth: ExecutionIdentity, request: ResourceControlRequest, asset: Data, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (request.offset !== 0 || !(asset.mediaType === "video/mp4" || text(asset, "mediaType").startsWith("image/")))
      fail("CAMPFIRE_THUMBNAIL_INVALID", "只有图片和视频支持封面缩略图。");
    // Bound work before acquiring database locks, so waiting tiles cannot exhaust the pool.
    if (this.#thumbnailQueue.length >= 32) fail("CAMPFIRE_THUMBNAIL_BUSY", "封面正在处理中，请稍后重试。", 429);
    if (this.#thumbnailActive >= 2) await new Promise<void>(resolve => this.#thumbnailQueue.push(resolve));
    else this.#thumbnailActive++;
    try {
      signal.throwIfAborted();
      return await this.repository.serializeBusiness(auth, idOf(request), async () => {
        let poster = (await this.#facts(auth, idOf(request))).findLast(item => item.eventType === "campfire.thumbnail.ready" && item.payload.thumbnailVersion === 1 && item.payload.sourceDigest === asset.digest)?.payload;
        if (!poster) {
          signal.throwIfAborted();
          const workspaceId = await this.#workspace(auth, request, [asset]);
          const source = `${idOf(request)}.${this.#extension(text(asset, "mediaType"))}`;
          await this.#process(workspaceId, "/usr/bin/ffmpeg", ["-v", "error", "-nostdin", "-y", "-i", source, "-vf", "scale=480:480:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1", "-frames:v", "1", "-an", "-c:v", "libwebp", "-quality", "35", "-compression_level", "6", "poster.webp"], request, signal);
          const exported = await this.executor({ action: "workspace_prepare", operation: "snapshot", workspaceId }, signal);
          const file = (exported.entries as WorkspaceEntry[]).find(entry => entry.path === "poster.webp");
          if (!file || file.kind !== "file" || file.size < 12 || file.size > 98304) fail("CAMPFIRE_THUMBNAIL_INVALID", "封面未能生成，请稍后重试。", 422);
          const bytes = await this.content.read(file.blobHash, 98304);
          if (!mediaHeaderMatches("image/webp", bytes)) fail("CAMPFIRE_THUMBNAIL_INVALID", "封面格式无效。", 422);
          poster = { thumbnailVersion: 1, sourceDigest: asset.digest!, digest: file.blobHash, size: file.size, mediaType: "image/webp", maximumEdge: 480, quality: 35, workspaceId };
          await this.#append(auth, idOf(request), "campfire.thumbnail.ready", poster, request);
        }
        const bytes = await this.content.read(text(poster, "digest"), 98304);
        return { contentBase64: bytes.toString("base64"), nextOffset: bytes.length, size: bytes.length, mediaType: "image/webp", digest: poster.digest, thumbnailVersion: 1, done: true };
      });
    } finally {
      const next = this.#thumbnailQueue.shift(); if (next) next(); else this.#thumbnailActive--;
    }
  }

  public async call(auth: ExecutionIdentity, request: ResourceControlRequest, signal: AbortSignal): Promise<Record<string, unknown>> {
    const definition = CAMPFIRE_DEFINITIONS[request.action as keyof typeof CAMPFIRE_DEFINITIONS];
    if (!definition) fail("CAMPFIRE_ACTION_INVALID", "营火操作不存在。");
    const schema = definition.inputSchema;
    const properties = schema.properties as Record<string, unknown>;
    const input = Object.fromEntries(Object.entries(request).filter(([key]) => Object.hasOwn(properties, key)));
    if (!validateStoryInput(schema, input)) fail("CAMPFIRE_INPUT_INVALID", "营火参数无效，未执行操作。");
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
        if (ready) {
          if (request.action === "resource_media_commit" && (ready.payload.mediaType === "video/mp4" || text(ready.payload,"mediaType").startsWith("image/"))) await this.repository.enqueueMaterial(auth,id,text(ready.payload,"digest"));
          return { asset: await this.#manifest(auth,id), reused: true };
        }
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
        if(type === "video/mp4" || type.startsWith("image/")) await this.repository.enqueueMaterial(auth,id,blob.digest);
        return { asset: await this.#manifest(auth,id) };
      });
    }
    if (request.action === "resource_media_analyze") {
      return this.repository.serializeBusiness(auth,idOf(request),async()=>{
        const asset=await this.#manifest(auth,idOf(request));
        if (!["shop_video","shop_image","reference_video"].includes(text(asset,"role"))) fail("MATERIAL_TYPE_INVALID","只有实拍图片、视频和参考视频支持动作解析。");
        await this.repository.enqueueMaterial(auth,idOf(request),text(asset,"digest"));
        return {asset:await this.#manifest(auth,idOf(request))};
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
      const systemPresets: Data[] = [];
      if (request.filterRole === "reference_video") for (const preset of CAMPFIRE_REFERENCE_PRESETS) {
        if (!await this.content.has(preset.digest)) fail("CAMPFIRE_PRESET_UNAVAILABLE", "系统参考视频暂不可用，请稍后重试。", 503);
        const {key, playbackUrl: _playbackUrl, thumbnailUrl: _thumbnailUrl, ...media} = preset;
        const asset: Data = {...media, role:"reference_video", mediaType:"video/mp4", systemPreset:key};
        // Provision immutable account-owned handles; media bytes remain shared by digest.
        const id = await this.repository.createBusiness(auth,preset.title,"campfire.media.ready",asset,`system-reference:${key}`);
        const {digest: _digest, ...metadata} = asset;
        systemPresets.push({...metadata,...presetDelivery(asset),id});
      }
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
        return { ...metadata, ...presetDelivery(data), id: row.id };
      });
      return { summary: "已读取 Harness 营火素材页", items, systemPresets, hasMore, nextCursor, untrusted: true };
    }
    if (request.action === "resource_media_read") {
      const asset = await this.#manifest(auth, idOf(request));
      if (!asset.digest) fail("CAMPFIRE_MEDIA_UNAVAILABLE", "该资料没有可下载文件。");
      if (request.thumbnail) return this.#thumbnail(auth, request, asset, signal);
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
        if (asset.origin === "ai" || asset.generated === true) fail("CAMPFIRE_EXISTING_FOOTAGE_ONLY", "只能剪辑已有店铺实拍图片或视频，不能使用AI生成画面。", 409);
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
      const plan: Data = { title: request.title!, shopId: request.shopId!, shopProfile: { title: shop.title!, content: shop.content!, version: shop.version ?? 1 }, referenceId: request.referenceId ?? null, aspectRatio: request.aspectRatio!, durationSeconds: Number(plannedDuration.toFixed(6)), segments: segments as unknown as JsonValue, audio: request.audio ? request.audio as unknown as JsonValue : {}, missingShots: request.missingShots!, renderVersion: 2, createdAt: new Date().toISOString() };
      const id = await this.repository.createBusiness(auth, request.title!, "campfire.plan.saved", plan);
      return { summary: `剪辑计划已保存：${segments.length}个镜头，总长${plan.durationSeconds}秒${request.missingShots!.length ? "；素材不足，请调整现有素材方案或上传实拍" : ""}`, plan: { ...plan, id }, canRender: request.missingShots!.length === 0, untrusted: true };
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
        if (completed) return { summary: "制作已完成，原成片可直接预览", completed: true, asset: await this.#manifest(auth, text(completed.payload, "assetId")), reused: true };
        if (facts.some(item => item.eventType === "campfire.render.started")) fail("CAMPFIRE_ORIGINAL_RENDER_EXISTS", "原计划已有剪辑记录，请查询原状态；修改时保存新计划，不重复执行。", 409);
        if (!Array.isArray(plan.missingShots) || plan.missingShots.length) fail("CAMPFIRE_MISSING_SHOTS", "计划仍有缺失镜头。请用现有素材调整方案，或等待上传实拍；不能生成或补镜头。", 409);
        await this.#append(auth, planId, "campfire.render.started", { startedAt: new Date().toISOString() }, request);
        try {
          const segments = plan.segments as unknown as CampfireSegment[];
          const audio = (record(plan.audio) ? plan.audio : {}) as unknown as CampfireAudio;
          const assetIds = [...new Set([...segments.map(segment => segment.assetId), ...[audio.narrationId, audio.musicId].filter((id): id is string => Boolean(id))])];
          const assets = await Promise.all(assetIds.map(id => this.#manifest(auth, id)));
          if (segments.some(segment => { const asset = assets.find(item => item.id === segment.assetId); return asset?.origin === "ai" || asset?.generated === true; })) fail("CAMPFIRE_EXISTING_FOOTAGE_ONLY", "旧计划包含AI生成画面，请用已有实拍保存新计划；未开始剪辑。", 409);
          const workspaceId = await this.#workspace(auth, request, assets);
          const [width, height] = campfireDimensions(String(plan.aspectRatio));
          let elapsed = 0;
          for (const [index, segment] of segments.entries()) {
            const asset = assets.find(item => item.id === segment.assetId)!;
            const inspected = (await this.#facts(auth, segment.assetId)).findLast(item => item.eventType === "campfire.media.inspected")!.payload;
            const args = ["-v", "error", "-nostdin", "-y", ...(asset.mediaType === "video/mp4" ? ["-ss", String(segment.startSeconds)] : ["-loop", "1"]), "-i", `${segment.assetId}.${this.#extension(text(asset, "mediaType"))}`];
            if (!inspected.hasAudio) args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
            args.push("-t", String(segment.durationSeconds), "-map", "[video]", "-map", inspected.hasAudio ? "0:a:0" : "1:a:0", "-filter_complex", campfireVideoFilter(segment, width, height), "-af", "apad,aresample=48000", "-c:v", "libx264", "-threads", "1", "-preset", "veryfast", "-crf", "21", "-c:a", "aac", "-ar", "48000", "-ac", "2", `clip-${index}.mp4`);
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
          return { summary: "制作已完成，成片可直接预览", completed: true, asset: { ...asset, id: assetId }, untrusted: true };
        } catch (error) {
          await this.#append(auth, planId, "campfire.render.failed", { code: error instanceof ResourceError ? error.code : "CAMPFIRE_RENDER_FAILED", cancelled: signal.aborted }, request);
          throw error;
        }
      });
    }
    fail("CAMPFIRE_ACTION_INVALID", "营火操作不存在。");
  }
}
