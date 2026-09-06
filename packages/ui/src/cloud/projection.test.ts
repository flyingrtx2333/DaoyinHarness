import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@daoyin/harness-protocol";
import type { CloudRun } from "./client.js";
import { projectTurns } from "./projection.js";

const run: CloudRun = { id: "run_1", sessionId: "session_1", requestId: "request_1", userMessage: "问题", status: "completed", finalText: "最终回答", lastEventSeq: 4, cancelRequested: false, authorizationId: "grant_1", billingAccountId: "payer_1", createdAt: "2026-09-05T12:00:00Z" };
const event = (eventSeq: number, type: string, payload: unknown, occurredAt = run.createdAt): AgentEvent => ({ id: `event_${eventSeq}`, eventSeq, type, payload, sessionId: run.sessionId, turnId: run.id, accountId: "visitor_1", scopeId: "scope_1", occurredAt }) as AgentEvent;

describe("cloud workbench transcript projection (replay fixtures)", () => {
  it("appends chunks within a block and separates model steps while retaining live tool state", () => {
    const events = [event(1, "assistant.delta", { delta: "先查询", contentBlockId: "pre" }),
      event(2, "tool.started", { toolCallId: "lookup", toolName: "saishi_list_events", displayText: "raw" }),
      event(3, "assistant.delta", { delta: "结果", contentBlockId: "answer" }),
      event(4, "assistant.delta", { delta: "如下", contentBlockId: "answer" })];
    const result = projectTurns([{ ...run, status: "running" }], events)[0];
    expect(result?.text).toBe("先查询\n\n结果如下");
    expect(result?.tools[0]).toMatchObject({ status: "running", text: "正在查询赛事列表…" });
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
});
