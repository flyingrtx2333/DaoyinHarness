import type { ToolDescriptor } from "@daoyin/harness-tools/registry";
import type { CapabilityPackManifest, CapabilityRisk } from "./capability-router.js";

interface Group {
  id: string; title: string; summary: string; risk: CapabilityRisk; intents: string[]; examples: string[];
  match(name: string): boolean;
}
const groups: readonly Group[] = [
  { id: "resource.catalog", title: "资源与工作区", summary: "列出、挂载和创建通用资源或工作区。", risk: "write",
    intents: ["查看资源", "挂载工作区", "创建工作区", "导入代码仓库"], examples: ["列出当前资源", "从这个 Git 仓库创建工作区"],
    match: (name) => ["resource_list", "resource_attach", "resource_detach", "workspace_create", "workspace_inspect"].includes(name) },
  { id: "resource.files", title: "工作区文件", summary: "读取、搜索和修改任意语言工作区中的文件。", risk: "write",
    intents: ["读取文件", "搜索代码", "修改代码", "整理文件"], examples: ["搜索这个符号并修改实现", "读取配置文件"],
    match: (name) => name.startsWith("file_") },
  { id: "resource.vcs", title: "版本控制", summary: "在隔离工作区中检查 Git、提交修改和导出补丁。", risk: "write",
    intents: ["检查 Git", "提交代码", "导出补丁", "切换分支"], examples: ["查看当前 diff", "提交并导出补丁"],
    match: (name) => name.startsWith("git_") },
  { id: "resource.runtime", title: "隔离进程", summary: "在 gVisor 工作区中运行前台、后台或交互式进程。", risk: "write",
    intents: ["运行命令", "安装依赖", "启动服务", "运行测试", "读取日志"], examples: ["运行 pytest", "启动服务并查看日志"],
    match: (name) => name.startsWith("process_") },
  { id: "resource.snapshot", title: "快照与制品", summary: "创建或恢复内容寻址快照，并保存不可变制品。", risk: "write",
    intents: ["保存快照", "恢复版本", "生成制品"], examples: ["保存当前工作区快照", "把构建结果保存为制品"],
    match: (name) => ["workspace_snapshot", "workspace_restore", "artifact_create", "artifact_read", "artifact_list"].includes(name) },
  { id: "resource.deployment-status", title: "部署状态", summary: "查询不可变部署的健康状态和访问地址。", risk: "read",
    intents: ["查询部署", "查看线上状态"], examples: ["查看当前部署状态"], match: (name) => name === "deployment_status" },
  { id: "resource.deployment", title: "通用部署", summary: "部署不可变制品或回滚到之前的健康部署。", risk: "high",
    intents: ["部署制品", "回滚部署"], examples: ["部署当前制品", "回滚到上一次健康部署"],
    match: (name) => ["deployment_create", "deployment_rollback"].includes(name) },
  { id: "story.projects", title: "短剧项目", summary: "查询短剧能力目录或直接执行短剧项目操作。", risk: "write",
    intents: ["查询短剧项目", "查看我做过的短剧", "查找短剧项目"], examples: ["我做过哪些短剧项目", "列出我的短剧项目"],
    match: (name) => ["story_capabilities", "story_call"].includes(name) },
  { id: "project.catalog", title: "云端项目", summary: "创建、查看和选择云端项目。", risk: "write",
    intents: ["创建项目", "查看项目", "选择项目"], examples: ["创建一个报名网站", "查看我的项目"],
    match: (name) => ["project_list", "project_create"].includes(name) },
  { id: "project.source", title: "项目源代码", summary: "读取并修改当前云端项目源代码。", risk: "write",
    intents: ["修改网站", "读取代码", "开发应用"], examples: ["修改当前网站首页", "继续开发这个项目"],
    match: (name) => ["project_files", "project_write"].includes(name) },
  { id: "project.design", title: "界面方案", summary: "生成、查看、选择或放弃 A/B/C 界面方案。", risk: "write",
    intents: ["设计界面", "选择方案", "生成概念图"], examples: ["重新设计这个页面", "选择 B 方案"],
    match: (name) => name.startsWith("project_concept") },
  { id: "project.runtime", title: "检查与预览", summary: "检查项目并启动隔离的开发预览。", risk: "write",
    intents: ["检查项目", "更新预览", "预览网站"], examples: ["构建并预览当前项目"],
    match: (name) => ["project_check", "project_preview"].includes(name) },
  { id: "project.release", title: "发布与回滚", summary: "发布当前项目或回滚正式网站版本。", risk: "high",
    intents: ["发布当前项目", "上线网站", "回滚网站"], examples: ["发布当前项目", "回滚到上一个版本"],
    match: (name) => ["project_publish", "project_rollback"].includes(name) },
  { id: "memory.search", title: "长期记忆查询", summary: "查询当前身份可访问的长期记忆。", risk: "read",
    intents: ["查找记忆", "回忆偏好"], examples: ["查一下我之前确定的方案"],
    match: (name) => name === "memory_search" },
  { id: "memory.manage", title: "长期记忆管理", summary: "保存、更正或忘记长期记忆。", risk: "write",
    intents: ["记住", "更正记忆", "忘记"], examples: ["记住以后都使用中文", "忘掉这条记录"],
    match: (name) => ["memory_remember", "memory_update", "memory_forget"].includes(name) },
  { id: "orchestration.delegate", title: "子任务协作", summary: "把有边界的独立工作交给子 Agent。", risk: "write",
    intents: ["并行处理", "委派任务"], examples: ["分别调查这三个问题"],
    match: (name) => name.includes("delegate") },
  { id: "orchestration.workflow", title: "工作流编排", summary: "创建、执行和查询多步骤工作流。", risk: "write",
    intents: ["执行工作流", "管理目标"], examples: ["按三个步骤完成这个流程"],
    match: (name) => name.includes("workflow") || name.includes("goal") },
];
const negatives = (risk: CapabilityRisk): string[] =>
  risk === "high" ? ["只修改代码但不要发布", "查看线上状态"] :
  risk === "write" ? ["只读检查"] : ["修改或删除资源"];

export function capabilityPacksFor(tools: readonly ToolDescriptor[]): CapabilityPackManifest[] {
  const assigned = new Set<string>();
  const packs: CapabilityPackManifest[] = [];
  for (const group of groups) {
    const names = tools.map((tool) => tool.name).filter((name) => group.match(name));
    if (!names.length) continue;
    names.forEach((name) => assigned.add(name));
    packs.push({
      id: group.id, version: "1", title: group.title, summary: group.summary,
      intents: group.intents, examples: group.examples, negativeExamples: negatives(group.risk),
      toolNames: names, dependencies: [], resourceKinds: group.id.startsWith("project.") ? ["project"]
        : group.id.startsWith("resource.") ? ["workspace", "artifact", "deployment"] : [],
      requiredContext: [], risk: group.risk,
    });
  }
  const buckets = new Map<string, ToolDescriptor[]>();
  for (const tool of tools.filter((item) => !assigned.has(item.name))) {
    const prefix = tool.name.split("_", 1)[0] || "extension";
    const risky = /(?:publish|rollback|delete|payment|purchase|send|export|release|create_video|generate_video)/iu.test(tool.name);
    const risk: CapabilityRisk = risky ? "high" : tool.mutating ? "write" : "read";
    const key = prefix + ":" + risk;
    const bucket = buckets.get(key) ?? [];
    bucket.push(tool); buckets.set(key, bucket);
  }
  for (const [key, bucket] of [...buckets].sort(([left], [right]) => left.localeCompare(right))) {
    const [prefix = "extension", riskValue = "read"] = key.split(":");
    const risk = riskValue as CapabilityRisk;
    for (let offset = 0; offset < bucket.length; offset += 16) {
      const chunk = bucket.slice(offset, offset + 16);
      packs.push({
        id: "profile." + prefix + "." + risk + "." + String(offset / 16 + 1), version: "1",
        title: prefix + " 能力", summary: chunk.map((tool) => tool.description).join(" ").slice(0, 1_000),
        intents: chunk.map((tool) => tool.name.replaceAll("_", " ")).slice(0, 16), examples: [],
        negativeExamples: negatives(risk), toolNames: chunk.map((tool) => tool.name),
        dependencies: [], resourceKinds: [prefix], requiredContext: [], risk,
      });
    }
  }
  return packs;
}
function explicitClause(message: string, action: RegExp): boolean {
  return message.split(/[。！？!?；;\n]|(?:然后|并且|同时|另外|再)/u).some((clause) => {
    if (!action.test(clause)) return false;
    return !/(?:不要|不必|无需|暂不|先不|别|禁止|仅讨论|如何避免)[^。！？!?；;\n]{0,12}$/u.test(
      clause.slice(0, Math.max(0, clause.search(action))),
    );
  });
}
export function explicitHighRiskPacks(
  message: string,
  packs: readonly CapabilityPackManifest[],
): string[] {
  const value = message.normalize("NFKC").trim();
  const result = new Set<string>();
  for (const pack of packs) {
    if (pack.risk !== "high") continue;
    const names = pack.toolNames.join(" ");
    if (/(?:publish|release)/iu.test(names) && explicitClause(value, /(?:发布|上线|部署)/u)) result.add(pack.id);
    if (/rollback/iu.test(names) && explicitClause(value, /(?:回滚|恢复到.{0,12}版本)/u)) result.add(pack.id);
    if (/(?:delete|remove)/iu.test(names) && explicitClause(value, /(?:删除|移除)/u)) result.add(pack.id);
    if (/(?:payment|purchase|pay)/iu.test(names) && explicitClause(value, /(?:付款|支付|购买)/u)) result.add(pack.id);
    if (/(?:send|export)/iu.test(names) && explicitClause(value, /(?:发送|外发|导出)/u)) result.add(pack.id);
    if (/(?:create_video|generate_video)/iu.test(names) && explicitClause(value, /(?:生成|制作|创建).{0,12}视频/u)) result.add(pack.id);
  }
  return [...result];
}
