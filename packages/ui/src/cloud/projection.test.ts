import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@daoyin/harness-protocol";
import type { CloudRun } from "./client.js";
import { pendingVideoInteraction, projectTurns } from "./projection.js";
import { hasCreatedStoryVideo, storyVideoIds } from "./StoryVideos.js";

const run: CloudRun = { id: "run_1", sessionId: "session_1", requestId: "request_1", userMessage: "问题", status: "completed", finalText: "最终回答", lastEventSeq: 4, cancelRequested: false, authorizationId: "grant_1", billingAccountId: "payer_1", createdAt: "2026-09-05T12:00:00Z" };
const event = (eventSeq: number, type: string, payload: unknown, occurredAt = run.createdAt): AgentEvent => ({ id: `event_${eventSeq}`, eventSeq, type, payload, sessionId: run.sessionId, turnId: run.id, accountId: "visitor_1", scopeId: "scope_1", occurredAt }) as AgentEvent;

describe("cloud workbench transcript projection (replay fixtures)", () => {
  it("lets a created-video card own the visible completion state", () => {
    const rows = [event(1, "tool.completed", { toolCallId: "create", toolName: "story_create_video", summary: "created",
      evidence: { schemaVersion: 1, toolName: "story_create_video", result: { tool: "story_create_video", data: { id: "video_1" } }, artifacts: [], diagnostics: [] } })];
    expect(hasCreatedStoryVideo(rows, "run_1")).toBe(true);
  });

  it("does not present a continuation source lookup as the new video result", () => {
    const source = event(1, "tool.completed", { toolCallId: "lookup", toolName: "story_get_video", summary: "read",
      evidence: { schemaVersion: 1, toolName: "story_get_video", result: { tool: "story_get_video", data: { id: "old_video" } }, artifacts: [], diagnostics: [] } });
    const confirmation = event(2, "interaction.requested", { interactionId: "interaction_1", toolCallId: "confirm",
      kind: "video_confirmation", operation: "story_create_video", input: { source_video_id: "old_video" } });
    expect(storyVideoIds([source], "run_1")).toEqual(["old_video"]);
    expect(storyVideoIds([source, confirmation], "run_1")).toEqual([]);
    const created = event(3, "tool.completed", { toolCallId: "create", toolName: "story_create_video", summary: "created",
      evidence: { schemaVersion: 1, toolName: "story_create_video", result: { tool: "story_create_video", data: { id: "new_video" } }, artifacts: [], diagnostics: [] } });
    expect(storyVideoIds([source, confirmation, created], "run_1")).toEqual(["new_video"]);
  });

  it("displays stable image references before the answer and preserves them after cancellation/replay", () => {
    const image = { image_id: 3, event_id: 2, image_kind: "highlight", title: "赛事照片", url: "https://evil.invalid/tracker" };
    const completed = event(1, "tool.completed", { toolCallId: "photos", toolName: "saishi_list_images", evidence: { result: { tool: "saishi_list_images", data: { items: [image, image, { ...image, image_id: -1 }, { ...image, image_kind: "../../" }] } } } });
    const expected = [{ id: 3, eventId: 2, kind: "highlight", title: "赛事照片" }];
    expect(projectTurns([{ ...run, status: "running" }], [completed])[0]?.images).toEqual(expected);
    expect(projectTurns([{ ...run, status: "cancelled" }], [completed, completed])[0]?.images).toEqual(expected);
    expect(projectTurns([run], [{ ...completed, turnId: "foreign" }])[0]?.images).toEqual([]);
    expect(JSON.stringify(expected)).not.toContain("evil.invalid");
  });
  it("appends chunks within a block and separates model steps while retaining live tool state", () => {
    const events = [event(1, "assistant.delta", { delta: "先查询", contentBlockId: "pre" }),
      event(2, "phase.updated", { phase: "tool", displayText: "正在执行查询…", step: 0 }),
      event(3, "tool.started", { toolCallId: "lookup", toolName: "saishi_list_events", displayText: "raw" }),
      event(4, "tool.progress", { toolCallId: "lookup", toolName: "saishi_list_events", displayText: "已读取目录…" }),
      event(5, "assistant.delta", { delta: "结果", contentBlockId: "answer" }),
      event(6, "assistant.delta", { delta: "如下", contentBlockId: "answer" })];
    const result = projectTurns([{ ...run, status: "running" }], events)[0];
    expect(result?.text).toBe("先查询\n\n结果如下");
    expect(result?.phaseText).toBe("正在执行查询…");
    expect(result?.tools[0]).toMatchObject({ status: "running", text: "已读取目录…" });
    expect(projectTurns([{ ...run, status: "cancelled" }], events)[0]?.tools[0]?.status).toBe("failed");
  });
  it("orders turns chronologically and never duplicates replayed deltas", () => {
    const delta = event(1, "assistant.delta", { delta: "答案", contentBlockId: "block_1" });
    const projected = projectTurns([{ ...run, id: "run_2" }, run], [delta, delta]);
    expect(projected.map((turn) => turn.run.id)).toEqual(["run_1", "run_2"]);
    expect(projected[0]?.text).toBe("答案");
    expect(projected[1]?.text).toBe("最终回答");
  });
  it("keeps the latest assistant event time for the rendered reply", () => {
    const projected = projectTurns([run], [
      event(1, "assistant.delta", { delta: "先", contentBlockId: "block_1" }, "2026-09-05T12:01:00Z"),
      event(2, "assistant.delta", { delta: "后", contentBlockId: "block_1" }, "2026-09-05T12:02:00Z"),
      event(3, "turn.completed", { status: "completed", assistantMessageId: "answer", outcomeSummary: "完成" }, "2026-09-05T12:03:00Z")
    ]);
    expect(projected[0]?.assistantOccurredAt).toBe("2026-09-05T12:03:00Z");
  });
  it("projects only public source fields and marks unfinished tools stopped after cancellation", () => {
    const completed = event(2, "tool.completed", { toolCallId: "tool_1", toolName: "search_company_knowledge", summary: "raw", evidence: { result: { sources: [{ id: "source_1", title: "公开文档", content: "公开正文", location: "段落 1", secret: "DO_NOT_RENDER", signed_media_url: "https://private.invalid" }] } } });
    const started = event(3, "tool.started", { toolCallId: "tool_2", toolName: "search_company_knowledge", displayText: "raw" });
    const result = projectTurns([{ ...run, status: "cancelled", finalText: "任务已取消" }], [completed, started])[0];
    expect(result?.sources).toEqual([{ id: "source_1", title: "公开文档", content: "公开正文", location: "段落 1" }]);
    expect(result?.tools[1]?.status).toBe("failed");
    expect(result?.text).toBe("任务已取消");
    expect(JSON.stringify(result?.sources)).not.toContain("private.invalid");
  });
  it("does not project a foreign run into the selected conversation or mark queued work ended", () => {
    const foreign = { ...event(1, "assistant.delta", { delta: "foreign", contentBlockId: "block" }), turnId: "foreign" };
    const result = projectTurns([{ ...run, status: "queued", finalText: "" }], [foreign])[0];
    expect(result?.text).toBe("");
  });
  it("replays one pending video interaction until its matching resolution is persisted", () => {
    const requested = event(1, "interaction.requested", { interactionId: "interaction_1", toolCallId: "confirm_1",
      kind: "video_confirmation", operation: "story_create_video", input: { prompt: "追逐", durationSeconds: 10 },
      estimate: { estimated_balance_consumption_credits: "12.5" } });
    expect(pendingVideoInteraction([requested], run.sessionId)).toEqual({ interactionId: "interaction_1", runId: run.id,
      operation: "story_create_video", input: { prompt: "追逐", durationSeconds: 10 },
      estimate: { estimated_balance_consumption_credits: "12.5" } });
    const resolved = event(2, "interaction.resolved", { interactionId: "interaction_1", toolCallId: "confirm_1", resolution: "confirmed", input: { prompt: "追逐" } });
    expect(pendingVideoInteraction([requested, resolved], run.sessionId)).toBeUndefined();
    const interrupted = event(2, "turn.interrupted", { status: "interrupted", reason: "runtime_restart", lastCompletedEventSeq: 1 });
    expect(pendingVideoInteraction([requested, interrupted], run.sessionId)).toBeUndefined();
    expect(pendingVideoInteraction([{ ...requested, sessionId: "foreign" }], run.sessionId)).toBeUndefined();
  });
});
