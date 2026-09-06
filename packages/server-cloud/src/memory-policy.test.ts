import { describe, expect, it } from "vitest";
import { memoryRelevance, memoryTokens, normalizeMemoryProposal, type DurableMemory, type MemoryProposal } from "./memory-policy.js";

const proposal: MemoryProposal = { requestId: "request", key: "Video.Format", scope: "personal", kind: "preference",
  content: " 视频使用竖屏。 ", keywords: ["视频", "视频", "竖屏"] };
const record: DurableMemory = { id: "memory", revision: 2, state: "active", key: "video.format", scope: "personal",
  kind: "preference", content: "视频使用竖屏，字幕简洁。", keywords: ["视频", "格式"], createdBy: "alice", originAppId: "story",
  source: { kind: "user_edit", requestId: "request" }, expiresAt: null, createdAt: Date.now(), supersedes: null };

describe("memory policy and Chinese/English lexical retrieval (pure logic)", () => {
  it("normalizes keys and repeated tags without mutating the proposal", () => {
    const normalized = normalizeMemoryProposal(proposal);
    expect(normalized.key).toBe("video.format");
    expect(normalized.content).toBe("视频使用竖屏。");
    expect(normalized.keywords).toEqual(["视频", "竖屏"]);
    expect(proposal.key).toBe("Video.Format");
  });

  it("rejects forged ownership, unsupported scope, oversized data and expired records", () => {
    for (const extra of [
      { tenantId: "foreign" }, { actorUserId: "other" }, { scope: "public" },
      { content: "x".repeat(2001) }, { keywords: new Array(17).fill("tag") },
      { expiresAt: Date.now() - 1 }, { replaces: { id: "other", revision: 0 } },
    ]) expect(() => normalizeMemoryProposal({ ...proposal, ...extra } as MemoryProposal)).toThrow();
  });

  it("matches meaningful Chinese pairs and English phrases without matching one common character", () => {
    expect(memoryTokens("的 视频 Portrait Format")).toEqual(new Set(["视频", "portrait", "format"]));
    expect(memoryRelevance(record, "视频格式")).not.toBeNull();
    expect(memoryRelevance(record, "video format")).not.toBeNull();
    expect(memoryRelevance(record, "天气预报")).toBeNull();
    expect(memoryRelevance(record, "的")).toBeNull();
  });

  it("does not let recency alone make an unrelated record relevant", () => {
    expect(memoryRelevance({ ...record, createdAt: Date.now() }, "数据库备份")).toBeNull();
    expect(memoryRelevance(record, "视频")?.reasons).toContain("phrase");
  });
});
