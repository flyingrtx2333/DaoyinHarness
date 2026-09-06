import type { AgentEvent, AgentEventPayloads, AgentEventType, JsonValue, SessionCompaction } from "@daoyin/harness-protocol";
import type { ToolRegistry, ToolDescriptor, ToolExecution, ToolExecutionContext } from "@daoyin/harness-tools/registry";
import { snapshotExecutionIdentity, type ExecutionIdentity, type SessionCompactionStore, type SessionEventStore } from "@daoyin/harness-contracts";
import { ContextAssembler } from "./context-assembler.js";
import { ContextCompactor } from "./context-compactor.js";
import { boundModelContext } from "./context-budget.js";
import { AgentPolicyError, ToolProgressGuard, validateModelReply } from "./loop-policy.js";
import { modelToolResult } from "./model-tool-result.js";
import { memoryContextView, memoryOperation, type AgentMemoryProvider, type MemoryContextSnapshot } from "./memory-context.js";
import type { ModelClient, ModelConversationItem, ModelReply } from "./model.js";
import { createDefaultPromptRegistry, SystemPromptRegistry } from "./prompt-registry.js";

export interface AgentTurnInput {
  accountId: string;
  scopeId: string;
  sessionId: string;
  turnId: string;
  userMessage: string;
  systemInstruction?: string;
  inheritedEvents?: readonly AgentEvent[];
  executionIdentity?: ExecutionIdentity;
  signal?: AbortSignal;
}

export interface AgentRunResult {
  status: "completed" | "failed" | "cancelled";
  finalText: string;
  lastEventSeq: number;
}

export interface AgentEngineOptions {
  model: ModelClient;
  tools: ToolRegistry;
  events: SessionEventStore;
  systemPrompt?: string;
  promptRegistry?: SystemPromptRegistry;
  maxSteps?: number;
  maxToolCalls?: number;
  historyMaxTurns?: number;
  historyMaxCharacters?: number;
  maxContextCharacters?: number;
  maxContextMessages?: number;
  maxUnchangedToolResults?: number;
  modelTimeoutMs?: number;
  /** Trusted, namespace-bound long-term memory; no model-selected identity. */
  memory?: AgentMemoryProvider;
  compactionStore?: SessionCompactionStore;
  compactionRetainRecentTurns?: number;
  compactionTriggerUncompactedTurns?: number;
  compactionTriggerCharacters?: number;
  compactionMaxSummaryCharacters?: number;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}

type AppendEvent = <TType extends AgentEventType>(type: TType, payload: AgentEventPayloads[TType]) => Promise<AgentEvent>;

function modelFailure(error: unknown): { code: string; message: string } {
  if (error instanceof AgentPolicyError) return { code: error.code, message: error.message };
  const message = error instanceof Error ? error.message : "Model request failed.";
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^MODEL_[A-Z0-9_]{1,80}$/u.test(code)) return { code, message };
  }
  return { code: "MODEL_REQUEST_FAILED", message };
}

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

function limit(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}.`);
  return value;
}

/** Cancellation/timeout stops waiting; a late provider reply can never dispatch tools. No retries. */
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
      const descriptors = new Map(tools.map((tool) => [tool.name, tool]));
      if (finalStep) tools = [];
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
          history, current, overheadCharacters: JSON.stringify({ tools, systemPrompt }).length,
          maxCharacters: this.#maxContextCharacters, maxMessages: this.#maxContextMessages });
        if (signal.aborted) return cancel();
        const timeout = AbortSignal.timeout(this.#modelTimeoutMs);
        const modelSignal = AbortSignal.any([signal, timeout]);
        let raw: ModelReply;
        try {
          const snapshot = memorySnapshot;
          if (snapshot !== undefined) await memoryOperation((memorySignal) => snapshot.assertCurrent(memorySignal), modelSignal);
          raw = await modelResponse(() => this.#model.complete({ messages, tools, systemPrompt, signal: modelSignal,
            onTextDelta: async (delta) => {
              modelSignal.throwIfAborted();
              if (typeof delta !== "string" || streamed.length + delta.length > 16_000) throw new Error("Invalid model stream.");
              if (!delta) return;
              if (snapshot !== undefined) await memoryOperation((memorySignal) => snapshot.assertCurrent(memorySignal), modelSignal);
              await append("assistant.delta", { contentBlockId, delta });
              streamed += delta;
            },
          }), modelSignal);
          if (snapshot !== undefined) await memoryOperation((memorySignal) => snapshot.assertCurrent(memorySignal), modelSignal);
        }
        catch (error) {
          if (!signal.aborted && timeout.aborted) throw new AgentPolicyError("MODEL_TIMEOUT", "模型响应超时；请求结果不确定，未自动重试。");
          throw error;
        }
        if (signal.aborted) return cancel();
        reply = validateModelReply(raw, seenIds);
        if (streamed && streamed !== (reply.content ?? "")) throw new Error("Model stream did not match the final response.");
      } catch (error) {
        if (signal.aborted) return cancel();
        const failure = modelFailure(error);
        return this.#fail(append, failure.code, failure.message);
      }
      if (reply.kind === "assistant") {
        const content = reply.content.trim();
        if (!content) return this.#fail(append, "MODEL_EMPTY_RESPONSE", "模型没有返回可显示的结果。");
        if (stop !== undefined) return this.#fail(append, stop.code, stop.message, content);
        if (signal.aborted) return cancel();
        if (!streamed) await append("assistant.delta", { contentBlockId, delta: content });
        if (signal.aborted) return cancel();
        await append("turn.completed", { status: "completed", assistantMessageId: `msg_${crypto.randomUUID()}`, outcomeSummary: content });
        return { status: "completed", finalText: content, lastEventSeq };
      }
      if (finalStep) return this.#fail(append, stop?.code ?? "AGENT_STEP_LIMIT", stop?.message ?? "模型在最后一步仍要求执行工具，本轮已停止。");
      if (attempts + reply.calls.length > this.#maxToolCalls) return this.#fail(append, "AGENT_TOOL_LIMIT", "本批次超过剩余工具预算，整批未执行。");
      for (const call of reply.calls) seenIds.add(call.id);
      current.push({ role: "assistant_tool_calls", content: reply.content ?? "", calls: reply.calls });
      if (reply.content && !streamed) await append("assistant.delta", { contentBlockId, delta: reply.content });
      for (const call of reply.calls) {
        if (signal.aborted) return cancel();
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
        let result: ToolExecution | undefined = progress.exhausted
          ? { ok: false, code: "TOOL_NO_PROGRESS", message: "本轮已停止进一步工具执行。", retryable: false }
          : progress.before(call, descriptor);
        if (result === undefined) {
          const toolStarted = await append("tool.started", { toolCallId: call.id, toolName: call.name,
            displayText: `正在执行 ${call.name}`, input: toJsonValue(this.#tools.auditInput(call.name, call.input)) });
          if (signal.aborted) {
            await append("tool.failed", { toolCallId: call.id, toolName: call.name, code: "TOOL_CANCELLED",
              message: "执行前已取消，本工具未发出。", retryable: false, details: { execution: "not_started" } });
            return cancel();
          }
          if (snapshot !== undefined) {
            try { await memoryOperation((memorySignal) => snapshot.assertCurrent(memorySignal), signal); }
            catch (error) {
              const failure = modelFailure(error);
              await append("tool.failed", { toolCallId: call.id, toolName: call.name, code: failure.code,
                message: "工具尚未发出，记忆引用校验未通过。", retryable: false, details: { execution: "not_started" } });
              if (signal.aborted) return cancel();
              return this.#fail(append, failure.code, failure.message);
            }
          }
          progress.started(call, descriptor);
          result = await this.#tools.execute(structuredClone(call), signal, {
            ...executionContext, sourceEventIds: [started.id, toolStarted.id],
          });
          // Observe the returned outcome before cancellation, retaining completed side-effect evidence.
          progress.observe(call, result);
        }
        if (result.ok) await append("tool.completed", { toolCallId: call.id, toolName: call.name, summary: result.summary, evidence: result.evidence });
        else await append("tool.failed", { toolCallId: call.id, toolName: call.name, code: result.code,
          message: result.message, retryable: result.retryable, ...(result.details === undefined ? {} : { details: result.details }) });
        current.push({ role: "tool", toolCallId: call.id, toolName: call.name, content: modelToolResult(result) });
        if (signal.aborted) return cancel();
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
