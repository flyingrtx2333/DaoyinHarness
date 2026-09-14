import { describe, expect, it } from "vitest";
import type { ToolDescriptor } from "@daoyin/harness-tools/registry";
import {
  routeCapabilities, splitCapabilityIntents, type CapabilityPackManifest,
} from "./capability-router.js";
import { capabilityPacksFor, explicitHighRiskPacks } from "./capability-packs.js";

const tool = (name: string, mutating = false, padding = ""): ToolDescriptor => ({
  name, description: name + padding, category: "extension", mutating,
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
});
const pack = (id: string, names: string[], risk: "read" | "write" | "high",
  intents: string[]): CapabilityPackManifest => ({
  id, version: "1", title: id, summary: intents.join(" "), intents, examples: intents,
  negativeExamples: [], toolNames: names, dependencies: [], resourceKinds: [], requiredContext: [], risk,
});

describe("capability router", () => {
  it("splits multiple Chinese intents without splitting protected values", () => {
    expect(splitCapabilityIntents("查素材，然后创建网站，并且发布")).toEqual(["查素材", "创建网站", "发布"]);
    expect(splitCapabilityIntents("打开 https://example.com/a,b 然后检查"))
      .toEqual(["打开 https://example.com/a,b", "检查"]);
  });
  it("blocks high risk packs unless current-turn policy explicitly pins them", async () => {
    const tools = [tool("project_files"), tool("project_publish", true)];
    const packs = [
      pack("project.source", ["project_files"], "read", ["修改网站"]),
      pack("project.release", ["project_publish"], "high", ["发布网站"]),
    ];
    const hidden = await routeCapabilities({
      message: "讨论一下发布网站", packs, tools, signal: new AbortController().signal,
    });
    expect(hidden.decision.blockedHighRiskPackIds).toEqual(["project.release"]);
    expect(hidden.selectedToolNames.has("project_publish")).toBe(false);
    const shown = await routeCapabilities({
      message: "发布当前项目", packs, tools, explicitHighRiskPackIds: ["project.release"],
      pinnedPackIds: ["project.release"], signal: new AbortController().signal,
    });
    expect(shown.selectedToolNames.has("project_publish")).toBe(true);
  });
  it("falls back locally when semantic classification is invalid", async () => {
    const tools = [tool("search_events")];
    const packs = [pack("profile.search.1", ["search_events"], "read", ["查询活动"])];
    const result = await routeCapabilities({
      message: "查询活动", packs, tools, semantic: { analyze: async () => ({
        rerankScores: { unknown: 1 }, intents: [],
      }) }, signal: new AbortController().signal,
    });
    expect(result.decision.fallback).toBe("lexical");
    expect(result.selectedToolNames.has("search_events")).toBe(true);
  });
  it("recalls a semantically related pack that BM25 cannot find", async () => {
    const tools = [tool("weather_lookup"), tool("event_lookup")];
    const packs = [
      pack("weather.read", ["weather_lookup"], "read", ["气象预报"]),
      pack("event.read", ["event_lookup"], "read", ["校园活动"]),
    ];
    const result = await routeCapabilities({
      message: "出门要不要带伞", packs, tools,
      semantic: {
        retrieve: async () => ({ "weather.read": 0.92, "event.read": 0.08 }),
        analyze: async () => ({
          rerankScores: { "weather.read": 0.94 },
          intents: [{ label: "weather.query", objective: "查询天气",
            confidence: 0.91, packIds: ["weather.read"] }],
        }),
      }, signal: new AbortController().signal,
    });
    expect(result.decision.fallback).toBe("none");
    expect(result.selectedToolNames.has("weather_lookup")).toBe(true);
    expect(result.selectedToolNames.has("event_lookup")).toBe(false);
  });
  it("keeps BM25 routing when vector retrieval fails", async () => {
    const tools = [tool("search_events")];
    const packs = [pack("profile.search.1", ["search_events"], "read", ["查询活动"])];
    const result = await routeCapabilities({
      message: "查询活动", packs, tools,
      semantic: {
        retrieve: async () => { throw new Error("embedding unavailable"); },
        analyze: async () => ({ rerankScores: { "profile.search.1": 1 }, intents: [] }),
      }, signal: new AbortController().signal,
    });
    expect(result.decision.fallback).toBe("lexical");
    expect(result.selectedToolNames.has("search_events")).toBe(true);
  });
  it("expands only readonly packs", async () => {
    const tools = [tool("read_a"), tool("read_b"), tool("write_c", true)];
    const packs = [
      pack("read.a", ["read_a"], "read", ["苹果"]),
      pack("read.b", ["read_b"], "read", ["香蕉"]),
      pack("write.c", ["write_c"], "write", ["香蕉写入"]),
    ];
    const result = await routeCapabilities({
      message: "苹果", packs, tools, signal: new AbortController().signal,
    });
    const expanded = result.expandReadonly("香蕉");
    expect(expanded.addedPackIds).toContain("read.b");
    expect(expanded.selectedToolNames.has("write_c")).toBe(false);
  });
  it("bounds a 1000-tool inventory", async () => {
    const tools = Array.from({ length: 1_000 }, (_, index) =>
      tool("tool_" + String(index), false, "x".repeat(200)));
    const packs = Array.from({ length: 100 }, (_, index) =>
      pack("pack." + String(index), tools.slice(index * 10, index * 10 + 10).map((item) => item.name),
        "read", [index < 10 ? "查询综合数据" : "无关能力"]));
    const result = await routeCapabilities({
      message: "查询综合数据", packs, tools, signal: new AbortController().signal,
    });
    expect(result.decision.selectedPackIds.length).toBeLessThanOrEqual(6);
    expect(result.decision.exposedToolCount).toBeLessThanOrEqual(48);
    expect(result.decision.schemaCharacters).toBeLessThanOrEqual(48_000);
  });
});
describe("capability pack policy", () => {
  it("separates read, write and high-risk profile tools", () => {
    const packs = capabilityPacksFor([
      tool("story_list_projects"),
      tool("story_update_project", true),
      tool("story_delete_project", true),
    ]);
    expect(packs.find((item) => item.toolNames.includes("story_list_projects"))?.risk).toBe("read");
    expect(packs.find((item) => item.toolNames.includes("story_update_project"))?.risk).toBe("write");
    expect(packs.find((item) => item.toolNames.includes("story_delete_project"))?.risk).toBe("high");
  });

  it("requires a non-negated current-message action to activate high risk", () => {
    const packs = capabilityPacksFor([
      tool("project_publish", true),
      tool("story_delete_project", true),
      tool("story_create_video", true),
    ]);
    expect(explicitHighRiskPacks("只修改代码，请不要发布", packs)).toEqual([]);
    expect(explicitHighRiskPacks("查询素材，然后发布当前项目", packs)).toContain("project.release");
    expect(explicitHighRiskPacks("制作一段视频", packs).some((id) => id.includes("story.high"))).toBe(true);
  });
});
