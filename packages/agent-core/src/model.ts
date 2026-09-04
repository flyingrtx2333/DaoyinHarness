import type { ToolDescriptor } from "@daoyin/harness-tools";

export interface ModelToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ModelConversationItem =
  | { role: "system" | "user" | "assistant"; content: string }
  | { role: "assistant_tool_calls"; content: string; calls: ModelToolCall[] }
  | { role: "tool"; toolCallId: string; toolName: string; content: string };

export interface ModelSystemPromptMetadata {
  stableText: string;
  dynamicText: string;
  sections: readonly { id: string; kind: "stable" | "dynamic" }[];
}

export interface ModelRequest {
  messages: readonly ModelConversationItem[];
  tools: readonly ToolDescriptor[];
  systemPrompt: ModelSystemPromptMetadata;
  signal: AbortSignal;
}

export type ModelReply =
  | { kind: "assistant"; content: string }
  | { kind: "tool_calls"; content?: string; calls: ModelToolCall[] };

export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelReply>;
}
