import { describe, expect, it } from "vitest";
import { WorkbenchError } from "./client.js";
import { completedPreviewOperation, previewNeedsRestart, safePreviewUrl } from "./ConversationProjectPreview.js";

const projectId = "prj_412187209e7d6f7a369ed98e";
describe("conversation project preview", () => {
  it("uses only a completed running preview", () => {
    const operations = [
      { id: "new", kind: "preview", status: "failed", result: null },
      { id: "ready", kind: "preview", status: "completed", result: { running: true } },
      { id: "check", kind: "check", status: "completed", result: { running: false } },
    ];
    expect(completedPreviewOperation(operations)?.id).toBe("ready");
  });
  it("accepts only the isolated preview origin and one ticket", () => {
    const ticket = "a".repeat(43);
    expect(safePreviewUrl(projectId, `https://p-412187209e7d6f7a369ed98e.demo.daoyintech.com/__preview?ticket=${ticket}`)).toContain(ticket);
    expect(safePreviewUrl(projectId, `https://evil.example/__preview?ticket=${ticket}`)).toBeNull();
    expect(safePreviewUrl(projectId, `https://p-412187209e7d6f7a369ed98e.demo.daoyintech.com/__preview?ticket=${ticket}&next=evil`)).toBeNull();
  });

  it("restarts only an explicitly sleeping preview", () => {
    expect(previewNeedsRestart(new WorkbenchError("预览已休眠，请重新启动。", 409))).toBe(true);
    expect(previewNeedsRestart(new WorkbenchError("请先生成预览。", 409))).toBe(false);
    expect(previewNeedsRestart(new WorkbenchError("预览已休眠，请重新启动。", 503))).toBe(false);
  });
});
