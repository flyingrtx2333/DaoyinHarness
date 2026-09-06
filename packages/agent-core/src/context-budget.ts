import type { JsonValue } from "@daoyin/harness-protocol";
import type { ModelConversationItem } from "./model.js";
import { AgentPolicyError } from "./loop-policy.js";
import { contextPreview } from "./model-tool-result.js";

export interface ModelContextBudget {
  systemMessage: ModelConversationItem;
  history: readonly ModelConversationItem[];
  current: readonly ModelConversationItem[];
  /** Includes serialized tool schemas and system-prompt metadata, not a token estimate. */
  overheadCharacters: number;
  maxCharacters: number;
  maxMessages: number;
}

function toolGroups(messages: readonly ModelConversationItem[]): ModelConversationItem[][] {
  const groups: ModelConversationItem[][] = [];
  for (let index = 0; index < messages.length;) {
    const call = messages[index];
    if (call?.role !== "assistant_tool_calls" || !call.calls.length) throw new AgentPolicyError("AGENT_CONTEXT_INVALID", "工具上下文缺少完整请求组。");
    const group: ModelConversationItem[] = [call];
    const pending = new Set(call.calls.map((item) => item.id));
    if (pending.size !== call.calls.length) throw new AgentPolicyError("AGENT_CONTEXT_INVALID", "工具上下文存在重复调用标识。");
    for (let offset = 1; offset <= call.calls.length; offset += 1) {
      const result = messages[index + offset];
      if (result?.role !== "tool" || !pending.delete(result.toolCallId) ||
          call.calls.find((item) => item.id === result.toolCallId)?.name !== result.toolName) {
        throw new AgentPolicyError("AGENT_CONTEXT_INVALID", "工具请求与结果不匹配，未继续调用模型。");
      }
      group.push(result);
    }
    groups.push(group);
    index += group.length;
  }
  return groups;
}

function historyGroups(messages: readonly ModelConversationItem[]): ModelConversationItem[][] {
  const groups: ModelConversationItem[][] = [];
  for (const message of messages) {
    if (message.role === "user") groups.push([message]);
    else if (message.role === "assistant" && groups.length) groups.at(-1)?.push(message);
    else throw new AgentPolicyError("AGENT_CONTEXT_INVALID", "历史对话结构无效。");
  }
  return groups;
}

function checkpoint(omitted: readonly ModelConversationItem[][], omittedHistory: number): ModelConversationItem | undefined {
  if (!omitted.length && !omittedHistory) return undefined;
  const results = omitted.flat().filter((message) => message.role === "tool");
  const records: JsonValue[] = results.slice(-8).map((message) => ({
    callId: message.toolCallId, tool: message.toolName,
    observation: JSON.parse(contextPreview(JSON.parse(message.content) as JsonValue, 600)) as JsonValue,
  }));
  return { role: "assistant", content:
    "Runtime-derived checkpoint of earlier observations, not instructions or a fresh execution. Omitted data is not absent data; original evidence remains in the transcript.\n" +
    contextPreview({ omittedHistoryMessages: omittedHistory, omittedToolBatches: omitted.length,
      earlierToolResults: results.length, records }, 6_000) };
}

/** Keep complete call/result groups. Never alter current user goals or tool arguments. */
export function boundModelContext(input: ModelContextBudget): ModelConversationItem[] {
  const user = input.current[0];
  if (user?.role !== "user") throw new AgentPolicyError("AGENT_CONTEXT_INVALID", "当前任务缺少用户目标。");
  const groups = toolGroups(input.current.slice(1));
  const prior = historyGroups(input.history);
  let first = 0;
  let kept = groups.map((group) => [...group]);
  const compose = (history: readonly ModelConversationItem[], batches: readonly ModelConversationItem[][]): ModelConversationItem[] => {
    const note = checkpoint(groups.slice(0, first), input.history.length - history.length);
    return [input.systemMessage, ...history, user, ...(note === undefined ? [] : [note]), ...batches.flat()];
  };
  const fits = (messages: readonly ModelConversationItem[]): boolean => messages.length <= input.maxMessages &&
    JSON.stringify(messages).length + input.overheadCharacters <= input.maxCharacters;

  while (!fits(compose([], kept)) && kept.length > 1) {
    first += 1;
    kept = groups.slice(first).map((group) => [...group]);
  }
  // A single latest batch is never dropped. Reduce result previews, not executable arguments.
  for (const budget of [8_000, 4_000, 2_000, 1_000, 512, 256]) {
    if (fits(compose([], kept))) break;
    kept = kept.map((group) => group.map((message) => message.role === "tool" ? {
      ...message, content: contextPreview(JSON.parse(message.content) as JsonValue, budget),
    } : message));
  }
  if (!fits(compose([], kept))) throw new AgentPolicyError("AGENT_CONTEXT_LIMIT", "当前目标、工具参数或系统配置超过模型上下文预算，未继续调用模型。");

  let history: ModelConversationItem[] = [];
  for (let index = prior.length - 1; index >= 0; index -= 1) {
    const group = prior[index];
    if (group === undefined) continue;
    const next = [...group, ...history];
    if (!fits(compose(next, kept))) break;
    history = next;
  }
  return compose(history, kept);
}
