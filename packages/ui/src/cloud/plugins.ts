/** Release inventory, not an authorization source. Execution remains bound to the server's session profile. */
export interface WorkbenchPlugin {
  id: string;
  name: string;
  mark: string;
  description: string;
  capabilities: readonly string[];
  status: "available" | "pending";
  profileId?: string;
  note: string;
}

export const PLUGINS: readonly WorkbenchPlugin[] = [
  { id: "company-knowledge", name: "官网知识", mark: "知", status: "available", profileId: "company-public",
    description: "查询道引科技的产品、方案与合作资料。",
    capabilities: ["公开资料检索", "产品问答", "来源引用"], note: "访客空间可用，仅查询公开资料。" },
  { id: "story", name: "短剧制作", mark: "剧", status: "pending",
    description: "从剧本、角色和分镜，推进到视频与成片。",
    capabilities: ["剧本生成", "角色与场景", "分镜编辑", "视频生成", "字幕与导出"],
    note: "已有短剧业务能力，尚未接入此工作台。" },
  { id: "builder", name: "网站与应用", mark: "站", status: "pending",
    description: "通过对话创建、修改和预览网站与轻应用。",
    capabilities: ["创建网站", "修改页面", "应用预览"], note: "已有产品工坊业务，尚未接入此工作台。" },
  { id: "youji", name: "文旅影像", mark: "影", status: "pending",
    description: "结合景区素材与游客照片制作场景人像。",
    capabilities: ["场景人像", "AI 图片编辑"], note: "已有文旅影像业务，尚未接入此工作台。" },
];

export function selectablePlugin(id: string): WorkbenchPlugin | undefined {
  return PLUGINS.find((plugin) => plugin.id === id && plugin.status === "available" && plugin.profileId);
}

export function sessionPlugin(profileId: string): WorkbenchPlugin | undefined {
  return PLUGINS.find((plugin) => plugin.status === "available" && plugin.profileId === profileId);
}

export function filterPlugins(query: string): readonly WorkbenchPlugin[] {
  const needle = query.trim().toLocaleLowerCase();
  return PLUGINS.filter((plugin) => [plugin.name, plugin.description, ...plugin.capabilities].join(" ").toLocaleLowerCase().includes(needle));
}
