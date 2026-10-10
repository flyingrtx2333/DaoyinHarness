import type { WorkbenchClient } from "./client.js";

export type CampfireRole = "shop_profile" | "shop_document" | "shop_image" | "shop_video" | "reference_video" | "narration_audio" | "background_music" | "output_video";
export interface CampfireAsset { id: string; title: string; role: CampfireRole; mediaType: string; shopId?: string; size: number; content?: string; durationSeconds?: number; width?: number; height?: number; version?: number; analysisStatus?: "queued" | "running" | "completed" | "failed"; analysisProgress?: number; message?: string; analysis?: { summary: string; actions: Array<{label:string;startSeconds:number;endSeconds:number;confidence:number}> }; systemPreset?: string; origin?: "ai"; generated?: boolean; generatedSegments?: number[] }
export interface CampfireSelection { shopId: string; shopTitle: string; referenceId?: string; referenceTitle?: string; requirements?: string }
export const CAMPFIRE_LABELS: Record<CampfireRole, string> = { shop_profile: "店铺资料", shop_document: "店铺文档", shop_image: "实拍图片", shop_video: "实拍视频", reference_video: "参考视频", narration_audio: "旁白音轨", background_music: "背景音乐", output_video: "剪辑成片" };
const roles = Object.keys(CAMPFIRE_LABELS);
export function campfireAssetLabel(asset: CampfireAsset): string { return asset.origin === "ai" ? "AI 演绎视频" : CAMPFIRE_LABELS[asset.role]; }
export function campfireAsset(value: unknown): CampfireAsset {
  if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string" || !/^res_[a-f0-9]{24}$/u.test(value.id) ||
      !("title" in value) || typeof value.title !== "string" || !("role" in value) || !roles.includes(String(value.role)) || !("mediaType" in value) || typeof value.mediaType !== "string") throw new Error("营火素材数据无效。");
  return value as CampfireAsset;
}
export interface CampfirePageOptions { shopId?: string; filterRole?: CampfireRole; pageCursor?: string; limit?: number }
export function mergeCampfireAssets(previous: CampfireAsset[], incoming: CampfireAsset[]): CampfireAsset[] {
  return [...new Map([...previous, ...incoming].map(item => [item.id, item])).values()];
}
export async function campfireList(client: WorkbenchClient, options: CampfirePageOptions = {}, signal?: AbortSignal): Promise<{ items: CampfireAsset[]; nextCursor: string | null }> {
  const epoch = client.accountScope;
  const result = await client.resource<{ items: unknown[]; systemPresets?: unknown[]; hasMore?: boolean; nextCursor?: string | null }>({ action: "resource_campfire_list", ...options }, signal);
  if (epoch !== client.accountScope) throw new Error("账号已变化，请刷新当前账号素材。");
  if (result.hasMore && typeof result.nextCursor !== "string") throw new Error("素材分页未完成，请刷新后重试。");
  return { items: mergeCampfireAssets((result.systemPresets ?? []).map(campfireAsset), result.items.map(campfireAsset)), nextCursor: result.hasMore ? result.nextCursor! : null };
}
export async function campfireProfile(client: WorkbenchClient, title: string, content: string, previous?: CampfireAsset): Promise<CampfireAsset> {
  return campfireAsset((await client.resource<{ asset: unknown }>({ action: "resource_media_profile", title, content, ...(previous ? { resourceId: previous.id, expectedVersion: previous.version ?? 1 } : {}) })).asset);
}
export async function campfireReadProfile(client: WorkbenchClient, resourceId: string): Promise<CampfireAsset> {
  const epoch = client.accountScope;
  const result = campfireAsset((await client.resource<{ asset: unknown }>({ action: "resource_campfire_inspect", resourceId })).asset);
  if (epoch !== client.accountScope || result.role !== "shop_profile") throw new Error("店铺资料已变化，请刷新后重试。");
  return result;
}
export async function campfireUpload(client: WorkbenchClient, file: File, role: Exclude<CampfireRole, "shop_profile" | "output_video">, shopId?: string, onProgress?: (percent: number) => void): Promise<CampfireAsset> {
  const mediaType = role === "shop_document" && /\.(?:txt|md)$/iu.test(file.name) ? "text/plain" : file.type === "audio/x-wav" ? "audio/wav" : file.type === "audio/x-m4a" ? "audio/mp4" : file.type;
  if (!file.size || file.size > 128 * 1024 * 1024 || !["image/jpeg", "image/png", "image/webp", "video/mp4", "text/plain", "audio/mpeg", "audio/wav", "audio/mp4"].includes(mediaType) || mediaType === "text/plain" && file.size > 40000) throw new Error("请选择128MB内图片、MP4、MP3/WAV/M4A，或40KB内TXT/Markdown资料。");
  const epoch = client.accountScope;
  const started = await client.resource<{ resourceId: string; chunkBytes: number }>({ action: "resource_media_begin", title: file.name.slice(0, 120), role, mediaType, size: file.size, ...(shopId ? { shopId } : {}) });
  for (let offset = 0, index = 0; offset < file.size; offset += started.chunkBytes, index++) {
    if (epoch !== client.accountScope) throw new Error("账号已变化，请在当前账号重新上传。");
    const bytes = new Uint8Array(await file.slice(offset, offset + started.chunkBytes).arrayBuffer());
    let binary = ""; for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
    await client.resource({ action: "resource_media_chunk", resourceId: started.resourceId, index, contentBase64: btoa(binary) });
    onProgress?.(Math.min(99, Math.floor((offset + bytes.length) / file.size * 100)));
  }
  if (epoch !== client.accountScope) throw new Error("账号已变化，请在当前账号重新上传。");
  const result = await client.resource<{ asset: unknown }>({ action: "resource_media_commit", resourceId: started.resourceId });
  onProgress?.(100); return campfireAsset(result.asset);
}
export async function campfireBlob(client: WorkbenchClient, asset: CampfireAsset, signal?: AbortSignal): Promise<Blob> {
  const epoch = client.accountScope; const chunks: Uint8Array<ArrayBuffer>[] = [];
  const chunkSize = 256 * 1024;
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 128 * 1024 * 1024) throw new Error("素材大小无效。");
  const count = Math.ceil(asset.size / chunkSize);
  async function read(index: number): Promise<Uint8Array<ArrayBuffer>> {
    signal?.throwIfAborted();
    if (epoch !== client.accountScope) throw new Error("账号已变化，请重新查看当前账号素材。");
    const offset = index * chunkSize;
    const result = await client.resource<{ contentBase64: string; nextOffset: number; size: number; done: boolean; mediaType: string }>({ action: "resource_media_read", resourceId: asset.id, offset }, signal);
    signal?.throwIfAborted();
    if (epoch !== client.accountScope) throw new Error("账号已变化，请重新查看当前账号素材。");
    const raw = atob(result.contentBase64); const bytes = new Uint8Array(raw.length); for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
    if (result.size !== asset.size || result.mediaType !== asset.mediaType || bytes.length !== Math.min(chunkSize, asset.size - offset) || result.nextOffset !== offset + bytes.length || result.done !== (result.nextOffset === asset.size)) throw new Error("素材读取未完成。");
    return bytes;
  }
  // Immutable blobs allow bounded concurrent reads; keep cancellation/account checks per chunk.
  for (let start = 0; start < count; start += 4) chunks.push(...await Promise.all(Array.from({ length: Math.min(4, count - start) }, (_, index) => read(start + index))));
  signal?.throwIfAborted();
  if (epoch !== client.accountScope) throw new Error("账号已变化，请重新查看当前账号素材。");
  return new Blob(chunks, { type: asset.mediaType });
}
