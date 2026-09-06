import { useCallback, useSyncExternalStore } from "react";

/** Keep inert/focus behavior in sync with the same responsive breakpoint as CSS. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((notify: () => void) => {
    const media = window.matchMedia(query);
    media.addEventListener("change", notify);
    return () => media.removeEventListener("change", notify);
  }, [query]);
  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

export function readSidebarPreference(): boolean {
  try { return typeof window !== "undefined" && window.localStorage.getItem("daoyin.ui.sidebar-collapsed") === "true"; }
  catch { return false; }
}
