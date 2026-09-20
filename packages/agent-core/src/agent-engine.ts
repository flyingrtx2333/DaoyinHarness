import type { AgentEvent, AgentEventPayloads, AgentEventType, JsonValue, SessionCompaction } from "@daoyin/harness-protocol";
import type { ToolRegistry, ToolDescriptor, ToolExecution, ToolExecutionContext, ToolProgressUpdate } from "@daoyin/harness-tools/registry";
import { snapshotExecutionIdentity, type ExecutionIdentity, type SessionCompactionStore, type SessionEventStore } from "@daoyin/harness-contracts";
import { ContextAssembler } from "./context-assembler.js";
import { TextDeltaBuffer } from "./text-delta-buffer.js";
import { ContextCompactor } from "./context-compactor.js";
import { boundModelContext } from "./context-budget.js";
import { AgentPolicyError, ToolProgressGuard, validateModelReply } from "./loop-policy.js";
import { modelToolResult } from "./model-tool-result.js";
import { memoryContextView, memoryOperation, type AgentMemoryProvider, type MemoryContextSnapshot } from "./memory-context.js";
import type { ModelClient, ModelConversationItem, ModelReply } from "./model.js";
import { createDefaultPromptRegistry, SystemPromptRegistry } from "./prompt-registry.js";

/**
 * Agent 回合输入参数接口
 */
export interface AgentTurnInput {
  /** 账号唯一标识（用于身份校验与数据隔离） */
  accountId: string;
  /** 作用域标识（租户或资源空间） */
  scopeId: string;
  /** 会话标识（对应唯一的对话流） */
  sessionId: string;
  /** 回合标识（单次用户提问与模型推理交互流的唯一 ID） */
  turnId: string;
  /** 用户的输入提示词/指令内容 */
  userMessage: string;
  /** 系统级临时补充指令（可选） */
  systemInstruction?: string;
  /** 继承自父会话/祖先的不可变事件切片（用于分支或多智能体委派） */
  inheritedEvents?: readonly AgentEvent[];
  /** 严格的执行身份快照（包含空间、租户、授权 ID 与已允许的工具清单） */
  executionIdentity?: ExecutionIdentity;
  /** 用于外部取消任务的中断信号（如用户点击停止按钮） */
  signal?: AbortSignal;
}

/**
 * Agent 回合运行结果
 */
export interface AgentRunResult {
  /** 最终执行状态：完成、失败或被取消 */
  status: "completed" | "failed" | "cancelled";
  /** 交付给用户的最终总结文本 */
  finalText: string;
  /** 本回合持久化落盘的最后一条事件序列号（用于断线增量回放） */
  lastEventSeq: number;
}

/**
 * AgentEngine 引擎初始化配置选项
 */
export interface AgentEngineOptions {
  /** 模型调用客户端（对接 Daoyin AI Gateway 或本地模型网关） */
  model: ModelClient;
  /** 工具注册表（管理所有可调用的工具、Schema 校验与审计） */
  tools: ToolRegistry;
  /** 事件持久化存储（追加式 JSONL 或数据库） */
  events: SessionEventStore;
  /** 简易单体系统提示词（与 promptRegistry 二选一） */
  systemPrompt?: string;
  /** 结构化系统提示词注册表（支持分段、优先级与动态/稳定切分） */
  promptRegistry?: SystemPromptRegistry;
  /** 单回合最大推理步数（防止死循环，默认 16） */
  maxSteps?: number;
  /** 单回合累计工具调用上限（防止无限调用，默认 32） */
  maxToolCalls?: number;
  /** 上下文中保留的最大历史轮数 */
  historyMaxTurns?: number;
  /** 上下文中保留的最大字符上限 */
  historyMaxCharacters?: number;
  /** 送往大模型的最大总上下文字符预算（防溢出） */
  maxContextCharacters?: number;
  /** 送往大模型的最大消息条数 */
  maxContextMessages?: number;
  /** 工具连续返回无变化结果的容忍次数（防止重复空转，默认 3 次） */
  maxUnchangedToolResults?: number;
  /** 单次模型请求超时时间毫秒数（默认 90,000 毫秒） */
  modelTimeoutMs?: number;
  /** 受信任且绑定命名空间的长期记忆提供方（不接受模型自选身份） */
  memory?: AgentMemoryProvider;
  /** 会话压缩摘要存储（用于长会话自动压缩落盘） */
  compactionStore?: SessionCompactionStore;
  /** 压缩时保留的最近完整轮数（防止最近上下文被压缩丢失细节） */
  compactionRetainRecentTurns?: number;
  /** 触发自动压缩的未压缩轮数阈值 */
  compactionTriggerUncompactedTurns?: number;
  /** 触发自动压缩的字符量阈值 */
  compactionTriggerCharacters?: number;
  /** 压缩后摘要的最大字符限制 */
  compactionMaxSummaryCharacters?: number;
  /** 外部事件监听回调（用于 WebSocket 实时广播或日志监听） */
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}

/** 追加事件的辅助类型定义 */
type AppendEvent = <TType extends AgentEventType>(type: TType, payload: AgentEventPayloads[TType]) => Promise<AgentEvent>;

/** 会引起记忆变更的工具名称集合（单回合内只允许变更一次） */
const MEMORY_MUTATION_TOOL_NAMES = new Set(["memory_remember", "memory_update", "memory_forget"]);

/** 模型等待时展示进度状态提示的初始延迟毫秒数（4秒） */
const MODEL_PROGRESS_INITIAL_DELAY_MS = 4_000;
/** 模型等待时轮询更新提示的间隔毫秒数（7秒） */
const MODEL_PROGRESS_INTERVAL_MS = 7_000;

/**
 * 带有超时控制和中断信号的异步等待延迟函数
 */
function progressDelay(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(true); }, milliseconds);
    const stop = () => { clearTimeout(timer); resolve(false); };
    signal.addEventListener("abort", stop, { once: true });
  });
}

/**
 * 在模型长思考等待期间，定期向前端广播友好的进度状态（如“正在理解需求并整理目标…”）
 */
async function publishModelProgress(append: AppendEvent, step: number, signal: AbortSignal): Promise<void> {
  const planning = ["正在理解需求并整理目标…", "正在选择合适的操作步骤…", "正在等待规划结果…", "仍在处理，请稍候…"];
  const followUp = ["正在分析操作结果…", "正在整理下一步处理…", "正在等待后续处理结果…", "仍在处理，请稍候…"];
  const messages = step === 0 ? planning : followUp;
  let index = 0;
  let delay = MODEL_PROGRESS_INITIAL_DELAY_MS;
  while (await progressDelay(delay, signal)) {
    await append("phase.updated", { phase: step === 0 ? "thinking" : "synthesizing",
      displayText: messages[index % messages.length]!, step });
    index += 1;
    delay = MODEL_PROGRESS_INTERVAL_MS;
  }
}

/**
 * 将各类错误归一化为标准的模型错误结构体
 */
function modelFailure(error: unknown): { code: string; message: string } {
  if (error instanceof AgentPolicyError) return { code: error.code, message: error.message };
  const message = error instanceof Error ? error.message : "Model request failed.";
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^MODEL_[A-Z0-9_]{1,80}$/u.test(code)) return { code, message };
  }
  return { code: "MODEL_REQUEST_FAILED", message };
}

/**
 * 安全地将未知值转换为符合规范的 JsonValue，防止循环引用或超深嵌套递归
 */
function toJsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 12) return "[depth-limit]";
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => toJsonValue(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 200).map(([key, item]) => [key, toJsonValue(item, depth + 1)]));
  }
  return String(value);
}

/**
 * 校验并清理工具返回的进度详情，严禁泄露密钥、Token、Cookie 等敏感字段，且限制长度
 */
function progressDetail(value: unknown): JsonValue {
  const detail = toJsonValue(value);
  const serialized = JSON.stringify(detail);
  if (serialized.length > 8000 || /"(?:authorization|cookie|credential|password|secret|token|api[_-]?key|stack)"\s*:/iu.test(serialized) ||
      /bearer\s+[a-z0-9._~+/-]{8,}|\bsk-[a-z0-9_-]{8,}\b/iu.test(serialized)) {
    throw new AgentPolicyError("TOOL_PROGRESS_DETAIL_INVALID", "工具返回了不安全或过长的进度详情。");
  }
  return detail;
}

/**
 * 校验数值是否在合理的安全整数范围内
 */
function limit(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}.`);
  return value;
}

/**
 * 模型请求执行包装器：支持超时与信号中断；若等待终止，迟到的模型回复绝不派发工具，禁止自动重试
 */
async function modelResponse(operation: () => Promise<ModelReply>, signal: AbortSignal): Promise<ModelReply> {
  signal.throwIfAborted();
  let listener: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(new AgentPolicyError("MODEL_WAIT_ABORTED", "模型等待已终止，未自动重试。"));
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }), interrupted]);
  } finally { if (listener !== undefined) signal.removeEventListener("abort", listener); }
}

/**
 * 回合幂等性检查：如果该回合之前已执行完毕，直接返回历史终态结果，避免重复执行
 */
function existingResult(events: readonly AgentEvent[], input: AgentTurnInput): AgentRunResult | undefined {
  const own = events.filter((event) => event.turnId === input.turnId);
  if (!own.length) return undefined;
  const started = own.find((event) => event.type === "turn.started");
  if (started?.type === "turn.started" && started.payload.userMessage !== input.userMessage) {
    throw new AgentPolicyError("AGENT_TURN_CONFLICT", "同一回合标识不能用于不同用户目标。");
  }
  const terminal = own.findLast((event) => ["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"].includes(event.type));
  if (terminal?.type === "turn.completed" || terminal?.type === "turn.failed") {
    return { status: terminal.payload.status, finalText: terminal.payload.outcomeSummary, lastEventSeq: terminal.eventSeq };
  }
  if (terminal?.type === "turn.cancelled") return { status: "cancelled", finalText: "任务已停止。", lastEventSeq: terminal.eventSeq };
  throw new AgentPolicyError("AGENT_TURN_REPLAY_BLOCKED", "该回合已开始但没有可重放的完成结果。请核对中断记录，在新回合继续；不能自动重复外部操作。");
}

export class AgentEngine {
  readonly #model: ModelClient;
  readonly #tools: ToolRegistry;
  readonly #events: SessionEventStore;
  readonly #context: ContextAssembler;
  readonly #compactor: ContextCompactor | null;
  readonly #maxSteps: number;
  readonly #maxToolCalls: number;
  readonly #maxContextCharacters: number;
  readonly #maxContextMessages: number;
  readonly #maxUnchanged: number;
  readonly #modelTimeoutMs: number;
  readonly #memory: AgentMemoryProvider | undefined;
  readonly #activeSessions = new Set<string>();
  readonly #onEvent: ((event: AgentEvent) => void | Promise<void>) | undefined;

  public constructor(options: AgentEngineOptions) {
    if (options.systemPrompt !== undefined && options.promptRegistry !== undefined) throw new Error("Provide either systemPrompt or promptRegistry, not both.");
    this.#model = options.model;
    this.#tools = options.tools;
    this.#events = options.events;
    const promptRegistry = options.promptRegistry ?? (options.systemPrompt === undefined ? createDefaultPromptRegistry() :
      new SystemPromptRegistry([{ id: "override", kind: "stable", priority: 0, render: () => options.systemPrompt ?? "" }]));
    this.#context = new ContextAssembler({ promptRegistry,
      ...(options.historyMaxTurns === undefined ? {} : { historyMaxTurns: options.historyMaxTurns }),
      ...(options.historyMaxCharacters === undefined ? {} : { historyMaxCharacters: options.historyMaxCharacters }),
    });
    this.#compactor = options.compactionStore === undefined ? null : new ContextCompactor({
      store: options.compactionStore,
      ...(options.compactionRetainRecentTurns === undefined ? {} : { retainRecentTurns: options.compactionRetainRecentTurns }),
      ...(options.compactionTriggerUncompactedTurns === undefined ? {} : { triggerUncompactedTurns: options.compactionTriggerUncompactedTurns }),
      ...(options.compactionTriggerCharacters === undefined ? {} : { triggerCharacters: options.compactionTriggerCharacters }),
      ...(options.compactionMaxSummaryCharacters === undefined ? {} : { maxSummaryCharacters: options.compactionMaxSummaryCharacters }),
    });
    this.#maxSteps = limit(options.maxSteps ?? 16, 1, 100, "step limit");
    this.#maxToolCalls = limit(options.maxToolCalls ?? 32, 1, 200, "tool limit");
    this.#maxContextCharacters = limit(options.maxContextCharacters ?? 96_000, 8_000, 400_000, "context character limit");
    this.#maxContextMessages = limit(options.maxContextMessages ?? 36, 6, 100, "context message limit");
    this.#maxUnchanged = limit(options.maxUnchangedToolResults ?? 3, 2, 20, "no-progress limit");
    this.#modelTimeoutMs = limit(options.modelTimeoutMs ?? 90_000, 10, 600_000, "model timeout");
    this.#onEvent = options.onEvent;
    this.#memory = options.memory;
  }

  public async runTurn(input: AgentTurnInput): Promise<AgentRunResult> {
    if (!input.accountId || !input.scopeId || !input.sessionId || !input.turnId || !input.userMessage.trim() || input.userMessage.length > 64_000) {
      throw new AgentPolicyError("AGENT_INPUT_INVALID", "回合身份或用户目标无效。");
    }
    if (this.#activeSessions.has(input.sessionId)) throw new AgentPolicyError("AGENT_SESSION_BUSY", "当前会话已有执行中的回合。");
    this.#activeSessions.add(input.sessionId);
    try { return await this.#runTurn(input); }
    finally { this.#activeSessions.delete(input.sessionId); }
  }

  async #runTurn(input: AgentTurnInput): Promise<AgentRunResult> {
    const signal = input.signal ?? new AbortController().signal;
    const executionIdentity = input.executionIdentity === undefined ? undefined : snapshotExecutionIdentity(input.executionIdentity);
    if (executionIdentity !== undefined && executionIdentity.actorUserId !== input.accountId) {
      throw new AgentPolicyError("AGENT_IDENTITY_MISMATCH", "执行身份与账号不匹配。");
    }
    const executionContext: ToolExecutionContext = {
      accountId: input.accountId, scopeId: input.scopeId, sessionId: input.sessionId, turnId: input.turnId, sourceEventIds: [],
      ...(executionIdentity === undefined ? {} : { executionIdentity }),
    };
    const priorEvents = await this.#events.read(input.sessionId);
    const inheritedEvents = input.inheritedEvents ?? [];
    if (priorEvents.some((event) => event.sessionId !== input.sessionId || event.accountId !== input.accountId || event.scopeId !== input.scopeId) ||
        inheritedEvents.some((event) => event.accountId !== input.accountId || event.scopeId !== input.scopeId)) {
      throw new AgentPolicyError("AGENT_HISTORY_SCOPE_MISMATCH", "历史事件不属于当前身份与资源范围。");
    }
    const existing = existingResult(priorEvents, input);
    if (existing !== undefined) return existing;
    const pending = new Set<string>();
    for (const event of priorEvents) {
      if (event.type === "turn.started") pending.add(event.turnId);
      if (["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"].includes(event.type)) pending.delete(event.turnId);
    }
    if (pending.size) throw new AgentPolicyError("AGENT_SESSION_NEEDS_RECOVERY", "会话存在未结束的回合，请先核对中断状态。");

    let lastEventSeq = priorEvents.at(-1)?.eventSeq ?? 0;
    const append: AppendEvent = async (type, payload) => {
      const event = await this.#events.append({ type, accountId: input.accountId, scopeId: input.scopeId,
        sessionId: input.sessionId, turnId: input.turnId, payload });
      lastEventSeq = event.eventSeq;
      if (this.#onEvent !== undefined) {
        try { await this.#onEvent(event); } catch { /* Persistence is authoritative; listeners can replay. */ }
      }
      return event;
    };
    const cancel = async (): Promise<AgentRunResult> => {
      const finalText = "任务已停止。";
      await append("assistant.delta", { contentBlockId: `block_${crypto.randomUUID()}`, delta: finalText });
      await append("turn.cancelled", { status: "cancelled", source: signal.reason === "runtime" ? "runtime" : "user", lastCompletedEventSeq: lastEventSeq });
      return { status: "cancelled", finalText, lastEventSeq };
    };
    const started = await append("turn.started", { status: "running", userMessageId: `msg_${crypto.randomUUID()}`, userMessage: input.userMessage });
    if (signal.aborted) return cancel();
    await append("phase.updated", { phase: "thinking", displayText: "正在准备任务上下文…", step: 0,
      detail: { status: "读取会话历史、长期记忆与本轮授权能力", next: "完成上下文整理后请求模型规划下一步" } });
    let compaction: SessionCompaction | undefined;
    let history: ModelConversationItem[];
    try {
      // Legacy summaries have no versioned memory dependency graph. Do not resurrect revoked
      // memory via their opaque text; memory-aware turns use a freshly filtered bounded history.
      compaction = this.#memory === undefined ? await this.#compactor?.compactIfNeeded(input.sessionId, priorEvents) : undefined;
      history = this.#context.historicalDialogueSources([
        ...(inheritedEvents.length ? [{ events: inheritedEvents }] : []),
        { events: priorEvents, ...(compaction === undefined ? {} : { compaction }) },
      ]);
    } catch {
      if (signal.aborted) return cancel();
      return this.#fail(append, "AGENT_CONTEXT_PREPARATION_FAILED", "历史读取或压缩失败，未执行新的工具操作。");
    }
    const current: ModelConversationItem[] = [{ role: "user", content: input.userMessage }];
    const toolReceipts: Array<{ toolCallId: string; name: string; ok: boolean; mutating: boolean }> = [];
    const completedMemoryMutations = new Set<string>();
    let memoryCheckpoint: string | undefined;
    const seenIds = new Set<string>();
    const progress = new ToolProgressGuard(this.#maxUnchanged);
    let attempts = 0;

    for (let step = 0; step < this.#maxSteps; step += 1) {
      if (signal.aborted) return cancel();
      const stop = progress.exhausted ? { code: "AGENT_NO_PROGRESS", message: "重复操作没有带来有效进展，已停止继续执行工具。" }
        : attempts >= this.#maxToolCalls ? { code: "AGENT_TOOL_LIMIT", message: "本轮工具调用预算已用尽。" } : undefined;
      const finalStep = stop !== undefined || step === this.#maxSteps - 1;
      let tools: ToolDescriptor[];
      try { tools = await this.#tools.descriptorsFor(executionContext); }
      catch { return signal.aborted ? cancel() : this.#fail(append, "AGENT_AUTHORIZATION_DENIED", "执行身份或工具授权已失效。"); }
      tools = tools.filter((tool) => !completedMemoryMutations.has(tool.name));
      if (finalStep) tools = [];
      const descriptors = new Map(tools.map((tool) => [tool.name, tool]));
      let reply: ModelReply;
      let streamed = "";
      const contentBlockId = `block_${crypto.randomUUID()}`;
      let memorySnapshot: MemoryContextSnapshot | undefined;
      try {
        let contextEvents = priorEvents;
        let contextInherited = inheritedEvents;
        const memory = this.#memory;
        if (memory !== undefined) {
          memorySnapshot = await memoryOperation((memorySignal) => memory.load({ turn: input, step,
            priorEvents, inheritedEvents, signal: memorySignal }), signal);
          contextEvents = memoryContextView(memorySnapshot, priorEvents);
          contextInherited = memoryContextView(memorySnapshot, inheritedEvents);
          history = this.#context.historicalDialogueSources([
            ...(contextInherited.length ? [{ events: contextInherited }] : []), { events: contextEvents },
          ]);
        }
        const context = await this.#context.assembleStep({ turn: input, priorEvents: contextEvents, step, tools,
          ...(contextInherited.length ? { inheritedEvents: contextInherited } : {}), ...(compaction === undefined ? {} : { compaction }) });
        const closing = finalStep ? `\n\n本轮最后一次回答，不再调用工具。${stop?.message ?? "请根据已完成的工具证据收尾。"}说明已完成事项与尚未解决的阻碍，不把局部成功说成全部完成。` : "";
        const memoryText = memorySnapshot?.text ? `\n\n${memorySnapshot.text}` : "";
        const systemPrompt = { stableText: context.prompt.stableText, dynamicText: context.prompt.dynamicText + memoryText + closing,
          sections: [...context.prompt.sections.map((section) => ({ id: section.id, kind: section.kind })),
            ...(memoryText ? [{ id: "confirmed_memory", kind: "dynamic" as const }] : [])] };
        const messages = boundModelContext({ systemMessage: { role: "system", content: context.systemMessage.content + memoryText + closing },
          history, current, ...(memoryCheckpoint === undefined ? {} : { runtimeNote: memoryCheckpoint }),
          overheadCharacters: JSON.stringify({ tools, sections: systemPrompt.sections }).length + 256,
          maxCharacters: this.#maxContextCharacters, maxMessages: this.#maxContextMessages });
        if (signal.aborted) return cancel();
        await append("phase.updated", { phase: step === 0 ? "thinking" : "synthesizing",
          displayText: step === 0 ? "正在规划下一步操作…" : "正在根据操作结果继续处理…", step,
          detail: { step: step + 1, availableToolCount: tools.length, completedToolCount: toolReceipts.length,
            next: step === 0 ? "等待模型选择回答或已授权工具" : "根据已完成工具证据决定继续操作或输出回答" } });
        const timeout = AbortSignal.timeout(this.#modelTimeoutMs);
        const streamFailure = new AbortController();
        const progressAbort = new AbortController();
        const progressFailure = new AbortController();
        const progressTask = publishModelProgress(append, step, AbortSignal.any([signal, progressAbort.signal]))
          .catch((error: unknown) => progressFailure.abort(error));
        const modelSignal = AbortSignal.any([signal, timeout, streamFailure.signal, progressFailure.signal]);
        const snapshot = memorySnapshot;
        const textBuffer = new TextDeltaBuffer({ signal: modelSignal,
          onFailure: (error) => streamFailure.abort(error instanceof AgentPolicyError ? error :
            new AgentPolicyError("AGENT_TEXT_PERSIST_FAILED", "正文保存未完成，已保留此前内容；请重试。")),
          emit: async (delta) => {
            if (snapshot !== undefined) await memoryOperation((memorySignal) => snapshot.assertCurrent(memorySignal), modelSignal);
            modelSignal.throwIfAborted();
            await append("assistant.delta", { contentBlockId, delta });
          },
        });
        try {
          if (snapshot !== undefined) await memoryOperation((memorySignal) => snapshot.assertCurrent(memorySignal), modelSignal);
          const raw = await modelResponse(() => this.#model.complete({ messages, tools, systemPrompt, signal: modelSignal,
            onTextDelta: async (delta) => {
              modelSignal.throwIfAborted();
              if (typeof delta !== "string" || streamed.length + delta.length > 16_000) throw new Error("Invalid model stream.");
              if (!delta) return;
              progressAbort.abort();
              streamed += delta;
              await textBuffer.push(delta);
            },
          }), modelSignal);
          progressAbort.abort();
          if (snapshot !== undefined) await memoryOperation((memorySignal) => snapshot.assertCurrent(memorySignal), modelSignal);
          modelSignal.throwIfAborted();
          reply = validateModelReply(raw, seenIds);
          if (streamed && streamed !== (reply.content ?? "")) throw new Error("Model stream did not match the final response.");
          // Flush validated text before tools or success; do not flush unvalidated late content.
          await textBuffer.finish();
        } catch (error) {
          if (progressFailure.signal.aborted) throw progressFailure.signal.reason;
          if (!signal.aborted && timeout.aborted) throw new AgentPolicyError("MODEL_TIMEOUT", "模型响应超时；请求结果不确定，未自动重试。");
          if (streamFailure.signal.aborted) throw streamFailure.signal.reason;
          throw error;
        } finally {
          // Wait for in-flight persistence, even on cancel. No timer can write after terminal state.
          progressAbort.abort();
          await progressTask;
          await textBuffer.discard();
        }
        if (signal.aborted) return cancel();
      } catch (error) {
        if (signal.aborted) return cancel();
        const failure = modelFailure(error);
        return this.#fail(append, failure.code, failure.message);
      }
      // =======================================================================
      // 情况 A：大模型返回了纯文本回答（代表本轮推理结束，给出最终结论）
      // =======================================================================
      if (reply.kind === "assistant") {
        const content = reply.content.trim();
        if (!content) return this.#fail(append, "MODEL_EMPTY_RESPONSE", "模型没有返回可显示的结果。");
        // 若此前已标记无进展中断，则以失败终态收尾
        if (stop !== undefined) return this.#fail(append, stop.code, stop.message, content);
        if (signal.aborted) return cancel();
        // 若没有通过流式输出过，补发全量文本片段事件
        if (!streamed) await append("assistant.delta", { contentBlockId, delta: content });
        if (signal.aborted) return cancel();
        // 持久化记录回合顺利完成的不可变事实事件
        await append("turn.completed", { status: "completed", assistantMessageId: `msg_${crypto.randomUUID()}`, outcomeSummary: content });
        return { status: "completed", finalText: content, lastEventSeq };
      }

      // =======================================================================
      // 情况 B：大模型返回了工具调用请求 (tool_calls)
      // =======================================================================
      // 如果已是最后一步收尾，但模型仍然违规发起工具调用，直接阻断报错
      if (finalStep) return this.#fail(append, stop?.code ?? "AGENT_STEP_LIMIT", stop?.message ?? "模型在最后一步仍要求执行工具，本轮已停止。");
      // 检查当前批次工具调用量是否超过剩余总预算
      if (attempts + reply.calls.length > this.#maxToolCalls) return this.#fail(append, "AGENT_TOOL_LIMIT", "本批次超过剩余工具预算，整批未执行。");

      // 记录已规划的工具调用 ID
      for (const call of reply.calls) seenIds.add(call.id);
      current.push({ role: "assistant_tool_calls", content: reply.content ?? "", calls: reply.calls });
      if (!streamed) {
        const commentary = reply.content?.trim();
        await append("assistant.commentary", {
          contentBlockId,
          text: commentary || "已确定下一步操作，马上开始执行。",
          source: commentary ? "model" : "system-fallback",
          stage: "before_tool",
          toolCallIds: reply.calls.map((call) => call.id),
        });
      }

      // 向前端广播工具规划详情，前端据此渲染操作卡片
      await append("phase.updated", { phase: "tool", displayText: `已规划 ${reply.calls.length} 项下一步操作`, step,
        detail: { source: "模型返回的实际工具调用计划", policy: "每项操作仍需通过权限、资源归属与参数校验",
          actions: reply.calls.map((call, index) => { const descriptor = descriptors.get(call.name); return {
            order: index + 1, toolName: call.name, displayName: descriptor?.displayName ?? "执行操作",
            description: descriptor?.description ?? "已授权操作",
            mutating: descriptor?.mutating ?? false, input: toJsonValue(this.#tools.auditInput(call.name, call.input)),
          }; }) } });

      // -----------------------------------------------------------------------
      // 逐项执行当前批次中的每一个工具调用
      // -----------------------------------------------------------------------
      for (const [callIndex, call] of reply.calls.entries()) {
        if (signal.aborted) return cancel();

        // 每次执行工具前，校验当前记忆快照版本是否依旧有效（防外部并发撤销或篡改）
        const snapshot = memorySnapshot;
        if (snapshot !== undefined) {
          try { await memoryOperation((memorySignal) => snapshot.assertCurrent(memorySignal), signal); }
          catch (error) {
            if (signal.aborted) return cancel();
            const failure = modelFailure(error);
            return this.#fail(append, failure.code, failure.message);
          }
        }

        attempts += 1;
        const descriptor = descriptors.get(call.name);

        // 工具进度守卫前置检查：若已判定无进展则终止；否则检查该调用是否与之前完全重复
        let result: ToolExecution | undefined = progress.exhausted
          ? { ok: false, code: "TOOL_NO_PROGRESS", message: "本轮已停止进一步工具执行。", retryable: false }
          : progress.before(call, descriptor);

        if (result === undefined) {
          // 持久化记录工具开始执行事件（入参严格经过 auditInput 脱敏处理，防密钥入库）
          const toolStarted = await append("tool.started", { toolCallId: call.id, toolName: call.name,
            ...(descriptor?.displayName === undefined ? {} : { displayName: descriptor.displayName }),
            displayText: descriptor?.displayName ? `正在${descriptor.displayName}…` : "正在执行操作…",
            input: toJsonValue(this.#tools.auditInput(call.name, call.input)) });

          if (signal.aborted) {
            await append("tool.failed", { toolCallId: call.id, toolName: call.name, code: "TOOL_CANCELLED",
              ...(descriptor?.displayName === undefined ? {} : { displayName: descriptor.displayName }),
              message: "执行前已取消，本工具未发出。", retryable: false, details: { execution: "not_started" } });
            return cancel();
          }

          if (snapshot !== undefined) {
            try { await memoryOperation((memorySignal) => snapshot.assertCurrent(memorySignal), signal); }
            catch (error) {
              const failure = modelFailure(error);
              await append("tool.failed", { toolCallId: call.id, toolName: call.name, code: failure.code,
                ...(descriptor?.displayName === undefined ? {} : { displayName: descriptor.displayName }),
                message: "工具尚未发出，记忆引用校验未通过。", retryable: false, details: { execution: "not_started" } });
              if (signal.aborted) return cancel();
              return this.#fail(append, failure.code, failure.message);
            }
          }

          progress.started(call, descriptor);
          let lastProgressAt = 0;

          /**
           * 工具执行过程中的流式进度上报函数（如上传进度 50%、网页抓取中等）
           * 包含安全字符校验与 150ms 的上报节流限制
           */
          const reportProgress = async (update: ToolProgressUpdate): Promise<void> => {
            signal.throwIfAborted();
            const displayText = update.displayText.trim();
            const completed = update.completed;
            const total = update.total;
            const hasControl = [...displayText].some((character) => {
              const code = character.codePointAt(0) ?? 0;
              return code < 32 || code === 127;
            });
            if (!displayText || displayText.length > 160 || hasControl ||
                (completed !== undefined && (!Number.isSafeInteger(completed) || completed < 0)) ||
                (total !== undefined && (!Number.isSafeInteger(total) || total < 1)) ||
                (completed !== undefined && total !== undefined && completed > total)) {
              throw new AgentPolicyError("TOOL_PROGRESS_INVALID", "工具返回了无效的进度信息。");
            }
            const now = Date.now();
            if (now - lastProgressAt < 150) return; // 150毫秒防抖节流
            lastProgressAt = now;
            await append("tool.progress", { toolCallId: call.id, toolName: call.name, displayText,
              ...(descriptor?.displayName === undefined ? {} : { displayName: descriptor.displayName }),
              ...(completed === undefined ? {} : { completed }), ...(total === undefined ? {} : { total }),
              ...(update.detail === undefined ? {} : { detail: progressDetail(update.detail) }) });
          };

          // 核心：调用 ToolRegistry 真正分派执行具体工具逻辑
          result = await this.#tools.execute(structuredClone(call), signal, {
            ...executionContext, sourceEventIds: [started.id, toolStarted.id], reportProgress,
          });

          // 即使后续被取消，也必须先记录已产生的工具执行结果与副作用证据
          progress.observe(call, result);
        }

        // 记录工具执行成功或失败的持久化事件
        if (result.ok) {
          if (MEMORY_MUTATION_TOOL_NAMES.has(call.name)) completedMemoryMutations.add(call.name);
          await append("tool.completed", { toolCallId: call.id, toolName: call.name,
            ...(descriptor?.displayName === undefined ? {} : { displayName: descriptor.displayName }),
            summary: result.summary, evidence: result.evidence });
        } else {
          await append("tool.failed", { toolCallId: call.id, toolName: call.name, code: result.code,
            ...(descriptor?.displayName === undefined ? {} : { displayName: descriptor.displayName }),
            message: result.message, retryable: result.retryable, ...(result.details === undefined ? {} : { details: result.details }) });
        }

        // 将工具执行结果格式化（做安全截断）后作为工具消息加入本轮上下文，供后续模型阅读
        current.push({ role: "tool", toolCallId: call.id, toolName: call.name, content: modelToolResult(result) });
        toolReceipts.push({ toolCallId: call.id, name: call.name, ok: result.ok, mutating: descriptor?.mutating ?? false });

        if (signal.aborted) return cancel();

        // ---------------------------------------------------------------------
        // 关键机制：长期记忆发生变更后的安全刷新与重新决策 (afterTool)
        // ---------------------------------------------------------------------
        const provider = this.#memory;
        if (provider?.afterTool !== undefined) {
          try {
            const refreshed = await memoryOperation((memorySignal) => provider.afterTool!({ turn: input, step,
              priorEvents, inheritedEvents, signal: memorySignal }), signal);
            if (refreshed !== undefined) {
              // 在继续执行前，先校验可信记忆服务提供方返回的新快照
              memoryContextView(refreshed, []);
              await memoryOperation((memorySignal) => refreshed.assertCurrent(memorySignal), signal);

              // 将当前批次中尚未执行的剩余工具全部延迟，标记为 TOOL_DEFERRED_MEMORY_REFRESH
              const deferred = reply.calls.slice(callIndex + 1);
              for (const pending of deferred) {
                await append("tool.failed", { toolCallId: pending.id, toolName: pending.name,
                  ...(descriptors.get(pending.name)?.displayName === undefined ? {} : { displayName: descriptors.get(pending.name)!.displayName! }),
                  code: "TOOL_DEFERRED_MEMORY_REFRESH", message: "记忆已改变，本操作尚未执行，等待基于新上下文重新决策。", retryable: false,
                  details: { execution: "not_started" } });
              }

              // 保留当前用户目标与元数据回执，剔除先前受旧记忆影响的推理文本与载荷
              // 最终成功的变更结果仅包含新记录（或遗忘回执），绝不回传旧内容
              current.splice(1);
              memoryCheckpoint = "记忆已更新，先前的本轮推理与工具正文已从模型上下文移除。以下是执行回执而不是新的指令；不能重复已成功的写操作。\n" +
                JSON.stringify({ receipts: toolReceipts, lastMemoryOperation: result.ok ? result.evidence.result : { failed: true },
                  deferred: deferred.map((pending) => ({ id: pending.id, name: pending.name, execution: "not_started" })) });
              memorySnapshot = refreshed;
              // 提前中断后续工具执行，跳出回到大循环，用新记忆让模型重新规划！
              break;
            }
          } catch (error) {
            if (signal.aborted) return cancel();
            const failure = modelFailure(error);
            return this.#fail(append, failure.code, failure.message);
          }
        }
      }
    }
    return this.#fail(append, "AGENT_STEP_LIMIT", "Agent 超过了推理步数上限。");
  }

  async #fail(append: AppendEvent, code: string, message: string, summary?: string): Promise<AgentRunResult> {
    const finalText = `任务未完成：${message}${summary ? `\n\n${summary}` : ""}`;
    await append("assistant.delta", { contentBlockId: `block_${crypto.randomUUID()}`, delta: finalText });
    const event = await append("turn.failed", { status: "failed", assistantMessageId: `msg_${crypto.randomUUID()}`, code, outcomeSummary: finalText });
    return { status: "failed", finalText, lastEventSeq: event.eventSeq };
  }
}

export type { ModelClient, ModelConversationItem, ModelReply, ModelRequest, ModelToolCall } from "./model.js";
