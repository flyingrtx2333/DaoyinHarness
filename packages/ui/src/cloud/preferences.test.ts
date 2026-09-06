import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, isSendShortcut, readPreferences } from "./preferences.js";

describe("workbench preferences", () => {
  it("accepts supported preferences and recovers from unavailable or invalid storage", () => {
    expect(readPreferences({ getItem: () => '{"sendShortcut":"modifier-enter","autoScroll":false}' })).toEqual({ sendShortcut: "modifier-enter", autoScroll: false });
    for (const value of ["broken", "null", '{"sendShortcut":"shell","autoScroll":7}']) expect(readPreferences({ getItem: () => value })).toEqual(DEFAULT_PREFERENCES);
    expect(readPreferences({ getItem: () => { throw new Error("blocked"); } })).toEqual(DEFAULT_PREFERENCES);
  });
  it("honors the send shortcut without submitting IME composition or Shift+Enter", () => {
    const enter = { key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false };
    expect(isSendShortcut(enter, DEFAULT_PREFERENCES)).toBe(true);
    const modifier = { ...DEFAULT_PREFERENCES, sendShortcut: "modifier-enter" as const };
    expect(isSendShortcut(enter, modifier)).toBe(false);
    expect(isSendShortcut({ ...enter, ctrlKey: true }, modifier)).toBe(true);
    expect(isSendShortcut({ ...enter, metaKey: true }, modifier)).toBe(true);
    expect(isSendShortcut({ ...enter, ctrlKey: true, isComposing: true }, modifier)).toBe(false);
    expect(isSendShortcut({ ...enter, shiftKey: true }, DEFAULT_PREFERENCES)).toBe(false);
  });
});
