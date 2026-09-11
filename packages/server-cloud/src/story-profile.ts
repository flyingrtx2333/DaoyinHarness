import { assertExecutionIdentity, type ExecutionIdentity } from "@daoyin/harness-contracts";
import type { JsonValue } from "@daoyin/harness-protocol";
import type { CloudProfile } from "./app.js";
import { orchestrationPolicyBindings, type SaishiClient } from "./saishi-profile.js";
const scopes: Readonly<Record<string, string>> = Object.freeze({
  story_video_options: "story.read", story_recent_videos: "story.read", story_get_video: "story.read",
  story_estimate_video: "story.read", story_create_video: "story.generate",
});
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export function isStoryIdentity(identity: ExecutionIdentity): boolean {
  assertExecutionIdentity(identity);
  return identity.space.kind === "organization" && /^[1-9][0-9]{0,15}$/u.test(identity.space.tenantId) &&
    /^[1-9][0-9]{0,15}$/u.test(identity.actorUserId) && identity.space.id === `tenant_${identity.space.tenantId}` &&
    new RegExp(`^story-quick:${identity.space.tenantId}:[a-f0-9]{24}$`, "u").test(identity.appInstallationId) &&
    /^stg_[a-f0-9]{48}$/u.test(identity.authorizationId) &&
    identity.billingAccountId === `story:${identity.space.tenantId}:${identity.actorUserId}` &&
    identity.permissions.includes("agent.use") && identity.allowedTools.length === Object.keys(scopes).length &&
    new Set(identity.allowedTools).size === identity.allowedTools.length &&
    identity.allowedTools.every(name => Object.hasOwn(scopes, name) && identity.permissions.includes(scopes[name]!));
}
export function validateStoryInput(schema: unknown, value: unknown, depth = 0): boolean {
  if (depth > 5 || !record(schema)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (schema.type === "object") {
    const props = schema.properties;
    return record(value) && record(props) && schema.additionalProperties === false &&
      Object.keys(value).every(key => Object.hasOwn(props, key) && validateStoryInput(props[key], value[key], depth+1)) &&
      Array.isArray(schema.required) && schema.required.every(key => typeof key === "string" && Object.hasOwn(value, key));
  }
  if (schema.type === "string") return typeof value === "string" &&
    [...value].length >= (typeof schema.minLength === "number" ? schema.minLength : 0) &&
    [...value].length <= (typeof schema.maxLength === "number" ? schema.maxLength : 5000) &&
    (schema.pattern === undefined || (typeof schema.pattern === "string" && new RegExp(schema.pattern, "u").test(value)));
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "integer") return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= (typeof schema.minimum === "number" ? schema.minimum : 0) &&
    value <= (typeof schema.maximum === "number" ? schema.maximum : Number.MAX_SAFE_INTEGER);
  if (schema.type === "array") return Array.isArray(value) && value.length <= (typeof schema.maxItems === "number" ? schema.maxItems : 12) &&
    value.every(item => validateStoryInput(schema.items, item, depth+1)) &&
    (schema.uniqueItems !== true || new Set(value.map(item => JSON.stringify(item))).size === value.length);
  return false;
}
export function createStoryProfile(catalog: unknown, identity: ExecutionIdentity, client: SaishiClient): CloudProfile {
  if (!isStoryIdentity(identity) || !record(catalog) || catalog.id !== "story-quick" || catalog.version !== "1" ||
      typeof catalog.instructions !== "string" || !catalog.instructions.trim() || catalog.instructions.length > 10000 ||
      !Array.isArray(catalog.tools) || catalog.tools.length !== Object.keys(scopes).length) throw new Error("Invalid Story profile.");
  const seen = new Set<string>();
  const profile: CloudProfile = { id: "story-quick", version: "1", instructions: catalog.instructions, tools: catalog.tools.map(raw => {
    if (!record(raw) || typeof raw.name !== "string" || !Object.hasOwn(scopes, raw.name) || seen.has(raw.name) ||
        typeof raw.description !== "string" || raw.description.length > 2000 || !record(raw.inputSchema) ||
        raw.inputSchema.additionalProperties !== false || !record(raw.annotations) || raw.annotations.destructiveHint !== false ||
        raw.annotations.readOnlyHint !== (raw.name !== "story_create_video") || !Array.isArray(raw.requiredPermissions) ||
        raw.requiredPermissions.length !== 1 || raw.requiredPermissions[0] !== scopes[raw.name]) throw new Error("Invalid Story tool.");
    const name = raw.name;
    seen.add(name);
    const schema = structuredClone(raw.inputSchema) as JsonValue;
    return {
      requiredPermissions: [scopes[name]!],
      validateInput: input => validateStoryInput(schema, input),
      authorizeResource: async (request, current, signal) => isStoryIdentity(current) &&
        current.authorizationId === identity.authorizationId && current.appInstallationId === identity.appInstallationId &&
        await client.authorize(name, request.input, current, request.id, signal),
      definition: { name, description: raw.description, category: "extension", mutating: name === "story_create_video", inputSchema: schema,
        auditInput: input => ({ target: input.target, source_video_id: input.source_video_id, video_id: input.video_id, request_key: input.request_key }),
        execute: async (input, signal, context) => {
          const current = context.executionIdentity;
          if (!current || !isStoryIdentity(current) || current.authorizationId !== identity.authorizationId ||
              !context.toolCallId || !validateStoryInput(schema, input)) throw new Error("Story scope or input invalid.");
          try {
            const result = await client.call(name, input, current, context.turnId, context.toolCallId, signal);
            if (!record(result) || result.schemaVersion !== 1 || result.tool !== name || result.untrusted !== true ||
                result.readOnly !== (name !== "story_create_video") || !record(result.data) || JSON.stringify(result).length > 90000) throw new Error("Invalid Story result.");
            return { ok: true, summary: name === "story_create_video" ? "视频任务已受理" : "已读取视频信息",
              evidence: { schemaVersion: 1, toolName: name, result: result as JsonValue, artifacts: [], diagnostics: [] } };
          } catch (error) {
            signal.throwIfAborted();
            return { ok: false, code: "STORY_OPERATION_FAILED", retryable: false,
              message: error instanceof Error ? error.message : "视频请求未完成，请查询原任务状态。" };
          }
        },
      },
    };
  }) };
  return { ...profile, tools: [...profile.tools, ...orchestrationPolicyBindings()] };
}
