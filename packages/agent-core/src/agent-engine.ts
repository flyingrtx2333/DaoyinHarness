import type {
  AgentEvent,
  AgentEventPayloads,
  AgentEventType,
  JsonValue,
  PendingAgentEvent,
} from "@daoyin/harness-protocol";
import { ToolRegistry, type ToolExecution } from "@daoyin/harness-tools";
import type { SessionCompactionStore, SessionEventStore } from "@daoyin/harness-workspace";
import { ContextAssembler } from "./context-assembler.js";
import { ContextCompactor } from "./context-compactor.js";
import type { ModelClient, ModelConversationItem, ModelReply, ModelToolCall } from "./model.js";
import { createDefaultPromptRegistry, SystemPromptRegistry } from "./prompt-registry.js";

export interface AgentTurnInput {
  accountId: string;
  scopeId: string;
  sessionId: string;
  turnId: string;
  userMessage: string;
  systemInstruction?: string;
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
  compactionStore?: SessionCompactionStore;
  compactionRetainRecentTurns?: number;
  compactionTriggerUncompactedTurns?: number;
  compactionTriggerCharacters?: number;
  compactionMaxSummaryCharacters?: number;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}

function modelToolResult(result: ToolExecution): string {
  if (result.ok) {
    return JSON.stringify({ ok: true, summary: result.summary, result: result.evidence.result });
  }
  return JSON.stringify({ ok: false, code: result.code, message: result.message, retryable: result.retryable, ...(result.details === undefined ? {} : { details: result.details }) });
}

function isUsableToolCall(call: ModelToolCall): boolean {
  return (
    typeof call.id === "string" && call.id.length > 0 &&
    typeof call.name === "string" && call.name.length > 0 &&
    typeof call.input === "object" && call.input !== null && !Array.isArray(call.input)
  );
}

function toJsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 12) return "[depth-limit]";
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => toJsonValue(item, depth + 1));
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value).slice(0, 200)) {
      result[key] = toJsonValue(item, depth + 1);
    }
    return result;
  }
  return String(value);
}

function customPromptRegistry(systemPrompt: string): SystemPromptRegistry {
  return new SystemPromptRegistry([
    {
      id: "override",
      kind: "stable",
      priority: 0,
      render: () => systemPrompt,
    },
  ]);
}

export class AgentEngine {
  readonly #model: ModelClient;
  readonly #tools: ToolRegistry;
  readonly #events: SessionEventStore;
  readonly #context: ContextAssembler;
  readonly #compactor: ContextCompactor | null;
  readonly #maxSteps: number;
  readonly #maxToolCalls: number;
  readonly #onEvent: ((event: AgentEvent) => void | Promise<void>) | undefined;

  public constructor(options: AgentEngineOptions) {
    if (options.systemPrompt !== undefined && options.promptRegistry !== undefined) {
      throw new Error("Provide either systemPrompt or promptRegistry, not both.");
    }
    this.#model = options.model;
    this.#tools = options.tools;
    this.#events = options.events;
    const promptRegistry = options.promptRegistry ?? (
      options.systemPrompt === undefined ? createDefaultPromptRegistry() : customPromptRegistry(options.systemPrompt)
    );
    this.#context = new ContextAssembler({
      promptRegistry,
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
    this.#maxSteps = options.maxSteps ?? 16;
    this.#maxToolCalls = options.maxToolCalls ?? 32;
    this.#onEvent = options.onEvent;
  }

  public async runTurn(input: AgentTurnInput): Promise<AgentRunResult> {
    const signal = input.signal ?? new AbortController().signal;
    let lastEventSeq = 0;
    let toolCallCount = 0;
    const seenToolCalls = new Set<string>();

    const append = async <TType extends AgentEventType>(type: TType, payload: AgentEventPayloads[TType]): Promise<AgentEvent> => {
      const pending: PendingAgentEvent<TType> = {
        type,
        accountId: input.accountId,
        scopeId: input.scopeId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        payload,
      };
      const event = await this.#events.append(pending);
      lastEventSeq = event.eventSeq;
      if (this.#onEvent !== undefined) {
        try {
          await this.#onEvent(event);
        } catch {
          // Persistence is authoritative; transient listeners may reconnect and replay.
        }
      }
      return event;
    };

    const priorEvents = await this.#events.read(input.sessionId);
    const compaction = await this.#compactor?.compactIfNeeded(input.sessionId, priorEvents);
    const conversation: ModelConversationItem[] = [
      ...this.#context.historicalDialogue(priorEvents, compaction),
      { role: "user", content: input.userMessage },
    ];

    const turnStartedEvent = await append("turn.started", {
      status: "running",
      userMessageId: `msg_${crypto.randomUUID()}`,
      userMessage: input.userMessage,
    });

    for (let step = 0; step < this.#maxSteps; step += 1) {
      if (signal.aborted) {
        const finalText = "任务已停止。";
        await append("assistant.delta", { contentBlockId: `block_${crypto.randomUUID()}`, delta: finalText });
        await append("turn.cancelled", { status: "cancelled", source: "user", lastCompletedEventSeq: lastEventSeq });
        return { status: "cancelled", finalText, lastEventSeq };
      }

      const tools = this.#tools.descriptors();
      const context = await this.#context.assembleStep({
        turn: input,
        priorEvents,
        ...(compaction === undefined ? {} : { compaction }),
        step,
        tools,
      });
      let reply: ModelReply;
      try {
        reply = await this.#model.complete({
          messages: [context.systemMessage, ...conversation],
          tools,
          systemPrompt: {
            stableText: context.prompt.stableText,
            dynamicText: context.prompt.dynamicText,
            sections: context.prompt.sections.map((section) => ({ id: section.id, kind: section.kind })),
          },
          signal,
        });
      } catch (error) {
        if (signal.aborted) {
          const finalText = "任务已停止。";
          await append("assistant.delta", { contentBlockId: `block_${crypto.randomUUID()}`, delta: finalText });
          await append("turn.cancelled", { status: "cancelled", source: "user", lastCompletedEventSeq: lastEventSeq });
          return { status: "cancelled", finalText, lastEventSeq };
        }
        return this.#fail(append, "MODEL_REQUEST_FAILED", error instanceof Error ? error.message : "Model request failed.");
      }

      if (reply.kind === "assistant") {
        const content = reply.content.trim();
        if (content.length === 0) {
          return this.#fail(append, "MODEL_EMPTY_RESPONSE", "模型没有返回可显示的结果。");
        }
        await append("assistant.delta", { contentBlockId: `block_${crypto.randomUUID()}`, delta: content });
        await append("turn.completed", {
          status: "completed",
          assistantMessageId: `msg_${crypto.randomUUID()}`,
          outcomeSummary: content,
        });
        return { status: "completed", finalText: content, lastEventSeq };
      }

      if (reply.calls.length === 0) {
        return this.#fail(append, "MODEL_TOOL_CALLS_EMPTY", "模型返回了空工具请求。");
      }
      conversation.push({ role: "assistant_tool_calls", content: reply.content ?? "", calls: reply.calls });

      for (const call of reply.calls) {
        toolCallCount += 1;
        if (toolCallCount > this.#maxToolCalls) {
          return this.#fail(append, "AGENT_TOOL_LIMIT", "Agent 超过了工具调用上限。");
        }
        if (!isUsableToolCall(call) || seenToolCalls.has(call.id)) {
          const result: ToolExecution = {
            ok: false,
            code: seenToolCalls.has(call.id) ? "TOOL_CALL_DUPLICATE" : "TOOL_CALL_INVALID",
            message: seenToolCalls.has(call.id) ? "Model repeated a tool-call ID." : "Model returned an invalid tool call.",
            retryable: false,
          };
          await append("tool.failed", {
            toolCallId: call.id || `invalid_${crypto.randomUUID()}`,
            toolName: call.name || "unknown",
            code: result.code,
            message: result.message,
            retryable: result.retryable,
          });
          conversation.push({ role: "tool", toolCallId: call.id, toolName: call.name, content: modelToolResult(result) });
          continue;
        }
        seenToolCalls.add(call.id);
        const toolStartedEvent = await append("tool.started", {
          toolCallId: call.id,
          toolName: call.name,
          displayText: `正在执行 ${call.name}`,
          input: toJsonValue(call.input),
        });
        const result = await this.#tools.execute(call, signal, {
          accountId: input.accountId,
          scopeId: input.scopeId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          sourceEventIds: [turnStartedEvent.id, toolStartedEvent.id],
        });
        if (result.ok) {
          await append("tool.completed", {
            toolCallId: call.id,
            toolName: call.name,
            summary: result.summary,
            evidence: result.evidence,
          });
        } else {
          await append("tool.failed", {
            toolCallId: call.id,
            toolName: call.name,
            code: result.code,
            message: result.message,
            retryable: result.retryable,
            ...(result.details === undefined ? {} : { details: result.details }),
          });
        }
        conversation.push({ role: "tool", toolCallId: call.id, toolName: call.name, content: modelToolResult(result) });
      }
    }

    return this.#fail(append, "AGENT_STEP_LIMIT", "Agent 超过了推理步数上限。");
  }

  async #fail(
    append: <TType extends AgentEventType>(type: TType, payload: AgentEventPayloads[TType]) => Promise<AgentEvent>,
    code: string,
    message: string,
  ): Promise<AgentRunResult> {
    const finalText = `任务未完成：${message}`;
    await append("assistant.delta", { contentBlockId: `block_${crypto.randomUUID()}`, delta: finalText });
    const terminalEvent = await append("turn.failed", {
      status: "failed",
      assistantMessageId: `msg_${crypto.randomUUID()}`,
      code,
      outcomeSummary: finalText,
    });
    return { status: "failed", finalText, lastEventSeq: terminalEvent.eventSeq };
  }
}

export type { ModelClient, ModelConversationItem, ModelReply, ModelRequest, ModelToolCall } from "./model.js";
