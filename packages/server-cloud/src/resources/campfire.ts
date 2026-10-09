import { createHash } from "node:crypto";
import { defaultRuntimeSpec, type ExecutionIdentity, type WorkspaceEntry } from "@daoyin/harness-contracts";
import type { JsonValue } from "@daoyin/harness-protocol";
import { validateStoryInput } from "../story-profile.js";
import { CAMPFIRE_DEFINITIONS } from "./campfire-contract.js";
import type { ContentStore } from "./content-store.js";
import type { ExecutorProcessRequest, ResourceControlRequest } from "./contracts.js";
import { ResourceError, type ResourceRepository } from "./repository.js";

type Data = Record<string, JsonValue>;
type Segment = { assetId: string; startSeconds: number; durationSeconds: number; caption?: string };
const record = (value: unknown): value is Data => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (data: Data, key: string): string => typeof data[key] === "string" ? data[key] : "";
function fail(code: string, message: string, status = 400): never { throw new ResourceError(code, message, status); }
const CHUNK = 256 * 1024;
const LIMIT = 128 * 1024 * 1024;
const idOf = (input: ResourceControlRequest): string => input.resourceId ?? fail("CAMPFIRE_INPUT_INVALID", "请选择真实素材或剪辑计划。");

/** Capability implementation; all decoding and rendering use the existing gVisor executor. */
export class CampfireService {
  public constructor(private readonly repository: ResourceRepository, private readonly content: ContentStore,
    private readonly executor: (request: ExecutorProcessRequest, signal?: AbortSignal) => Promise<Record<string, unknown>>,
    private readonly images: Record<string, { digest?: unknown }>) {}

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
  #extension(type: string): string { return ({ "video/mp4": "mp4", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "text/plain": "txt" } as Record<string, string>)[type] ?? fail("CAMPFIRE_TYPE_INVALID", "素材格式不支持。"); }
  async #process(workspaceId: string, executable: string, args: string[], request: ResourceControlRequest, signal: AbortSignal): Promise<Record<string, unknown>> {
    const boundedArgs = executable === "/usr/bin/ffmpeg" ? ["-threads", "1", "-filter_threads", "1", ...args] : args;
    const value = await this.executor({ action: "process", operation: "run", workspaceId, executable, args: boundedArgs, cwd: ".", timeoutMs: 180_000, runId: request.sourceRun }, signal);
    if (value.exitCode !== 0) fail("CAMPFIRE_PROCESS_FAILED", "媒体解析或剪辑失败；原素材及此前的成片已保留。", 422);
    return value;
  }
  async #inspection(auth: ExecutionIdentity, request: ResourceControlRequest, asset: Data, signal: AbortSignal): Promise<Data> {
    if (text(asset, "role") === "shop_profile") return asset;
    if (text(asset, "mediaType") === "text/plain") return { ...asset, content: (await this.content.read(text(asset, "digest"), 40000)).toString("utf8") };
    const prior = (await this.#facts(auth, text(asset, "id"))).findLast(item => item.eventType === "campfire.media.inspected");
    if (prior) return { ...asset, ...prior.payload };
    const workspaceId = await this.#workspace(auth, request, [asset]);
    const path = `${text(asset, "id")}.${this.#extension(text(asset, "mediaType"))}`;
    const probeResult = await this.#process(workspaceId, "/usr/bin/ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", path], request, signal);
    let probe: { format?: { duration?: string }; streams?: Array<{ codec_type?: string; width?: number; height?: number }> };
    try { probe = JSON.parse(String(probeResult.stdout)); } catch { fail("CAMPFIRE_PROBE_INVALID", "无法解析真实素材信息。", 422); }
    const video = probe.streams?.find(stream => stream.codec_type === "video");
    if (!video || !video.width || !video.height || video.width > 8192 || video.height > 8192) fail("CAMPFIRE_MEDIA_INVALID", "素材没有可用画面或分辨率超出处理范围。", 422);
    const isVideo = text(asset, "mediaType") === "video/mp4";
    const duration = isVideo ? Number(probe.format?.duration) : 0;
    if (isVideo && (!Number.isFinite(duration) || duration <= 0 || duration > 3600)) fail("CAMPFIRE_DURATION_INVALID", "视频时长须在 1 小时以内。", 422);
    const filter = isVideo ? `fps=1/${Math.max(duration / 6, 0.1)},scale=160:160:force_original_aspect_ratio=decrease,pad=160:160:(ow-iw)/2:(oh-ih)/2,tile=3x2` : "scale=320:320:force_original_aspect_ratio=decrease";
    await this.#process(workspaceId, "/usr/bin/ffmpeg", ["-v", "error", "-nostdin", "-y", "-i", path, "-vf", filter, "-frames:v", "1", "-q:v", "25", "frames.jpg"], request, signal);
    const exported = await this.executor({ action: "workspace_prepare", operation: "snapshot", workspaceId }, signal);
    const frame = (exported.entries as WorkspaceEntry[]).find(entry => entry.path === "frames.jpg");
    if (!frame || frame.kind !== "file" || frame.size > 14000) fail("CAMPFIRE_FRAME_INVALID", "抽样画面未能保存，未分析画面内容。", 422);
    const data: Data = { durationSeconds: duration, width: video.width, height: video.height, hasAudio: Boolean(probe.streams?.some(stream => stream.codec_type === "audio")),
      sampledFrames: isVideo ? 6 : 1, visualEvidence: { mimeType: "image/jpeg", dataBase64: (await this.content.read(frame.blobHash, 14000)).toString("base64") } };
    if (isVideo && asset.role === "reference_video") {
      const cuts = await this.#process(workspaceId, "/usr/bin/ffmpeg", ["-v", "info", "-nostdin", "-i", path, "-vf", "select=gt(scene\\,0.35),showinfo", "-an", "-f", "null", "-"], request, signal);
      const detected = [...String(cuts.stderr).matchAll(/pts_time:([0-9.]+)/gu)].map(match => Number(match[1])).filter(time => Number.isFinite(time) && time > 0 && time < duration);
      data.cutTimesSeconds = detected.slice(0, 32);
      data.cutDetection = "画面变化阈值 0.35 的启发式切点，不代表逐镜头语义识别";
      data.cutTimesTruncated = detected.length > 32;
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
    if (request.action === "resource_media_begin") {
      if (request.shopId) {
        const shop = await this.#manifest(auth, request.shopId);
        if (text(shop, "role") !== "shop_profile") fail("CAMPFIRE_SHOP_INVALID", "请选择真实店铺资料。");
      }
      if (request.role !== "reference_video" && !request.shopId) fail("CAMPFIRE_SHOP_REQUIRED", "请先选择店铺，再上传本店素材。");
      if ((request.role === "reference_video" || request.role === "shop_video") && request.mediaType !== "video/mp4" || request.role === "shop_image" && !request.mediaType?.startsWith("image/") || request.role === "shop_document" && request.mediaType !== "text/plain") fail("CAMPFIRE_TYPE_INVALID", "素材格式与用途不匹配。");
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
        const valid = type === "video/mp4" ? bytes.subarray(4, 8).toString() === "ftyp" : type === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 : type === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : type === "image/webp" ? bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP" : bytes.length <= 40000 && !bytes.includes(0);
        if (!valid) fail("CAMPFIRE_MEDIA_INVALID", "文件内容与声明的媒体格式不匹配。");
        const blob = await this.content.put(bytes);
        const asset: Data = { ...start, digest: blob.digest, createdAt: new Date().toISOString() };
        await this.#append(auth, id, "campfire.media.ready", asset, request);
        return { asset: { ...asset, id } };
      });
    }
    if (request.action === "resource_media_profile") {
      const asset: Data = { title: request.title!, content: request.content!, role: "shop_profile", mediaType: "text/plain", size: Buffer.byteLength(request.content!), createdAt: new Date().toISOString() };
      const id = await this.repository.createBusiness(auth, request.title!, "campfire.profile.ready", asset);
      return { asset: { ...asset, id } };
    }
    if (request.action === "resource_campfire_list") {
      const items = (await this.repository.businessManifests(auth)).map((row): Data => {
        const data = record(row.payload) ? row.payload : {};
        const metadata = Object.fromEntries(Object.entries(data).filter(([key]) => key !== "content" && key !== "digest"));
        return { ...metadata, id: row.id };
      }).filter(item => !request.shopId || item.id === request.shopId || item.shopId === request.shopId || item.role === "reference_video");
      return { summary: "已读取 Harness 营火素材库", items: items.slice(0, 100), hasMore: items.length > 100, untrusted: true };
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
      return { summary: "已读取真实素材", asset: await this.#inspection(auth, request, asset, signal), untrusted: true };
    }
    if (request.action === "resource_campfire_plan") {
      const shop = await this.#manifest(auth, request.shopId!);
      if (shop.role !== "shop_profile") fail("CAMPFIRE_SHOP_INVALID", "请选择本店资料。");
      if (request.referenceId && (await this.#manifest(auth, request.referenceId)).role !== "reference_video") fail("CAMPFIRE_REFERENCE_INVALID", "请选择明确标记为参考的视频。");
      const segments = request.segments!;
      if (!segments.length) fail("CAMPFIRE_PLAN_EMPTY", "剪辑计划至少需要一个真实素材片段。");
      if (segments.reduce((sum, item) => sum + item.durationSeconds, 0) > 60) fail("CAMPFIRE_PLAN_TOO_LONG", "第一版成片长度不超过 60 秒。");
      for (const segment of segments) {
        const asset = await this.#manifest(auth, segment.assetId);
        if (asset.shopId !== request.shopId || !["shop_video", "shop_image"].includes(text(asset, "role"))) fail("CAMPFIRE_REFERENCE_NOT_FOOTAGE", "成片只能使用所选店铺的实拍图片或视频，不能使用参考视频或其他店铺素材。", 403);
        const inspected = (await this.#facts(auth, segment.assetId)).findLast(item => item.eventType === "campfire.media.inspected");
        if (!inspected) fail("CAMPFIRE_INSPECT_REQUIRED", "请先实际读取每个待用素材的时长和抽样画面。", 409);
        if (asset.mediaType === "video/mp4" && segment.startSeconds + segment.durationSeconds > Number(inspected.payload.durationSeconds) + 0.05 || asset.mediaType !== "video/mp4" && segment.startSeconds !== 0) fail("CAMPFIRE_SEGMENT_RANGE_INVALID", "剪辑片段超出真实素材时长。");
      }
      const plan: Data = { title: request.title!, shopId: request.shopId!, referenceId: request.referenceId ?? null, aspectRatio: request.aspectRatio!, segments: segments as unknown as JsonValue, missingShots: request.missingShots!, createdAt: new Date().toISOString() };
      const id = await this.repository.createBusiness(auth, request.title!, "campfire.plan.saved", plan);
      return { summary: request.missingShots!.length ? "计划已保存，需先补齐缺失镜头" : "实拍剪辑计划已保存", plan: { ...plan, id }, canRender: request.missingShots!.length === 0, untrusted: true };
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
          const segments = plan.segments as unknown as Segment[];
          const assets = await Promise.all([...new Set(segments.map(segment => segment.assetId))].map(id => this.#manifest(auth, id)));
          const workspaceId = await this.#workspace(auth, request, assets);
          const [width, height] = plan.aspectRatio === "16:9" ? [1280, 720] : plan.aspectRatio === "1:1" ? [720, 720] : [720, 1280];
          let elapsed = 0; const subtitles: string[] = [];
          const stamp = (seconds: number): string => { const ms = Math.round(seconds * 1000); return `${String(Math.floor(ms/3600000)).padStart(2,"0")}:${String(Math.floor(ms/60000)%60).padStart(2,"0")}:${String(Math.floor(ms/1000)%60).padStart(2,"0")},${String(ms%1000).padStart(3,"0")}`; };
          for (const [index, segment] of segments.entries()) {
            const asset = assets.find(item => item.id === segment.assetId)!;
            const inspected = (await this.#facts(auth, segment.assetId)).findLast(item => item.eventType === "campfire.media.inspected")!.payload;
            const args = ["-v", "error", "-nostdin", "-y", ...(asset.mediaType === "video/mp4" ? ["-ss", String(segment.startSeconds)] : ["-loop", "1"]), "-i", `${segment.assetId}.${this.#extension(text(asset, "mediaType"))}`];
            if (!inspected.hasAudio) args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
            args.push("-t", String(segment.durationSeconds), "-map", "0:v:0", "-map", inspected.hasAudio ? "0:a:0" : "1:a:0", "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=25,format=yuv420p`, "-af", "apad", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-c:a", "aac", "-ar", "48000", "-ac", "2", `clip-${index}.mp4`);
            await this.#process(workspaceId, "/usr/bin/ffmpeg", args, request, signal);
            if (segment.caption?.trim()) {
              const caption = [...segment.caption].map(character => (character.codePointAt(0) ?? 0) < 32 || character === "<" || character === ">" ? " " : character).join("").trim();
              subtitles.push(`${subtitles.length + 1}\n${stamp(elapsed)} --> ${stamp(elapsed + segment.durationSeconds)}\n${caption}\n`);
            }
            elapsed += segment.durationSeconds;
          }
          await this.executor({ action: "file", operation: "write", workspaceId, path: "clips.txt", content: segments.map((_, index) => `file 'clip-${index}.mp4'`).join("\n") }, signal);
          if (subtitles.length) await this.executor({ action: "file", operation: "write", workspaceId, path: "captions.srt", content: subtitles.join("\n") }, signal);
          await this.#process(workspaceId, "/usr/bin/ffmpeg", ["-v", "error", "-nostdin", "-y", "-f", "concat", "-safe", "1", "-i", "clips.txt", ...(subtitles.length ? ["-vf", "subtitles=captions.srt:force_style='FontName=Noto Sans CJK SC,FontSize=24,Alignment=2,MarginV=60'"] : []), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-c:a", "aac", "-movflags", "+faststart", "output.mp4"], request, signal);
          const outputProbe = await this.#process(workspaceId, "/usr/bin/ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", "output.mp4"], request, signal);
          const actualDuration = Number(JSON.parse(String(outputProbe.stdout)).format?.duration);
          if (!Number.isFinite(actualDuration) || Math.abs(actualDuration - elapsed) > 1) fail("CAMPFIRE_OUTPUT_INVALID", "实际成片时长与计划不一致，未标记制作成功。", 422);
          const exported = await this.executor({ action: "workspace_prepare", operation: "snapshot", workspaceId }, signal);
          const entries = exported.entries as WorkspaceEntry[];
          const snapshot = await this.repository.recordSnapshot(auth, workspaceId, entries);
          const output = entries.find(entry => entry.path === "output.mp4");
          if (!output || output.kind !== "file" || output.size <= 0 || output.size > LIMIT) fail("CAMPFIRE_OUTPUT_INVALID", "成片未能保存或超出大小限制。", 422);
          const asset: Data = { title: plan.title!, role: "output_video", shopId: plan.shopId!, mediaType: "video/mp4", size: output.size, digest: output.blobHash, durationSeconds: actualDuration, planId, workspaceId, snapshotId: snapshot.id, createdAt: new Date().toISOString() };
          const assetId = await this.repository.createBusiness(auth, text(plan, "title"), "campfire.render.completed", asset);
          await this.#append(auth, planId, "campfire.render.result", { assetId, durationSeconds: actualDuration }, request);
          return { summary: "实拍剪辑成片已保存，可在素材库预览", asset: { ...asset, id: assetId }, untrusted: true };
        } catch (error) {
          await this.#append(auth, planId, "campfire.render.failed", { code: error instanceof ResourceError ? error.code : "CAMPFIRE_RENDER_FAILED", cancelled: signal.aborted }, request);
          throw error;
        }
      });
    }
    fail("CAMPFIRE_ACTION_INVALID", "营火操作不存在。");
  }
}
