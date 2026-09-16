import { expect, it } from "vitest";
import { shouldShowConversationConceptSet } from "./ConversationConcepts.js";

it("removes a completed concept choice from the conversation", () => {
  expect(shouldShowConversationConceptSet("generating")).toBe(true);
  expect(shouldShowConversationConceptSet("awaiting_selection")).toBe(true);
  expect(shouldShowConversationConceptSet("selected")).toBe(false);
  expect(shouldShowConversationConceptSet("superseded")).toBe(false);
});
