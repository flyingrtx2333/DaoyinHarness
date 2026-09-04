import { describe, expect, it, vi } from "vitest";
import type { BrowserService, BrowserSnapshot } from "@daoyin/harness-browser";
import { createBrowserTools } from "./browser-tools.js";
import { ToolRegistry } from "./registry.js";

const snapshot: BrowserSnapshot = {
  url: "https://example.com/",
  title: "Example",
  text: "Example page",
  elements: [
    { ref: "e1", tag: "input", role: "", text: "", name: "Search", type: "text", href: "", disabled: false },
  ],
};

describe("browser tools", () => {
  it("redacts browser_type text from persisted audit input while passing the real text to execution", async () => {
    const type = vi.fn(async () => snapshot);
    const service = {
      type,
      open: vi.fn(async () => snapshot),
      snapshot: vi.fn(async () => snapshot),
      click: vi.fn(async () => snapshot),
      back: vi.fn(async () => snapshot),
      closeSession: vi.fn(async () => undefined),
    } as unknown as BrowserService;
    const registry = new ToolRegistry(createBrowserTools(service));

    expect(registry.auditInput("browser_type", { ref: "e1", text: "private form content", submit: true })).toEqual({
      ref: "e1",
      text: "[redacted]",
      textLength: 20,
      submit: true,
    });

    const result = await registry.execute(
      { id: "call_type", name: "browser_type", input: { ref: "e1", text: "private form content", submit: true } },
      new AbortController().signal,
      { accountId: "account", scopeId: "scope", sessionId: "session", turnId: "turn", sourceEventIds: [] },
    );

    expect(result.ok).toBe(true);
    expect(type).toHaveBeenCalledWith("session", "e1", "private form content", true, expect.any(AbortSignal));

    await expect(registry.execute(
      { id: "call_clear", name: "browser_type", input: { ref: "e1", text: "", submit: false } },
      new AbortController().signal,
      { accountId: "account", scopeId: "scope", sessionId: "session", turnId: "turn", sourceEventIds: [] },
    )).resolves.toMatchObject({ ok: true });
    expect(type).toHaveBeenCalledWith("session", "e1", "", false, expect.any(AbortSignal));
  });

  it("exposes the browser pack as browser-category tools with click/type marked mutating", () => {
    const service = {} as BrowserService;
    const registry = new ToolRegistry(createBrowserTools(service));
    const descriptors = registry.descriptors();
    expect(descriptors.map((descriptor) => descriptor.name)).toEqual([
      "browser_open",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_back",
      "browser_close",
    ]);
    expect(descriptors.find((descriptor) => descriptor.name === "browser_click")).toMatchObject({ category: "browser", mutating: true });
    expect(descriptors.find((descriptor) => descriptor.name === "browser_type")).toMatchObject({ category: "browser", mutating: true });
  });
});
