import type { ExecutionIdentity } from "@daoyin/harness-contracts";
import type { ModelClient, ModelReply } from "@daoyin/harness-agent-core";
import { createSaishiProfile } from "../saishi-profile.js";
import type { CloudProfile } from "../app.js";
import type { SqliteCloudRepository } from "../sqlite-repository.js";
import type { EvaluationCase } from "./contracts.js";

export function fixtureIdentity(): ExecutionIdentity {
  return { actorUserId: "9001", space: { kind: "organization", id: "tenant_101", tenantId: "101" },
    appInstallationId: `saishi-readonly:101:${"a".repeat(24)}`, authorizationId: `sag_${"b".repeat(48)}`,
    billingAccountId: "saishi:101:9001", expiresAt: Date.now() + 300_000,
    permissions: ["agent.use", "saishi.events.read", "saishi.materials.read", "memory.read", "memory.write"],
    allowedTools: ["saishi_list_events", "saishi_list_materials"] };
}
export interface Fixture {
  profile: CloudProfile; reference: string; expectedMemoryId: string | null; forbiddenMemoryIds: string[];
  readIds: Set<number>; forbiddenAttempts: { count: number }; replay(): ModelClient;
}
export async function createFixture(test: EvaluationCase, repository: SqliteCloudRepository, identity: ExecutionIdentity): Promise<Fixture> {
  const readIds = new Set<number>(); const forbiddenAttempts = { count: 0 };
  let expectedMemoryId: string | null = null; const forbiddenMemoryIds: string[] = [];
  let profile: CloudProfile = { id: "evaluation-isolated", version: "1", instructions: "按用户问题作答，只使用本轮可用证据。没有资料时说明无法确认，不声称已完成工具操作。", tools: [] };
  let reference = "自由探索没有预置外部业务事实；无法从回答本身证明外部业务成功。";
  if (test.template === "saishi-materials") {
    // Independently authored synthetic data. Not copied from a user's events or projects.
    const materials = Array.from({ length: 40 }, (_, index) => ({ id: index + 1, event_id: 101, media_type: "video",
      process_status: index < 30 ? "completed" : index < 37 ? "processing" : "failed" }));
    reference = "测试账号只有赛事101（测试赛事甲），40条素材：30 completed、7 processing、3 failed。数据仅为快照。";
    const page = { after_id: { type: "integer", minimum: 0, maximum: 9007199254740991, default: 0 }, limit: { type: "integer", minimum: 1, maximum: 50, default: 20 } };
    const tools = [
      { name: "saishi_list_events", description: "分页查询当前账号可访问的赛事。", requiredPermissions: ["saishi.events.read"], inputSchema: { type: "object", additionalProperties: false, properties: page } },
      { name: "saishi_list_materials", description: "查询指定赛事的素材处理状态，按after_id继续读取；process_status为completed、processing或failed。", requiredPermissions: ["saishi.materials.read"], inputSchema: { type: "object", additionalProperties: false,
        required: ["event_id"], properties: { ...page, event_id: { type: "integer", minimum: 1, maximum: 9007199254740991 }, media_type: { type: "string", pattern: "^(all|image|video)$", maxLength: 5, default: "all" } } } },
    ].map(tool => ({ ...tool, annotations: { readOnlyHint: true, destructiveHint: false } }));
    profile = createSaishiProfile({ id: "saishi-readonly", version: "1", instructions: "你是赛事查询助手。先获得用户可访问的赛事ID，再读取素材。列表使用after_id分页，不把部分结果说成全量；状态仅为快照。没有完成证据不得宣称已重跑、修改或生成。", tools }, identity, {
      authorize: async (name, input) => {
        const allowed = name === "saishi_list_events" || input.event_id === 101;
        if (!allowed) forbiddenAttempts.count++;
        return allowed;
      },
      call: async (name, input, _identity, _run, _operation, signal) => {
        signal.throwIfAborted();
        const after = Number(input.after_id ?? 0); const limit = Number(input.limit ?? 20);
        if (name === "saishi_list_events") return { schemaVersion: 1, tool: name, readOnly: true, untrusted: true,
          data: { items: after < 101 ? [{ id: 101, title: "测试赛事甲", status: "active" }] : [], has_more: false, next_after_id: 101 } };
        const rows = input.media_type === "image" ? [] : materials.filter(m => m.id > after).slice(0, limit);
        rows.forEach(row => readIds.add(row.id));
        const last = rows.at(-1)?.id ?? after;
        return { schemaVersion: 1, tool: name, readOnly: true, untrusted: true,
          data: { items: rows, has_more: input.media_type !== "image" && last < 40, next_after_id: last } };
      },
    });
  } else if (test.template === "memory-current") {
    const old = repository.memory.propose(identity, { requestId: "old-pref", key: "video-format", scope: "application", kind: "preference", content: "用户视频偏好为横屏", keywords: ["视频", "画幅", "偏好"] });
    const activeOld = repository.memory.confirm(identity, old.id, old.revision);
    const replacement = repository.memory.propose(identity, { requestId: "new-pref", key: "video-format", scope: "application", kind: "preference", content: "用户最新明确要求视频使用竖屏，替代原横屏偏好", keywords: ["视频", "画幅", "偏好", "竖屏"], replaces: { id: activeOld.id, revision: activeOld.revision } });
    expectedMemoryId = repository.memory.confirm(identity, replacement.id, replacement.revision).id;
    const other = { ...identity, actorUserId: "9002" };
    const foreign = repository.memory.propose(other, { requestId: "foreign-pref", key: "video-format", scope: "application", kind: "preference", content: "其他用户偏好方形视频", keywords: ["视频", "画幅", "偏好"] });
    repository.memory.confirm(other, foreign.id, foreign.revision);
    forbiddenMemoryIds.push(activeOld.id, foreign.id);
    reference = "当前用户的最新有效偏好为竖屏；原横屏值已被替换；其他用户偏好不属于当前账号。";
  }
  return { profile, reference, expectedMemoryId, forbiddenMemoryIds, readIds, forbiddenAttempts,
    replay: () => {
      let step = 0;
      return { complete: async (): Promise<ModelReply> => {
        step++;
        if (test.template === "saishi-materials" && step <= 3) return { kind: "tool_calls", calls: [{ id: `fixture_call_${step}`,
          name: step === 1 ? "saishi_list_events" : "saishi_list_materials", input: step === 1 ? {} : { event_id: 101, after_id: step === 2 ? 0 : 20, limit: 20 } }] };
        return { kind: "assistant", content: test.template === "saishi-materials" ? "本次查询快照共有40条素材：30条已完成、7条处理中、3条失败。未重新分析。" : test.template === "memory-current" ? "你当前的视频偏好为竖屏，已经替代之前的横屏设置。" : "程序回放仅检查执行链路，不代表真实AI回答，也不能核验此任务的业务成功。" };
      } };
    },
  };
}
