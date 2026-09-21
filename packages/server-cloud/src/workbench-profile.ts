import { assertExecutionIdentity, type ExecutionIdentity } from "@daoyin/harness-contracts";
import type { JsonValue } from "@daoyin/harness-protocol";
import type { CloudProfile, CloudToolBinding } from "./app.js";
import { orchestrationPolicyBindings, parseSaishiResult, validateSaishiInput, type SaishiClient } from "./saishi-profile.js";
import { validateStoryInput } from "./story-profile.js";

const SAISHI = new Set(["saishi_list_events", "saishi_get_event", "saishi_list_cameras", "saishi_list_materials",
  "saishi_list_images", "saishi_get_map", "saishi_find_participants", "saishi_get_timeline", "saishi_get_job",
  "saishi_list_registrations", "saishi_list_appeals", "saishi_list_scores"]);
const STORY = new Set(["story_video_options", "story_recent_videos", "story_get_video", "story_estimate_video", "story_create_video",
  "story_capabilities", "story_media_capabilities", "story_video_workflows", "story_call", "story_get_job",
  "story_wait_job", "story_recent_mcp_calls", "story_create_production", "story_get_production",
  "story_resume_production", "story_prepare_media_upload", "story_commit_media_upload",
  "story_upload_media_from_url", "story_add_segment_video_frame_reference",
  "story_bind_segment_video_frame_reference"]);
const STORY_MUTATING = new Set(["story_create_video", "story_call", "story_create_production", "story_resume_production",
  "story_prepare_media_upload", "story_commit_media_upload", "story_upload_media_from_url",
  "story_add_segment_video_frame_reference", "story_bind_segment_video_frame_reference"]);
const COMPANY = "company_knowledge_search";
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function isWorkbenchIdentity(identity: ExecutionIdentity): boolean {
  assertExecutionIdentity(identity);
  const tools = [COMPANY, ...SAISHI, ...STORY];
  return identity.space.kind === "organization" && identity.space.id === `tenant_${identity.space.tenantId}` &&
    new RegExp(`^daoyin-workbench:${identity.space.tenantId}:[a-f0-9]{24}$`, "u").test(identity.appInstallationId) &&
    /^sag_[a-f0-9]{48}$/u.test(identity.authorizationId) &&
    identity.billingAccountId === `harness:${identity.space.tenantId}:${identity.actorUserId}` &&
    identity.permissions.includes("agent.use") && tools.every(name => identity.allowedTools.includes(name));
}

function validResult(value: unknown, name: string): JsonValue {
  if (SAISHI.has(name)) return parseSaishiResult(value, name);
  if (!record(value) || value.schemaVersion !== 1 || value.tool !== name || value.untrusted !== true ||
      value.readOnly !== !STORY_MUTATING.has(name) || !record(value.data) || JSON.stringify(value).length > 90000) {
    throw new Error("Invalid workbench result.");
  }
  return value as JsonValue;
}

export function createWorkbenchProfile(catalog: unknown, identity: ExecutionIdentity, client: SaishiClient): CloudProfile {
  if (!isWorkbenchIdentity(identity) || !record(catalog) || catalog.id !== "daoyin-workbench" || catalog.version !== "1" ||
      typeof catalog.instructions !== "string" || !catalog.instructions.trim() || catalog.instructions.length > 10000 || !Array.isArray(catalog.tools)) {
    throw new Error("Invalid workbench profile.");
  }
  const seen = new Set<string>();
  const tools: CloudToolBinding[] = catalog.tools.map(raw => {
    if (!record(raw) || typeof raw.name !== "string" || (!SAISHI.has(raw.name) && !STORY.has(raw.name) && raw.name !== COMPANY) ||
        seen.has(raw.name) || !record(raw.inputSchema) || typeof raw.description !== "string" || !record(raw.annotations)) throw new Error("Invalid workbench tool.");
    const name = raw.name; seen.add(name); const schema = structuredClone(raw.inputSchema) as JsonValue;
    const validate = (input: Record<string, unknown>): boolean => SAISHI.has(name) ? validateSaishiInput(schema, input) : validateStoryInput(schema, input);
    return { requiredPermissions: Array.isArray(raw.requiredPermissions) ? raw.requiredPermissions.filter((v): v is string => typeof v === "string") : [],
      validateInput: validate,
      authorizeResource: async (request, current, signal) => isWorkbenchIdentity(current) && current.authorizationId === identity.authorizationId &&
        validate(request.input) && await client.authorize(name, request.input, current, request.id, signal),
      definition: { name, description: name === "story_call" ? `${raw.description} 查询短剧项目时直接调用 operation=list_projects；不要先调用 story_capabilities。` : raw.description,
        category: "extension", mutating: STORY_MUTATING.has(name), inputSchema: schema,
        auditInput: input => ({ target: input.target, video_id: input.video_id, event_id: input.event_id, queryLength: typeof input.query === "string" ? input.query.length : 0 }),
        execute: async (input, signal, context) => {
          const current = context.executionIdentity;
          if (!current || !context.toolCallId || !isWorkbenchIdentity(current) || !validate(input)) throw new Error("Workbench identity or input invalid.");
          try {
            const result = await client.call(name, input, current, context.turnId, context.toolCallId, signal);
            return { ok: true, summary: name === "story_create_video" ? "视频任务已受理" : name === "story_call" ? "Story 操作已完成" : "已读取业务信息",
              evidence: { schemaVersion: 1, toolName: name, result: validResult(result, name), artifacts: [], diagnostics: [] } };
          } catch (error) { signal.throwIfAborted(); return { ok: false, code: "WORKBENCH_OPERATION_FAILED", retryable: false,
            message: error instanceof Error ? error.message : "业务请求未完成。" }; }
        } } };
  });
  if (seen.size !== SAISHI.size + STORY.size + 1) throw new Error("Incomplete workbench catalog.");
  return { id: "daoyin-workbench", version: "1", instructions: catalog.instructions, tools: [...tools, ...orchestrationPolicyBindings()] };
}
