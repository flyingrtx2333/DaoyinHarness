import type { ModelConversationItem, ModelRequest } from "./model.js";

const canonical = (text: string): string => text.replaceAll("\r\n", "\n").trim();

/** Structured prompt fields are authoritative on the wire; remove only exact system mirrors. */
export function wireMessages(request: Pick<ModelRequest, "messages" | "systemPrompt">): ModelConversationItem[] {
  const parts = [request.systemPrompt.stableText, request.systemPrompt.dynamicText].map(canonical).filter(Boolean);
  const mirrors = new Set([...parts, parts.join("\n\n")].filter(Boolean));
  return request.messages.filter((message) => message.role !== "system" || !mirrors.has(canonical(message.content)));
}
