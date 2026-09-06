type IconName = "chat" | "plugin" | "edit" | "search" | "user" | "globe" | "book" | "story" | "image" | "pin" | "arrow" | "stop" | "chevron" | "connection" | "menu" | "settings" | "logout" | "plus";

const paths: Record<IconName, string> = {
  chat: "M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2Zm2 5h10M7 13h6",
  plugin: "M9 3H4v6H2a3 3 0 0 0 0 6h2v6h6v-2a3 3 0 0 1 6 0v2h5v-6h-2a3 3 0 0 1 0-6h2V3h-6V2a3 3 0 0 0-6 0v1Z",
  edit: "M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7M16 3l5 5M9 15l1-5L18 2a2 2 0 0 1 3 3l-8 9-4 1Z",
  search: "M16 16l5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
  user: "M17 7a5 5 0 1 1-10 0 5 5 0 0 1 10 0ZM4 22v-3a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v3H4Z",
  globe: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM2 12h20M12 2c-6 6-6 14 0 20 6-6 6-14 0-20Z",
  book: "M12 5C8 2 4 3 2 4v16c4-2 7-1 10 1 3-2 6-3 10-1V4c-2-1-6-2-10 1Zm0 0v16M6 8h2M6 12h2M16 8h2M16 12h2",
  story: "M3 3h18v18H3V3Zm6 4 8 5-8 5V7Z",
  image: "M3 18 8 12l5 6 4-4 5 7H2l1-3ZM15 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  pin: "M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0ZM15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  arrow: "M12 21V3M4 11l8-8 8 8",
  stop: "M7 7h10v10H7z",
  chevron: "m9 5 7 7-7 7",
  connection: "M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0M9 16a5 5 0 0 1 6 0M12 20h.01",
  menu: "M3 6h18M3 12h18M3 18h18",
  settings: "M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6",
  logout: "M9 3H4v18h5M10 12h11m-5-5 5 5-5 5",
  plus: "M12 5v14M5 12h14",
};

export function WorkbenchIcon({ name }: { name: IconName }): React.JSX.Element {
  return <svg className="workbench-icon" viewBox="-2 -2 28 28" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={paths[name]} /></svg>;
}

export function PluginIcon({ id }: { id: string }): React.JSX.Element {
  return <WorkbenchIcon name={id === "company-knowledge" ? "book" : id === "story" ? "story" : id === "builder" ? "globe" : "image"} />;
}
