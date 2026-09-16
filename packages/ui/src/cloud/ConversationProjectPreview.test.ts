import { describe, expect, it } from "vitest";
import { completedPreviewOperation, safePreviewUrl } from "./ConversationProjectPreview.js";

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
});
