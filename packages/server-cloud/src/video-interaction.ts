import type { ExecutionIdentity, SessionEventStore } from "@daoyin/harness-contracts";
import type { AgentEvent, JsonValue } from "@daoyin/harness-protocol";
import type { ToolDefinition, ToolExecutionContext } from "@daoyin/harness-tools/registry";
import { sameExecutionScope } from "@daoyin/harness-contracts";
import type { CloudToolBinding } from "./app.js";
import { CloudError, type CloudRun } from "./repository.js";

export const VIDEO_CONFIRMATION_TOOL = "request_video_confirmation";
export const VIDEO_GENERATION_OPERATIONS = new Set(["story_create_video", "story_create_production"]);
export const VIDEO_CONFIRMATION_INSTRUCTIONS = `付费创建视频前必须先调用 request_video_confirmation，并传入将要执行的业务工具名和完整、精确的业务参数。
仅在用户确实要求创建视频且必要参数已经齐全时调用；咨询、排错、查询进度、取消或仅修改文案时不得调用。
用户明确要求全新生成且已经给出可执行的主题或风格（例如“生成一段高燃混剪视频”）时，主题即视为必要内容已经齐全；不得再要求用户逐项补充可选参数。
用户要求宣传片、成片、短剧、连续多镜头或总时长超过15秒时，必须使用 story_create_production 且 workflowVersion=2；不得把整部片拆成由对话逐次等待的单段调用。
生产任务默认 generateAudio=true、generateSubtitles=true：旁白由平台 MiniMax TTS 按分镜生成并自动混音，字幕使用同一旁白时间轴并烧录进成片。分镜 dialogue 字段应写可直接朗读的旁白或对白，不得把运镜、画面描述当旁白。
用户上传或明确引用产品图、手机界面、角色、场景、Logo时，先完成素材上传并把素材身份写入制作要求；模型原生画面优先，不得擅自在中途叠加截图、产品图或营销文字。字幕以及用户要求的片尾Logo除外。
制作完成后应查询 production 结果并向用户呈现最终成片；不得只报告分镜视频或后台任务ID。
单段视频请求读取 story_video_options 后直接采用受支持的默认方案并进入确认：优先豆包 Seedance 2.0 Mini、720p、10 秒、16:9、target=new；没有明确口播时默认无口播，按用户风格补充合适的背景音乐描述。确认窗口负责让用户检查或修改这些默认值。
只有缺少任何可表现的主题/内容，或用户明确表示要引用但尚未指定已有/上传素材时，才在消息中追问。
如有 story_estimate_video，应先调用它；确认窗口会直接展示其最近一次可信结果。
用户要求续接上一段或生成下一段时，先调用 story_get_video 读取当前会话指向的视频，再调用 story_video_options，选择 supports_tail_continuation=true 的可用模型；必须使用 target=continue 和 source_video_id，不能用 existing 代替。尾帧作为首帧属于图片输入，估价 hasVideoInput=false。
根据完整上段内容润色后续动作，不能只取开头镜头；没有观察实际尾帧时不得声称看到了结尾画面，提示词以“从给定首帧的主体、构图和动作自然延续”开头。禁止擅自把未观察的尾帧描述成赛车等具体场景。
确认工具返回后，必须使用返回的 operation 和 input 原样调用对应生成工具，不得自行改动参数或再次提交。`;

type VideoOperation = "story_create_video" | "story_create_production";
interface Resolution { resolution: "confirmed" | "cancelled"; input?: Record<string, unknown> }
interface InteractionWaitLifecycle {
  suspendRunDeadline(): void;
  resumeRunDeadline(): void;
}
interface Pending {
  run: CloudRun;
  identity: ExecutionIdentity;
  toolCallId: string;
  operation: VideoOperation;
  requestedInput: Record<string, unknown>;
  binding: CloudToolBinding;
  events: SessionEventStore;
  signal: AbortSignal;
  accountId: string;
  scopeId: string;
  settle(value: Resolution): void;
  settled: boolean;
  resolving: boolean;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function inputRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function latestEstimate(events: AgentEvent[], runId: string, production: boolean): JsonValue | undefined {
  const event = events.findLast((item) => {
    if (item.turnId !== runId || item.type !== "tool.completed") return false;
    if (!production) return item.payload.toolName === "story_estimate_video";
    const result = item.payload.evidence.result;
    if (!inputRecord(result) || !inputRecord(result.data)) return false;
    const data = inputRecord(result.data.result) ? result.data.result : result.data;
    return data.workflowVersion === 2 && typeof data.estimatedCredits === "string" && inputRecord(data.specification);
  });
  return event?.type === "tool.completed" ? event.payload.evidence.result : undefined;
}

export class VideoInteractionCoordinator {
  readonly #pending = new Map<string, Pending>();
  readonly #approvals = new Set<string>();

  public createTool(run: CloudRun, identity: ExecutionIdentity, events: SessionEventStore,
    bindings: ReadonlyMap<string, CloudToolBinding>, waitLifecycle?: InteractionWaitLifecycle): ToolDefinition | undefined {
    const operations = [...VIDEO_GENERATION_OPERATIONS].filter((name) => bindings.has(name)) as VideoOperation[];
    if (!operations.length) return undefined;
    return {
      name: VIDEO_CONFIRMATION_TOOL,
      description: "在真实创建视频或一键短剧前，向当前用户展示精确参数与可信费用估算并等待确认。咨询问题不要调用。",
      category: "extension", mutating: false,
      inputSchema: { type: "object", additionalProperties: false, required: ["operation", "input"], properties: {
        operation: { type: "string", enum: operations }, input: { type: "object", maxProperties: 32 },
      } },
      auditInput: (input) => ({ operation: input.operation }),
      execute: async (input, signal, context) => this.#request(run, identity, events, bindings, input, signal, context, waitLifecycle),
    };
  }

  async #request(run: CloudRun, identity: ExecutionIdentity, events: SessionEventStore,
    bindings: ReadonlyMap<string, CloudToolBinding>, value: Record<string, unknown>, signal: AbortSignal,
    context: ToolExecutionContext, waitLifecycle?: InteractionWaitLifecycle) {
    const operation = value.operation;
    const requestedInput = value.input;
    const binding = typeof operation === "string" ? bindings.get(operation) : undefined;
    if (!VIDEO_GENERATION_OPERATIONS.has(String(operation)) || binding === undefined || !inputRecord(requestedInput) ||
        !binding.validateInput(requestedInput) || !context.toolCallId) {
      return { ok: false as const, code: "VIDEO_CONFIRMATION_INVALID", message: "视频生成参数尚未完整，未打开确认窗口。", retryable: false };
    }
    const interactionId = `interaction_${crypto.randomUUID()}`;
    const history = await events.read(run.sessionId);
    if (operation === "story_create_video" && /(?:接着|续接|延续|下一段|后续|续写)/u.test(run.userMessage) && requestedInput.target !== "continue") {
      return { ok: false as const, code: "VIDEO_CONTINUATION_REQUIRED", message: "续接必须使用 target=continue，把上一段尾帧作为首帧；请重新读取源视频和可用模型后估价确认。", retryable: false };
    }
    if (requestedInput.target === "continue") {
      const sourceRead = history.some(event => {
        if (event.turnId !== run.id || event.type !== "tool.completed" || event.payload.toolName !== "story_get_video") return false;
        const result = event.payload.evidence.result;
        return inputRecord(result) && inputRecord(result.data) && result.data.id === requestedInput.source_video_id && result.data.status === "SUCCEEDED" && typeof result.data.last_frame_url === "string";
      });
      if (!sourceRead) return { ok: false as const, code: "VIDEO_SOURCE_REQUIRED", message: "请先调用 story_get_video 核验源视频及其尾帧，再准备续接确认。", retryable: false };
    }
    if (!await binding.authorizeResource({ id: `${context.toolCallId}_preflight`, name: String(operation), input: requestedInput }, identity, signal)) {
      return { ok: false as const, code: "VIDEO_PREFLIGHT_FAILED", message: "视频参数或参考方式未通过业务校验，请读取当前模型能力并修正后再确认。", retryable: false };
    }
    const estimate = latestEstimate(history, run.id, operation === "story_create_production");
    if (operation === "story_create_production" && requestedInput.workflowVersion === 2) {
      const result = inputRecord(estimate) && inputRecord(estimate.data) ? estimate.data : undefined;
      const data = result && inputRecord(result.result) ? result.result : result;
      const spec = data && inputRecord(data.specification) ? data.specification : undefined;
      if (!spec || !["modelName", "resolution", "targetDurationSeconds", "segmentDurationSeconds"].every(key =>
          spec[key] === requestedInput[key])) {
        return { ok: false as const, code: "PRODUCTION_ESTIMATE_REQUIRED", message: "请先通过 Story 的 estimate_production 操作获取匹配当前整集方案的费用，不能用单镜头估价代替。", retryable: false };
      }
      if (typeof requestedInput.maxCredits !== "string" || !Number.isFinite(Number(requestedInput.maxCredits)) ||
          Number(requestedInput.maxCredits) < Number(data?.estimatedCredits)) {
        return { ok: false as const, code: "PRODUCTION_BUDGET_REQUIRED", message: "请给出不低于整集基础估算的积分上限，并在弹窗中交由用户确认。", retryable: false };
      }
    }
    let settle!: (value: Resolution) => void;
    const resolutionPromise = new Promise<Resolution>((resolve) => { settle = resolve; });
    const pending: Pending = { run, identity, events, signal, accountId: context.accountId, scopeId: context.scopeId,
      toolCallId: context.toolCallId, operation: operation as VideoOperation,
      requestedInput: structuredClone(requestedInput), binding, settle, settled: false, resolving: false };
    this.#pending.set(interactionId, pending);
    const abort = (): void => {
      if (pending.settled || pending.resolving) return;
      pending.settled = true; this.#pending.delete(interactionId); settle({ resolution: "cancelled" });
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await events.append({ type: "interaction.requested", accountId: context.accountId, scopeId: context.scopeId,
        sessionId: run.sessionId, turnId: run.id, payload: { interactionId, toolCallId: context.toolCallId,
          kind: "video_confirmation", operation: operation as VideoOperation, input: structuredClone(requestedInput) as JsonValue,
          ...(estimate === undefined ? {} : { estimate }) } });
      waitLifecycle?.suspendRunDeadline();
      if (signal.aborted) abort();
      const resolution = await resolutionPromise;
      if (resolution.resolution === "cancelled" || resolution.input === undefined) {
        return { ok: false as const, code: "VIDEO_CONFIRMATION_CANCELLED", message: "用户取消了本次视频生成，未产生生成费用。", retryable: false };
      }
      return { ok: true as const, summary: "用户已确认视频生成参数",
        evidence: { schemaVersion: 1 as const, toolName: VIDEO_CONFIRMATION_TOOL,
          result: { operation, input: resolution.input } as JsonValue, artifacts: [], diagnostics: [] } };
    } catch (error) {
      if (!pending.settled) {
        pending.settled = true;
        this.#pending.delete(interactionId);
        settle({ resolution: "cancelled" });
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      waitLifecycle?.resumeRunDeadline();
    }
  }

  public async resolve(identity: ExecutionIdentity, runId: string, interactionId: string, resolution: Resolution): Promise<void> {
    const pending = this.#pending.get(interactionId);
    if (pending === undefined || pending.run.id !== runId || pending.settled || pending.resolving || !sameExecutionScope(identity, pending.identity) ||
        identity.billingAccountId !== pending.identity.billingAccountId ||
        !identity.permissions.includes("agent.use") || !identity.allowedTools.includes(pending.operation)) {
      throw new CloudError(409, "INTERACTION_NOT_PENDING", "该确认请求已处理、已失效或不属于当前任务。");
    }
    const confirmedInput = resolution.input ?? pending.requestedInput;
    if (resolution.resolution === "confirmed" && pending.requestedInput.target === "continue" &&
        ["target", "source_video_id", "modelName", "resolution", "durationSeconds", "aspectRatio", "request_key"].some(key => confirmedInput[key] !== pending.requestedInput[key])) {
      throw new CloudError(400, "VIDEO_CONFIRMATION_INVALID", "续接来源和已估价规格已变化，请重新准备确认。");
    }
    if (resolution.resolution === "confirmed" && (!inputRecord(confirmedInput) || !pending.binding.validateInput(confirmedInput))) {
      throw new CloudError(400, "VIDEO_CONFIRMATION_INVALID", "视频参数不完整或不受当前模型支持，请修改后再确认。");
    }
    if (resolution.resolution === "confirmed" && pending.operation === "story_create_production" && pending.requestedInput.workflowVersion === 2 &&
        ["workflowVersion", "modelName", "resolution", "targetDurationSeconds", "segmentDurationSeconds", "aspectRatio", "request_key"].some(key => confirmedInput[key] !== pending.requestedInput[key])) {
      throw new CloudError(400, "PRODUCTION_ESTIMATE_CHANGED", "已估价的制作规格发生变化，请重新准备整集确认。");
    }
    pending.resolving = true;
    try {
      await pending.events.append({ type: "interaction.resolved", accountId: pending.accountId, scopeId: pending.scopeId,
        sessionId: pending.run.sessionId, turnId: pending.run.id, payload: { interactionId,
          toolCallId: pending.toolCallId, resolution: resolution.resolution,
          ...(resolution.resolution === "confirmed" ? { input: structuredClone(confirmedInput) as JsonValue } : {}) } });
      pending.settled = true;
      this.#pending.delete(interactionId);
      if (resolution.resolution === "confirmed") this.#approvals.add(this.#approvalKey(runId, pending.operation, confirmedInput));
      pending.settle(resolution.resolution === "confirmed" ? { resolution: "confirmed", input: structuredClone(confirmedInput) } : { resolution: "cancelled" });
    } catch (error) {
      pending.resolving = false;
      if (pending.signal.aborted && !pending.settled) {
        pending.settled = true; this.#pending.delete(interactionId); pending.settle({ resolution: "cancelled" });
      }
      throw error;
    }
  }

  public consume(runId: string, operation: string, input: Record<string, unknown>): boolean {
    const key = this.#approvalKey(runId, operation, input);
    if (!this.#approvals.delete(key)) return false;
    return true;
  }

  public clear(runId: string): void {
    for (const [interactionId, pending] of this.#pending) {
      if (pending.run.id !== runId) continue;
      pending.settled = true; this.#pending.delete(interactionId); pending.settle({ resolution: "cancelled" });
    }
    const prefix = `${runId}\n`;
    for (const key of this.#approvals) if (key.startsWith(prefix)) this.#approvals.delete(key);
  }

  #approvalKey(runId: string, operation: string, input: Record<string, unknown>): string {
    return `${runId}\n${operation}\n${canonical(input)}`;
  }
}
