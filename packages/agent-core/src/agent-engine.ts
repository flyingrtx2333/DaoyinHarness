import type {
  AgentEvent,
  AgentEventPayloads,
  AgentEventType,
  JsonValue,
  PendingAgentEvent,
} from "@daoyin/harness-protocol";
import type { ToolRegistry, ToolDescriptor, ToolExecution, ToolExecutionContext } from "@daoyin/harness-tools/registry";
import { snapshotExecutionIdentity, type ExecutionIdentity, type SessionCompactionStore, type SessionEventStore } from "@daoyin/harness-contracts";
import { ContextAssembler } from "./context-assembler.js";
import { ContextCompactor } from "./context-compactor.js";
import { modelToolResult } from "./model-tool-result.js";
import { memoryContextView, memoryOperation, type AgentMemoryProvider, type MemoryContextSnapshot } from "./memory-context.js";
import type { ModelClient, ModelConversationItem, ModelReply, ModelToolCall } from "./model.js";
import { createDefaultPromptRegistry, SystemPromptRegistry } from "./prompt-registry.js";

export interface AgentTurnInput {
  accountId: string;
  scopeId: string;
  sessionId: string;
  turnId: string;
  userMessage: string;
  systemInstruction?: string;
  inheritedEvents?: readonly AgentEvent[];
  /** Cloud adapters supply an authenticated identity; local callers remain compatible. */
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
  /** Trusted, namespace-bound long-term memory. The model cannot select its identity or scope. */
  memory?: AgentMemoryProvider;
  historyMaxTurns?: number;
  historyMaxCharacters?: number;
  compactionStore?: SessionCompactionStore;
  compactionRetainRecentTurns?: number;
  compactionTriggerUncompactedTurns?: number;
  compactionTriggerCharacters?: number;
  compactionMaxSummaryCharacters?: number;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}

function isUsableToolCall(call: ModelToolCall): boolean {
  return (
    typeof call.id === "string" && call.id.length > 0 &&
    typeof call.name === "string" && call.name.length > 0 &&
    typeof call.input === "object" && call.input !== null && !Array.isArray(call.input)
  );
}

function modelFailure(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : "Model request failed.";
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^(?:MODEL|AGENT)_[A-Z0-9_]{1,80}$/u.test(code)) return { code, message };
  }
  return { code: "MODEL_REQUEST_FAILED", message };
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
  readonly #memory: AgentMemoryProvider | undefined;
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
    this.#memory = options.memory;
    this.#onEvent = options.onEvent;
  }

  public async runTurn(input: AgentTurnInput): Promise<AgentRunResult> {
    const signal = input.signal ?? new AbortController().signal;
    const executionIdentity = input.executionIdentity === undefined ? undefined : snapshotExecutionIdentity(input.executionIdentity);
    if (executionIdentity !== undefined && executionIdentity.actorUserId !== input.accountId) {
      throw new Error("Agent account does not match its authenticated execution identity.");
    }
    const executionContext: ToolExecutionContext = {
      accountId: input.accountId, scopeId: input.scopeId,
      sessionId: input.sessionId, turnId: input.turnId, sourceEventIds: [],
      ...(executionIdentity === undefined ? {} : { executionIdentity }),
    };
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
    const inheritedEvents = input.inheritedEvents ?? [];
    // Legacy compactions do not record durable-memory dependencies. Rebuild from the
    // still-valid transcript when memory is enabled so forgotten facts cannot resurface.
    const compaction = this.#memory === undefined ? await this.#compactor?.compactIfNeeded(input.sessionId, priorEvents) : undefined;
    const conversation: ModelConversationItem[] = [{ role: "user", content: input.userMessage }];

    const turnStartedEvent = await append("turn.started", {
      status: "running",
      userMessageId: `msg_${crypto.randomUUID()}`,
      userMessage: input.userMessage,
    });

    for (let step = 0; step < this.#maxSteps; step += 1) {
      if (signal.aborted) {
        const finalText = "任务已停止。";
        await append("assistant.delta", { contentBlockId: `block_${crypto.randomUUID()}`, delta: finalText });
        await append("turn.cancelled", { status: "cancelled", source: signal.reason === "runtime" ? "runtime" : "user", lastCompletedEventSeq: lastEventSeq });
        return { status: "cancelled", finalText, lastEventSeq };
      }

      let tools: ToolDescriptor[];
      try {
        tools = await this.#tools.descriptorsFor(executionContext);
      } catch {
        return this.#fail(append, "AGENT_AUTHORIZATION_DENIED", "执行身份或工具授权已失效。");
      }
      let reply: ModelReply;
      let memorySnapshot: MemoryContextSnapshot | undefined;
      let contextPriorEvents = priorEvents;
      let contextInheritedEvents = inheritedEvents;
      try {
        const memory = this.#memory;
        if (memory !== undefined) {
          memorySnapshot = await memoryOperation((memorySignal) => memory.load({
            turn: input, step, priorEvents, inheritedEvents, signal: memorySignal,
          }), signal);
          contextPriorEvents = memoryContextView(memorySnapshot, priorEvents);
          contextInheritedEvents = memoryContextView(memorySnapshot, inheritedEvents);
        }
        const context = await this.#context.assembleStep({
          turn: input,
          priorEvents: contextPriorEvents,
          ...(contextInheritedEvents.length === 0 ? {} : { inheritedEvents: contextInheritedEvents }),
          ...(compaction === undefined ? {} : { compaction }),
          step,
          tools,
        });
        const memoryText = memorySnapshot?.text ? "\n\n" + memorySnapshot.text : "";
        const history = this.#context.historicalDialogueSources([
          ...(contextInheritedEvents.length === 0 ? [] : [{ events: contextInheritedEvents }]),
          { events: contextPriorEvents, ...(compaction === undefined ? {} : { compaction }) },
        ]);
        const snapshotBeforeModel = memorySnapshot;
        if (snapshotBeforeModel !== undefined) {
          await memoryOperation((memorySignal) => snapshotBeforeModel.assertCurrent(memorySignal), signal);
        }
        reply = await this.#model.complete({
          messages: [{ role: "system", content: context.systemMessage.content + memoryText }, ...history, ...conversation],
          tools,
          systemPrompt: {
            stableText: context.prompt.stableText,
            dynamicText: context.prompt.dynamicText + memoryText,
            sections: [
              ...context.prompt.sections.map((section) => ({ id: section.id, kind: section.kind })),
              ...(memoryText.length === 0 ? [] : [{ id: "confirmed_memory", kind: "dynamic" as const }]),
            ],
          },
          signal,
        });
        const snapshotAfterModel = memorySnapshot;
        if (snapshotAfterModel !== undefined) {
          await memoryOperation((memorySignal) => snapshotAfterModel.assertCurrent(memorySignal), signal);
        }
      } catch (error) {
        if (signal.aborted) {
          const finalText = "任务已停止。";
          await append("assistant.delta", { contentBlockId: `block_${crypto.randomUUID()}`, delta: finalText });
          await append("turn.cancelled", { status: "cancelled", source: signal.reason === "runtime" ? "runtime" : "user", lastCompletedEventSeq: lastEventSeq });
          return { status: "cancelled", finalText, lastEventSeq };
        }
        const failure = modelFailure(error);
        return this.#fail(append, failure.code, failure.message);
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
        const snapshotBeforeTool = memorySnapshot;
        if (snapshotBeforeTool !== undefined) {
          try {
            await memoryOperation((memorySignal) => snapshotBeforeTool.assertCurrent(memorySignal), signal);
          } catch (error) {
            if (signal.aborted) {
              const finalText = "Task stopped.";
              await append("assistant.delta", { contentBlockId: "block_" + crypto.randomUUID(), delta: finalText });
              await append("turn.cancelled", { status: "cancelled", source: signal.reason === "runtime" ? "runtime" : "user", lastCompletedEventSeq: lastEventSeq });
              return { status: "cancelled", finalText, lastEventSeq };
            }
            const failure = modelFailure(error);
            return this.#fail(append, failure.code, failure.message);
          }
        }
        const toolStartedEvent = await append("tool.started", {
          toolCallId: call.id,
          toolName: call.name,
          displayText: `正在执行 ${call.name}`,
          input: toJsonValue(this.#tools.auditInput(call.name, call.input)),
        });
        const result = await this.#tools.execute(call, signal, {
          ...executionContext,
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
