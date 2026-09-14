import { describe, expect, it } from "vitest";
import { parseAsset, publishedProjectUrl, videoPreviewSource } from "./AssetLibrary.js";
describe("asset media previews", () => {
  it("keeps the server-provided video thumbnail", () => {
    const asset = parseAsset({
      id: "video-1",
      title: "video",
      category: "video",
      media_type: "video",
      url: "https://media.example/video.mp4",
      thumbnail_url: "https://media.example/last-frame.jpg",
    });
    expect(asset.previewUrl).toBe("https://media.example/last-frame.jpg");
  });
  it("rejects unsafe preview URLs and can request an early video frame", () => {
    const asset = parseAsset({
      id: "video-2",
      title: "video",
      category: "video",
      media_type: "video",
      url: "https://media.example/video.mp4?version=2",
      thumbnail_url: "http://media.example/unsafe.jpg",
    });
    expect(asset.previewUrl).toBeUndefined();
    expect(videoPreviewSource(asset.url!)).toBe("https://media.example/video.mp4?version=2#t=0.1");
  });
  it("shows only published projects on an owned demo domain", () => {
    expect(publishedProjectUrl({ id: "prj_1", title: "Dashboard", slug: "dashboard-1", activeVersion: "ver_1" }))
      .toBe("https://dashboard-1.demo.daoyintech.com/");
    expect(publishedProjectUrl({ id: "prj_2", title: "Draft", slug: "draft", activeVersion: null })).toBeUndefined();
    expect(publishedProjectUrl({ id: "prj_3", title: "Unsafe", slug: "evil.example", activeVersion: "ver_1" })).toBeUndefined();
  });
});
