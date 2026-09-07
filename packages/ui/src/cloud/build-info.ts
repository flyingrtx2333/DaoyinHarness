export interface WorkbenchBuildInfo {
  version: string | null;
  revision: string | null;
  builtAt: string | null;
  channel: "release" | "preview" | "development";
}

// Injected once by the build pipeline, never derived from the browser clock.
declare const __HARNESS_BUILD_INFO__: Readonly<WorkbenchBuildInfo>;

export const buildInfo: Readonly<WorkbenchBuildInfo> = Object.freeze(
  typeof __HARNESS_BUILD_INFO__ === "undefined"
    ? { version: null, revision: null, builtAt: null, channel: "development" }
    : __HARNESS_BUILD_INFO__,
);

export const buildVersion = buildInfo.version
  ? `v${buildInfo.version}${buildInfo.revision ? `+${buildInfo.revision.slice(0, 7)}` : ""}`
  : "未提供";

export const buildChannelLabel = buildInfo.channel === "preview"
  ? "预览构建"
  : buildInfo.channel === "development" ? "开发环境" : null;

const timestamp = buildInfo.builtAt ? Date.parse(buildInfo.builtAt) : Number.NaN;
export const buildUpdatedAt = Number.isFinite(timestamp)
  ? new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).format(timestamp)
  : null;
