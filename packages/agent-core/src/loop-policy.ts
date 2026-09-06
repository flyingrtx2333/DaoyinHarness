import { createHash } from "node:crypto";
import type { ToolDescriptor, ToolExecution, ToolFailure } from "@daoyin/harness-tools/registry";
import type { ModelReply, ModelToolCall } from "./model.js";

export class AgentPolicyError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "AgentPolicyError";
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** Stable, JSON-only serialization. Property order is not evidence of progress. */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 24) throw new AgentPolicyError("MODEL_TOOL_CALL_INVALID", "工具参数嵌套过深。");
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, (item) => canonicalJson(item, depth + 1)).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`).join(",")}}`;
  throw new AgentPolicyError("MODEL_TOOL_CALL_INVALID", "工具参数必须是有效 JSON。");
}

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/u.test(value);

/** Validate the WHOLE batch before the first tool can have a side effect. */
export function validateModelReply(value: unknown, seenIds: ReadonlySet<string>): ModelReply {
  if (!object(value)) throw new AgentPolicyError("MODEL_REPLY_INVALID", "模型返回了无效的回复结构。");
  if (value.kind === "assistant") {
    if (typeof value.content !== "string" || value.content.length > 64_000) {
      throw new AgentPolicyError("MODEL_REPLY_INVALID", "模型回复正文无效或过长。");
    }
    return { kind: "assistant", content: value.content };
  }
  if (value.kind !== "tool_calls" || !Array.isArray(value.calls)) {
    throw new AgentPolicyError("MODEL_REPLY_INVALID", "模型返回了无效的工具请求结构。");
  }
  if (!value.calls.length) throw new AgentPolicyError("MODEL_TOOL_CALLS_EMPTY", "模型返回了空工具请求。");
  if (value.calls.length > 16 || (value.content !== undefined && (typeof value.content !== "string" || value.content.length > 8_000))) {
    throw new AgentPolicyError("MODEL_TOOL_BATCH_INVALID", "模型工具批次超过允许的范围。");
  }
  const batchIds = new Set<string>();
  let characters = 0;
  const calls = value.calls.map((item): ModelToolCall => {
    if (!object(item) || !identifier(item.id) || !identifier(item.name) || !object(item.input)) {
      throw new AgentPolicyError("MODEL_TOOL_CALL_INVALID", "模型工具名称、调用标识或参数无效。");
    }
    if (seenIds.has(item.id) || batchIds.has(item.id)) {
      throw new AgentPolicyError("MODEL_TOOL_CALL_DUPLICATE", "模型重复使用了工具调用标识，本批次未执行。");
    }
    const serialized = canonicalJson(item.input);
    characters += serialized.length;
    if (serialized.length > 32_000 || characters > 48_000) {
      throw new AgentPolicyError("MODEL_TOOL_INPUT_TOO_LARGE", "工具参数超过上下文预算，请缩小操作范围。");
    }
    batchIds.add(item.id);
    // Detach provider-owned objects; tool implementations cannot mutate recorded call arguments.
    return { id: item.id, name: item.name, input: JSON.parse(serialized) as Record<string, unknown> };
  });
  return { kind: "tool_calls", calls, ...(typeof value.content === "string" ? { content: value.content } : {}) };
}

interface Observation { signature: string; unchanged: number }

/** Per-turn guard, never a cross-user cache and never a substitute for business idempotency. */
export class ToolProgressGuard {
  readonly #observations = new Map<string, Observation>();
  readonly #maxUnchanged: number;
  #lastMutation: string | undefined;
  #blocked = 0;

  public constructor(maxUnchanged = 3) {
    if (!Number.isSafeInteger(maxUnchanged) || maxUnchanged < 2 || maxUnchanged > 20) throw new Error("Invalid no-progress limit.");
    this.#maxUnchanged = maxUnchanged;
  }

  #key(call: ModelToolCall): string { return hash(`${call.name}\n${canonicalJson(call.input)}`); }

  public before(call: ModelToolCall, descriptor: ToolDescriptor | undefined): ToolFailure | undefined {
    const key = this.#key(call);
    let message: string | undefined;
    if (descriptor?.mutating && descriptor.repeatable !== true && key === this.#lastMutation) {
      message = "相同写操作已经尝试过。更换调用 ID 不会重新执行；先核对已有结果，结果不确定时不要重复提交。";
    } else if ((this.#observations.get(key)?.unchanged ?? 0) >= this.#maxUnchanged) {
      message = "相同请求已连续返回相同结果，没有新的进展。请改变有效查询条件，或依据已有证据说明阻碍。";
    }
    if (message === undefined) return undefined;
    this.#blocked += 1;
    return { ok: false, code: "TOOL_NO_PROGRESS", message, retryable: false };
  }

  /** Call before dispatch, so an exception/unknown outcome cannot make a write repeatable. */
  public started(call: ModelToolCall, descriptor: ToolDescriptor | undefined): void {
    if (descriptor?.mutating) {
      const key = this.#key(call);
      if (key !== this.#lastMutation) this.#observations.clear();
      this.#lastMutation = key;
    }
  }

  public observe(call: ModelToolCall, result: ToolExecution): void {
    const key = this.#key(call);
    // Ignore timing/diagnostics and prose summaries; actual returned state is the progress signal.
    let signature: string;
    try {
      const observation = result.ok
        ? { ok: true, result: result.evidence.result, artifacts: result.evidence.artifacts }
        : { ok: false, code: result.code, details: result.details ?? null };
      // Match the durable JSON representation. Progress bookkeeping must not erase completed I/O.
      signature = hash(canonicalJson(JSON.parse(JSON.stringify(observation)) as unknown));
    } catch { return; }
    const previous = this.#observations.get(key);
    const changed = previous === undefined || previous.signature !== signature;
    this.#observations.set(key, { signature, unchanged: changed ? 1 : (previous?.unchanged ?? 0) + 1 });
    if (changed) this.#blocked = 0;
  }

  public get exhausted(): boolean { return this.#blocked >= 2; }
}
