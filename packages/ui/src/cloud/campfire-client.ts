import type { WorkbenchClient } from "./client.js";

export type CampfireRole = "shop_profile" | "shop_document" | "shop_image" | "shop_video" | "reference_video" | "output_video";
export interface CampfireAsset { id: string; title: string; role: CampfireRole; mediaType: string; shopId?: string; size: number; content?: string; durationSeconds?: number }
export interface CampfireSelection { shopId: string; shopTitle: string; referenceId?: string; referenceTitle?: string }
export const CAMPFIRE_LABELS: Record<CampfireRole, string> = { shop_profile: "店铺资料", shop_document: "店铺文档", shop_image: "实拍图片", shop_video: "实拍视频", reference_video: "参考视频", output_video: "剪辑成片" };
const roles = Object.keys(CAMPFIRE_LABELS);
export function campfireAsset(value: unknown): CampfireAsset {
  if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string" || !/^res_[a-f0-9]{24}$/u.test(value.id) ||
      !("title" in value) || typeof value.title !== "string" || !("role" in value) || !roles.includes(String(value.role)) || !("mediaType" in value) || typeof value.mediaType !== "string") throw new Error("营火素材数据无效。");
  return value as CampfireAsset;
}
export async function campfireList(client: WorkbenchClient): Promise<{ items: CampfireAsset[]; hasMore: boolean }> {
  const result = await client.resource<{ items: unknown[]; hasMore?: boolean }>({ action: "resource_campfire_list" });
  return { items: result.items.map(campfireAsset), hasMore: result.hasMore === true };
}
export async function campfireProfile(client: WorkbenchClient, title: string, content: string): Promise<CampfireAsset> {
  return campfireAsset((await client.resource<{ asset: unknown }>({ action: "resource_media_profile", title, content })).asset);
}
export async function campfireUpload(client: WorkbenchClient, file: File, role: Exclude<CampfireRole, "shop_profile" | "output_video">, shopId?: string, onProgress?: (percent: number) => void): Promise<CampfireAsset> {
  const mediaType = role === "shop_document" && /\.(?:txt|md)$/iu.test(file.name) ? "text/plain" : file.type;
  if (!file.size || file.size > 128 * 1024 * 1024 || !["image/jpeg", "image/png", "image/webp", "video/mp4", "text/plain"].includes(mediaType) || mediaType === "text/plain" && file.size > 40000) throw new Error("请选择 128MB 内图片/MP4，或 40KB 内 TXT/Markdown 店铺资料。");
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
  const epoch = client.accountScope; const chunks: Uint8Array<ArrayBuffer>[] = []; let offset = 0;
  for (;;) {
    signal?.throwIfAborted();
    const result = await client.resource<{ contentBase64: string; nextOffset: number; size: number; done: boolean; mediaType: string }>({ action: "resource_media_read", resourceId: asset.id, offset });
    signal?.throwIfAborted();
    if (epoch !== client.accountScope) throw new Error("账号已变化，请重新查看当前账号素材。");
    const raw = atob(result.contentBase64); const bytes = new Uint8Array(raw.length); for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
    if (result.nextOffset !== offset + bytes.length || result.size > 128 * 1024 * 1024 || !result.done && !bytes.length) throw new Error("素材读取未完成。");
    chunks.push(bytes); offset = result.nextOffset;
    if (result.done) return new Blob(chunks, { type: result.mediaType });
  }
}
