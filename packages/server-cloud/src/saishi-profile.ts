import { assertExecutionIdentity, type ExecutionIdentity } from "@daoyin/harness-contracts";
import type { JsonValue } from "@daoyin/harness-protocol";
import type { CloudProfile, CloudToolBinding } from "./app.js";
import { isMemoryToolName } from "./memory-agent-policy.js";
import { createMemoryProfileBindings, memoryToolAllowed } from "./memory-tools.js";
import { createEpisodicMemoryProfileBindings, episodicMemoryToolAllowed, isEpisodicMemoryToolName } from "./episodic-memory-tools.js";
import { cloudOrchestrationDescriptors, validateCloudOrchestrationInput } from "./cloud-orchestration.js";

export const SAISHI_PROFILE = "saishi-readonly";
const scopes: Readonly<Record<string, string>> = Object.freeze({
  saishi_list_events: "saishi.events.read", saishi_get_event: "saishi.events.read",
  saishi_list_cameras: "saishi.cameras.read", saishi_list_materials: "saishi.materials.read",
  saishi_list_images: "saishi.materials.read",
  saishi_get_map: "saishi.maps.read", saishi_find_participants: "saishi.participants.read",
  saishi_get_timeline: "saishi.timelines.read", saishi_get_job: "saishi.jobs.read",
  saishi_list_registrations: "saishi.registrations.read", saishi_list_appeals: "saishi.appeals.read",
  saishi_list_scores: "saishi.scores.read",
  saishi_create_competition: "saishi.events.write", saishi_update_competition: "saishi.events.write",
  saishi_create_event: "saishi.events.write", saishi_update_event: "saishi.events.write",
  saishi_review_registration: "saishi.registrations.write", saishi_record_score: "saishi.scores.write",
  saishi_resolve_appeal: "saishi.appeals.write", saishi_bind_camera: "saishi.cameras.write",
  saishi_update_camera: "saishi.cameras.write", saishi_retry_job: "saishi.jobs.write",
  saishi_publish_map: "saishi.maps.write",
});
const writeTools = new Set(["saishi_create_competition", "saishi_update_competition", "saishi_create_event", "saishi_update_event",
  "saishi_review_registration", "saishi_record_score", "saishi_resolve_appeal", "saishi_bind_camera", "saishi_update_camera",
  "saishi_retry_job", "saishi_publish_map"]);
const destructiveTools = new Set(["saishi_review_registration", "saishi_record_score", "saishi_resolve_appeal", "saishi_bind_camera",
  "saishi_update_camera", "saishi_retry_job", "saishi_publish_map"]);
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function isSaishiIdentity(identity: ExecutionIdentity): boolean {
  assertExecutionIdentity(identity);
  return identity.space.kind === "organization" && /^[1-9][0-9]{0,15}$/u.test(identity.space.tenantId) &&
    /^[1-9][0-9]{0,15}$/u.test(identity.actorUserId) &&
    identity.space.id === `tenant_${identity.space.tenantId}` &&
    new RegExp(`^saishi-readonly:${identity.space.tenantId}:[a-f0-9]{24}$`, "u").test(identity.appInstallationId) &&
    /^sag_[a-f0-9]{48}$/u.test(identity.authorizationId) &&
    identity.billingAccountId === `saishi:${identity.space.tenantId}:${identity.actorUserId}` &&
    identity.permissions.includes("agent.use") && identity.permissions.includes("saishi.events.read") &&
    identity.allowedTools.length > 0 && new Set(identity.allowedTools).size === identity.allowedTools.length &&
    identity.allowedTools.every((name) => isMemoryToolName(name) ? memoryToolAllowed(identity, name)
      : isEpisodicMemoryToolName(name) ? episodicMemoryToolAllowed(identity, name)
      : Object.hasOwn(scopes, name) && identity.permissions.includes(scopes[name]!));
}

interface Schema { json: JsonValue }

const schemaFields = new Set(["type", "title", "default", "anyOf", "properties", "required", "additionalProperties",
  "minimum", "maximum", "exclusiveMinimum", "minLength", "maxLength", "pattern"]);
function safeSchema(value: unknown, depth = 0): boolean {
  if (!isRecord(value) || depth > 6 || Object.keys(value).some((key) => !schemaFields.has(key))) return false;
  if (value.anyOf !== undefined) return Array.isArray(value.anyOf) && value.anyOf.length >= 1 && value.anyOf.length <= 5 &&
    value.anyOf.every((item) => safeSchema(item, depth + 1));
  if (!["null", "boolean", "integer", "number", "string", "object"].includes(String(value.type))) return false;
  for (const field of ["minimum", "maximum", "exclusiveMinimum", "minLength", "maxLength"]) {
    if (value[field] !== undefined && (typeof value[field] !== "number" || !Number.isFinite(value[field]))) return false;
  }
  if (value.pattern !== undefined && (typeof value.pattern !== "string" || value.pattern.length > 160)) return false;
  if (typeof value.pattern === "string") { try { new RegExp(value.pattern, "u"); } catch { return false; } }
  if (value.type !== "object") return value.properties === undefined && value.required === undefined && value.additionalProperties === undefined;
  if (value.additionalProperties !== true && value.additionalProperties !== false) return false;
  if (value.properties === undefined) return value.additionalProperties === true && value.required === undefined;
  if (!isRecord(value.properties) || Object.entries(value.properties).some(([key, child]) =>
    !/^[a-z][a-z_]{0,40}$/u.test(key) || !safeSchema(child, depth + 1))) return false;
  const required = value.required ?? [];
  return Array.isArray(required) && required.every((key) => typeof key === "string" && Object.hasOwn(value.properties as object, key));
}

function parseSchema(value: unknown): Schema {
  if (!safeSchema(value) || !isRecord(value) || value.type !== "object" || value.additionalProperties !== false) {
    throw new Error("Unsupported Saishi input schema.");
  }
  return { json: structuredClone(value) as JsonValue };
}

function safeJson(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) ||
      (typeof value === "string" && value.length <= 4000)) return true;
  if (Array.isArray(value)) return value.length <= 200 && value.every((item) => safeJson(item, depth + 1));
  return isRecord(value) && Object.keys(value).length <= 100 && Object.entries(value).every(([key, item]) =>
    /^[A-Za-z0-9_.-]{1,80}$/u.test(key) && safeJson(item, depth + 1));
}

function matchesSchema(schema: unknown, value: unknown, depth = 0): boolean {
  if (!isRecord(schema) || depth > 8) return false;
  if (Array.isArray(schema.anyOf)) return schema.anyOf.some((item) => matchesSchema(item, value, depth + 1));
  if (schema.type === "null") return value === null;
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "integer" || schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isSafeInteger(value))) return false;
    return value >= (typeof schema.minimum === "number" ? schema.minimum : -Number.MAX_VALUE) &&
      value <= (typeof schema.maximum === "number" ? schema.maximum : Number.MAX_VALUE) &&
      (typeof schema.exclusiveMinimum !== "number" || value > schema.exclusiveMinimum);
  }
  if (schema.type === "string") return typeof value === "string" && [...value].length >= (typeof schema.minLength === "number" ? schema.minLength : 0) &&
    [...value].length <= (typeof schema.maxLength === "number" ? schema.maxLength : 1000) &&
    (typeof schema.pattern !== "string" || new RegExp(schema.pattern, "u").test(value));
  if (schema.type !== "object" || !isRecord(value)) return false;
  if (!isRecord(schema.properties)) return schema.additionalProperties === true && safeJson(value);
  const required = Array.isArray(schema.required) ? schema.required : [];
  return required.every((key) => typeof key === "string" && Object.hasOwn(value, key)) &&
    Object.entries(value).every(([key, item]) => Object.hasOwn(schema.properties as object, key) &&
      matchesSchema((schema.properties as Record<string, unknown>)[key], item, depth + 1));
}

export function validateSaishiInput(schema: unknown, input: Record<string, unknown>): boolean {
  try { parseSchema(schema); return matchesSchema(schema, input); } catch { return false; }
}

const outputKeys = new Set(["items", "has_more", "next_after_id", "id", "title", "name", "number", "event_type", "start_time", "end_time", "status",
  "record_status", "updated_at", "created_at", "done_at", "media_type", "stream_id", "source", "duration", "process_status", "process_progress",
  "revision", "published", "image_asset_id", "points", "routes", "key", "label", "kind", "x", "y", "point_keys", "path_vertex_count",
  "person", "map_revision", "observed_count", "point_count", "diagnostics", "basis", "timezone", "route", "observed", "observed_at", "last_seen_at",
  "material_count", "timeline_keys", "missing_time", "unbound_camera", "job_type", "progress", "video_id", "reel_id",
  "image_id", "image_kind", "event_id", "captured_at", "cover_image_id", "tenant_id", "competition_id", "competition_name",
  "description", "location", "province", "city", "district", "image_url", "start_date", "end_date", "created_by", "user_id",
  "real_name", "reject_reason", "approved_by", "approved_at", "event_title", "username", "registration_id", "reason", "admin_note",
  "handled_by", "handled_at", "score_value", "jump_count", "duration_seconds", "data_date", "submitted_at", "checkpoints",
  "extra_data", "stream_channel_id", "stream_type", "preview_image_url", "notes", "job_id", "accepted", "publication_reset",
  "orienteering_map_published"]);
function cleanData(value: unknown, depth = 0): JsonValue {
  if (depth > 12) throw new Error("Saishi result nesting exceeded.");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length <= 1000) return value;
  if (Array.isArray(value) && value.length <= 400) return value.map((item) => cleanData(item, depth + 1));
  if (!isRecord(value) || Object.keys(value).some((key) => !outputKeys.has(key))) throw new Error("Unexpected Saishi result fields.");
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key === "extra_data") {
      if (!safeJson(item)) throw new Error("Invalid Saishi extra data.");
      return [key, structuredClone(item) as JsonValue];
    }
    return [key, cleanData(item, depth + 1)];
  }));
}
export function parseSaishiResult(value: unknown, name: string): JsonValue {
  const readOnly = !writeTools.has(name);
  if (!Object.hasOwn(scopes, name) || !isRecord(value) || value.schemaVersion !== 1 || value.tool !== name || value.readOnly !== readOnly || value.untrusted !== true || !isRecord(value.data) ||
      Object.keys(value).some((key) => !["schemaVersion", "tool", "readOnly", "untrusted", "data"].includes(key)) || JSON.stringify(value).length > 80000) throw new Error("Invalid Saishi result.");
  return { schemaVersion: 1, tool: name, readOnly, untrusted: true, data: cleanData(value.data) };
}

export interface SaishiClient {
  authorize(name: string, input: Record<string, unknown>, identity: ExecutionIdentity, operationId: string, signal: AbortSignal): Promise<boolean>;
  call(name: string, input: Record<string, unknown>, identity: ExecutionIdentity, runId: string, operationId: string, signal: AbortSignal): Promise<unknown>;
}

export function orchestrationPolicyBindings(): CloudToolBinding[] {
  const fail = async () => ({ ok: false as const, code: "ORCHESTRATION_RUNTIME_ONLY", message: "编排工具仅由云端运行时安装。", retryable: false });
  return cloudOrchestrationDescriptors().map((descriptor) => ({
    requiredPermissions: ["agent.use"],
    validateInput: (input) => validateCloudOrchestrationInput(descriptor.name, input),
    authorizeResource: async () => false,
    definition: { ...descriptor, execute: fail },
  }));
}

export function createSaishiProfile(catalog: unknown, identity: ExecutionIdentity, client: SaishiClient): CloudProfile {
  if (!isSaishiIdentity(identity) || !isRecord(catalog) || catalog.id !== SAISHI_PROFILE || catalog.version !== "2" ||
      typeof catalog.instructions !== "string" || catalog.instructions.length > 10000 || !catalog.instructions.trim() || !Array.isArray(catalog.tools)) throw new Error("Invalid Saishi profile.");
  const seen = new Set<string>();
  const pageReads = new Map<string, Set<string>>();
  const tools: CloudToolBinding[] = catalog.tools.map((raw) => {
    if (!isRecord(raw) || typeof raw.name !== "string" || !Object.hasOwn(scopes, raw.name) || seen.has(raw.name) || !identity.allowedTools.includes(raw.name) ||
        typeof raw.description !== "string" || raw.description.length > 2000 || !isRecord(raw.annotations) ||
        raw.annotations.readOnlyHint !== !writeTools.has(raw.name) || raw.annotations.destructiveHint !== destructiveTools.has(raw.name) ||
        !Array.isArray(raw.requiredPermissions) || raw.requiredPermissions.length !== 1 || raw.requiredPermissions[0] !== scopes[raw.name]) throw new Error("Unreviewed Saishi capability.");
    const name = raw.name;
    seen.add(name);
    const schema = parseSchema(raw.inputSchema).json;
    return {
      requiredPermissions: [scopes[name]!], validateInput: (input) => validateSaishiInput(schema, input),
      authorizeResource: async (request, current, signal) => isSaishiIdentity(current) && !signal.aborted &&
        current.appInstallationId === identity.appInstallationId && current.authorizationId === identity.authorizationId &&
        await client.authorize(name, request.input, current, request.id, signal),
      definition: {
        name, description: raw.description, category: "extension", mutating: writeTools.has(name), inputSchema: schema,
        auditInput: (input) => ({ event_id: input.event_id, person_id: input.person_id, job_id: input.job_id,
          keywordLength: typeof input.keyword === "string" ? input.keyword.length : 0 }),
        execute: async (input, signal, context) => {
          const current = context.executionIdentity;
          if (!current || !context.toolCallId || !isSaishiIdentity(current) || current.authorizationId !== identity.authorizationId || !validateSaishiInput(schema, input)) throw new Error("Saishi identity or input invalid.");
          if (name === "saishi_list_images" || name === "saishi_list_materials") {
            const key = `${context.turnId}:${name}`;
            const reads = pageReads.get(key) ?? new Set<string>();
            const page = JSON.stringify(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)));
            if (reads.has(page) || reads.size >= 2) return { ok: false, code: "MEDIA_PAGE_LIMIT", retryable: false,
              message: "本轮已查询素材，请先展示已有图片或说明结果；需要更多时由用户继续请求，不重复翻页。" };
            if (pageReads.size > 256) pageReads.delete(pageReads.keys().next().value!);
            reads.add(page); pageReads.set(key, reads);
          }
          const value = await client.call(name, input, current, context.turnId, context.toolCallId, signal);
          signal.throwIfAborted();
          return { ok: true, summary: writeTools.has(name) ? "赛事操作已完成" : "已读取授权范围内的赛事数据", evidence: {
            schemaVersion: 1, toolName: name, result: parseSaishiResult(value, name), artifacts: [], diagnostics: [],
          } };
        },
      },
    };
  });
  if (seen.size !== identity.allowedTools.filter((name) => !isMemoryToolName(name) && !isEpisodicMemoryToolName(name)).length || seen.size === 0) throw new Error("Incomplete Saishi catalog.");
  // The metered model adapter validates calls against this catalog; memory execution stays in Harness.
  // Orchestration policy bindings are validation-only descriptors: checkedProfile removes them and the cloud runtime installs the trusted executors.
  return { id: SAISHI_PROFILE, version: "2", instructions: catalog.instructions,
    tools: [...tools, ...createMemoryProfileBindings(identity), ...createEpisodicMemoryProfileBindings(identity), ...orchestrationPolicyBindings()] };
}
