export interface WorkbenchPreferences { sendShortcut: "enter" | "modifier-enter"; autoScroll: boolean }
export const DEFAULT_PREFERENCES: WorkbenchPreferences = { sendShortcut: "enter", autoScroll: true };
export const PREFERENCES_KEY = "daoyin-harness-workbench-preferences-v1";

export function readPreferences(storage: Pick<Storage, "getItem">): WorkbenchPreferences {
  try {
    const value: unknown = JSON.parse(storage.getItem(PREFERENCES_KEY) ?? "null");
    if (typeof value !== "object" || value === null) return DEFAULT_PREFERENCES;
    return {
      sendShortcut: "sendShortcut" in value && value.sendShortcut === "modifier-enter" ? "modifier-enter" : "enter",
      autoScroll: !("autoScroll" in value) || value.autoScroll !== false,
    };
  } catch { return DEFAULT_PREFERENCES; }
}

export function isSendShortcut(event: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; isComposing: boolean }, preferences: WorkbenchPreferences): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing &&
    (preferences.sendShortcut === "enter" || event.ctrlKey || event.metaKey);
}
