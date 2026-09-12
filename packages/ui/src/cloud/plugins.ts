/** Private integrations use the current account; server bootstrap verifies existing business access. */
export interface WorkbenchPlugin {
  id: string;
  name: string;
  mark: string;
  description: string;
  capabilities: readonly string[];
  status: "available" | "account_required" | "pending";
  profileId?: string;
  note: string;
}

export const PLUGINS: readonly WorkbenchPlugin[] = [
  { id: "company-knowledge", name: "官网知识", mark: "知", status: "available", profileId: "daoyin-workbench",
    description: "检索道引产品与方案的公开资料",
    capabilities: ["公开资料检索", "产品问答", "来源引用"], note: "访客空间可用，仅查询公开资料。" },
  { id: "saishi", name: "赛事只读", mark: "赛", status: "available", profileId: "daoyin-workbench",
    description: "查询当前账号的赛事、素材与任务",
    capabilities: ["赛事查询", "设备与素材", "地图与点位", "个人时间线", "任务进度"],
    note: "登录道引账号后直接使用已有赛事读取权限。" },
  { id: "story", name: "短剧制作", mark: "剧", status: "available", profileId: "daoyin-workbench",
    description: "从创意到成片的一键短剧生产与素材管理",
    capabilities: ["一键短剧", "剧本与分镜", "角色与场景", "分段视频与合片", "字幕与进度恢复", "完整 Story MCP"],
    note: "登录后继承当前 Story 账号权限；付费生成由制作表单确认。" },
  { id: "builder", name: "网站与应用", mark: "站", status: "pending",
    description: "对话创建网站与轻应用",
    capabilities: ["创建网站", "修改页面", "应用预览"], note: "已有产品工坊业务，尚未接入此工作台。" },
  { id: "youji", name: "文旅影像", mark: "影", status: "pending",
    description: "生成景区场景人像",
    capabilities: ["场景人像", "AI 图片编辑"], note: "已有文旅影像业务，尚未接入此工作台。" },
];

export function selectablePlugin(id: string, authorizedProfiles: readonly string[] = []): WorkbenchPlugin | undefined {
  return PLUGINS.find((plugin) => plugin.id === id && plugin.profileId &&
    (plugin.status === "available" || (plugin.status === "account_required" && authorizedProfiles.includes(plugin.profileId))));
}

/** A session profile is supplied by the authenticated server, never by the model. */
export function sessionPlugin(profileId: string): WorkbenchPlugin | undefined {
  return PLUGINS.find((plugin) => plugin.status !== "pending" && plugin.profileId === profileId);
}

export function filterPlugins(query: string, authorizedProfiles: readonly string[] = []): readonly WorkbenchPlugin[] {
  const needle = query.trim().toLocaleLowerCase();
  return PLUGINS.filter((plugin) => [plugin.name, plugin.description, ...plugin.capabilities].join(" ").toLocaleLowerCase().includes(needle))
    .map((plugin) => plugin.status === "account_required" && plugin.profileId && authorizedProfiles.includes(plugin.profileId)
      ? { ...plugin, status: "available" as const, note: "使用当前账号已有的业务权限。" } : plugin);
}
