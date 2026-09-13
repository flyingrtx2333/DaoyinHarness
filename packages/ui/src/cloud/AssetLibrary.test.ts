import { describe, expect, it } from "vitest";
import { parseAsset, videoPreviewSource } from "./AssetLibrary.js";

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
});
