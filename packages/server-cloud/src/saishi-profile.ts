import { assertExecutionIdentity, type ExecutionIdentity } from "@daoyin/harness-contracts";
import type { JsonValue } from "@daoyin/harness-protocol";
import type { CloudProfile, CloudToolBinding } from "./app.js";
import { isMemoryToolName } from "./memory-agent-policy.js";
import { createMemoryProfileBindings, memoryToolAllowed } from "./memory-tools.js";

export const SAISHI_PROFILE = "saishi-readonly";
const scopes: Readonly<Record<string, string>> = Object.freeze({
  saishi_list_events: "saishi.events.read", saishi_get_event: "saishi.events.read",
  saishi_list_cameras: "saishi.cameras.read", saishi_list_materials: "saishi.materials.read",
  saishi_list_images: "saishi.materials.read",
  saishi_get_map: "saishi.maps.read", saishi_find_participants: "saishi.participants.read",
  saishi_get_timeline: "saishi.timelines.read", saishi_get_job: "saishi.jobs.read",
});
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
      : Object.hasOwn(scopes, name) && identity.permissions.includes(scopes[name]!));
}

interface Rule { type: "integer" | "string"; minimum?: number; maximum?: number; exclusiveMinimum?: number; minLength?: number; maxLength?: number; pattern?: string }
interface Schema { properties: Record<string, Rule>; required: string[]; json: JsonValue }

function parseSchema(value: unknown): Schema {
  if (!isRecord(value) || value.type !== "object" || value.additionalProperties !== false || !isRecord(value.properties) ||
      Object.keys(value).some((key) => !["type", "title", "properties", "required", "additionalProperties"].includes(key))) throw new Error("Unsupported Saishi input schema.");
  const properties: Record<string, Rule> = Object.create(null) as Record<string, Rule>;
  for (const [key, raw] of Object.entries(value.properties)) {
    if (!/^[a-z][a-z_]{0,40}$/u.test(key) || !isRecord(raw) || !["integer", "string"].includes(String(raw.type)) ||
        Object.keys(raw).some((field) => !["type", "title", "default", "minimum", "maximum", "exclusiveMinimum", "minLength", "maxLength", "pattern"].includes(field))) throw new Error("Unsupported Saishi parameter.");
    for (const field of ["minimum", "maximum", "exclusiveMinimum", "minLength", "maxLength"]) {
      if (raw[field] !== undefined && (typeof raw[field] !== "number" || !Number.isSafeInteger(raw[field]))) throw new Error("Invalid schema bound.");
    }
    if (raw.pattern !== undefined && (typeof raw.pattern !== "string" || raw.pattern.length > 160)) throw new Error("Invalid pattern.");
    if (typeof raw.pattern === "string") new RegExp(raw.pattern, "u");
    properties[key] = { ...raw } as unknown as Rule;
  }
  const required = value.required ?? [];
  if (!Array.isArray(required) || !required.every((key): key is string => typeof key === "string" && Object.hasOwn(properties, key))) throw new Error("Invalid required fields.");
  return { properties, required, json: structuredClone(value) as JsonValue };
}

export function validateSaishiInput(schema: unknown, input: Record<string, unknown>): boolean {
  try {
    const parsed = parseSchema(schema);
    if (!isRecord(input) || Object.keys(input).some((key) => !Object.hasOwn(parsed.properties, key)) || parsed.required.some((key) => !Object.hasOwn(input, key))) return false;
    return Object.entries(input).every(([key, value]) => {
      const rule = parsed.properties[key]!;
      if (rule.type === "integer") return typeof value === "number" && Number.isSafeInteger(value) &&
        value >= (rule.minimum ?? -Number.MAX_SAFE_INTEGER) && value <= (rule.maximum ?? Number.MAX_SAFE_INTEGER) &&
        (rule.exclusiveMinimum === undefined || value > rule.exclusiveMinimum);
      return typeof value === "string" && [...value].length >= (rule.minLength ?? 0) && [...value].length <= (rule.maxLength ?? 1000) &&
        (rule.pattern === undefined || new RegExp(rule.pattern, "u").test(value));
    });
  } catch { return false; }
}

const outputKeys = new Set(["items", "has_more", "next_after_id", "id", "title", "name", "number", "event_type", "start_time", "end_time", "status",
  "record_status", "updated_at", "created_at", "done_at", "media_type", "stream_id", "source", "duration", "process_status", "process_progress",
  "revision", "published", "image_asset_id", "points", "routes", "key", "label", "kind", "x", "y", "point_keys", "path_vertex_count",
  "person", "map_revision", "observed_count", "point_count", "diagnostics", "basis", "timezone", "route", "observed", "observed_at", "last_seen_at",
  "material_count", "timeline_keys", "missing_time", "unbound_camera", "job_type", "progress", "video_id", "reel_id",
  "image_id", "image_kind", "event_id", "captured_at"]);
function cleanData(value: unknown, depth = 0): JsonValue {
  if (depth > 12) throw new Error("Saishi result nesting exceeded.");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length <= 1000) return value;
  if (Array.isArray(value) && value.length <= 400) return value.map((item) => cleanData(item, depth + 1));
  if (!isRecord(value) || Object.keys(value).some((key) => !outputKeys.has(key))) throw new Error("Unexpected Saishi result fields.");
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cleanData(item, depth + 1)]));
}
export function parseSaishiResult(value: unknown, name: string): JsonValue {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.tool !== name || value.readOnly !== true || value.untrusted !== true || !isRecord(value.data) ||
      Object.keys(value).some((key) => !["schemaVersion", "tool", "readOnly", "untrusted", "data"].includes(key)) || JSON.stringify(value).length > 80000) throw new Error("Invalid Saishi read result.");
  return { schemaVersion: 1, tool: name, readOnly: true, untrusted: true, data: cleanData(value.data) };
}

export interface SaishiClient {
  authorize(name: string, input: Record<string, unknown>, identity: ExecutionIdentity, operationId: string, signal: AbortSignal): Promise<boolean>;
  call(name: string, input: Record<string, unknown>, identity: ExecutionIdentity, runId: string, operationId: string, signal: AbortSignal): Promise<unknown>;
}

function orchestrationPolicyBindings(): CloudToolBinding[] {
  const fail = async () => ({ ok: false as const, code: "ORCHESTRATION_RUNTIME_ONLY", message: "编排工具仅由云端运行时安装。", retryable: false });
  const boundedStrings = (value: unknown, min: number, max: number): value is string[] => Array.isArray(value) && value.length >= min && value.length <= max &&
    value.every((item) => typeof item === "string" && item.trim().length >= 1 && item.length <= 6000);
  const bindings: Array<{ name: string; description: string; schema: JsonValue; validate(input: Record<string, unknown>): boolean }> = [
    {
      name: "delegate_agent", description: "云端受限子 Agent 委派策略描述符。",
      schema: { type: "object", additionalProperties: false, required: ["instruction"], properties: { instruction: { type: "string", minLength: 1, maxLength: 6000 } } },
      validate: (input) => Object.keys(input).length === 1 && typeof input.instruction === "string" && input.instruction.trim().length >= 1 && input.instruction.length <= 6000,
    },
    {
      name: "delegate_parallel", description: "云端并行子 Agent 策略描述符。",
      schema: { type: "object", additionalProperties: false, required: ["tasks"], properties: { tasks: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", minLength: 1, maxLength: 6000 } } } },
      validate: (input) => Object.keys(input).length === 1 && boundedStrings(input.tasks, 1, 3),
    },
    {
      name: "workflow_run_inline", description: "云端顺序子 Agent 工作流策略描述符。",
      schema: { type: "object", additionalProperties: false, required: ["steps"], properties: { steps: { type: "array", minItems: 1, maxItems: 5, items: { type: "string", minLength: 1, maxLength: 6000 } } } },
      validate: (input) => Object.keys(input).length === 1 && boundedStrings(input.steps, 1, 5),
    },
  ];
  return bindings.map((item) => ({
    requiredPermissions: ["agent.use"], validateInput: item.validate, authorizeResource: async () => false,
    definition: { name: item.name, description: item.description, category: "system", mutating: true, inputSchema: item.schema, execute: fail },
  }));
}

export function createSaishiProfile(catalog: unknown, identity: ExecutionIdentity, client: SaishiClient): CloudProfile {
  if (!isSaishiIdentity(identity) || !isRecord(catalog) || catalog.id !== SAISHI_PROFILE || catalog.version !== "1" ||
      typeof catalog.instructions !== "string" || catalog.instructions.length > 10000 || !catalog.instructions.trim() || !Array.isArray(catalog.tools)) throw new Error("Invalid Saishi profile.");
  const seen = new Set<string>();
  const pageReads = new Map<string, Set<string>>();
  const tools: CloudToolBinding[] = catalog.tools.map((raw) => {
    if (!isRecord(raw) || typeof raw.name !== "string" || !Object.hasOwn(scopes, raw.name) || seen.has(raw.name) || !identity.allowedTools.includes(raw.name) ||
        typeof raw.description !== "string" || raw.description.length > 2000 || !isRecord(raw.annotations) || raw.annotations.readOnlyHint !== true ||
        raw.annotations.destructiveHint !== false || !Array.isArray(raw.requiredPermissions) || raw.requiredPermissions.length !== 1 || raw.requiredPermissions[0] !== scopes[raw.name]) throw new Error("Unreviewed Saishi capability.");
    const name = raw.name;
    seen.add(name);
    const schema = parseSchema(raw.inputSchema).json;
    return {
      requiredPermissions: [scopes[name]!], validateInput: (input) => validateSaishiInput(schema, input),
      authorizeResource: async (request, current, signal) => isSaishiIdentity(current) && !signal.aborted &&
        current.appInstallationId === identity.appInstallationId && current.authorizationId === identity.authorizationId &&
        await client.authorize(name, request.input, current, request.id, signal),
      definition: {
        name, description: raw.description, category: "extension", mutating: false, inputSchema: schema,
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
          return { ok: true, summary: "已读取授权范围内的赛事数据", evidence: {
            schemaVersion: 1, toolName: name, result: parseSaishiResult(value, name), artifacts: [], diagnostics: [],
          } };
        },
      },
    };
  });
  if (seen.size !== identity.allowedTools.filter((name) => !isMemoryToolName(name)).length || seen.size === 0) throw new Error("Incomplete Saishi catalog.");
  // The metered model adapter validates calls against this catalog; memory execution stays in Harness.
  // Orchestration policy bindings are validation-only descriptors: checkedProfile removes them and the cloud runtime installs the trusted executors.
  return { id: SAISHI_PROFILE, version: "1", instructions: catalog.instructions, tools: [...tools, ...createMemoryProfileBindings(identity), ...orchestrationPolicyBindings()] };
}
