import type { EvaluationCase } from "./evaluation-client.js";

export interface CaseOptions { template: EvaluationCase["template"]; facts: string }
export interface DraftCase { key: string; id: string; input: string; options: CaseOptions }
export const MAX_EVALUATION_TRIALS = 5;

/** The textarea is the source of truth. Blank lines never count; duplicates remain separate cases. */
export function evaluationDraft(text: string, options: Readonly<Record<string, CaseOptions>>): DraftCase[] {
  const occurrences = new Map<string, number>();
  return text.split(/\r\n|[\n\r\u2028\u2029]/u).map(line => line.trim()).filter(Boolean).map((input, index) => {
    const occurrence = occurrences.get(input) ?? 0;
    occurrences.set(input, occurrence + 1);
    const key = JSON.stringify([input, occurrence]);
    const template = /素材|赛事/u.test(input) ? "saishi-materials" : /记忆|记得|之前|偏好|画幅/u.test(input) ? "memory-current" : "explore";
    return { key, id: `case_${index + 1}`, input, options: options[key] ?? { template, facts: "" } };
  });
}

export function evaluationDraftError(cases: readonly DraftCase[], repetitions: number, maxCalls: number): string {
  if (cases.length > MAX_EVALUATION_TRIALS) return `已输入 ${cases.length} 题，每批最多 ${MAX_EVALUATION_TRIALS} 题。`;
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5) return "每题重复次数应为 1–5。";
  if (cases.length * repetitions > MAX_EVALUATION_TRIALS) return `共 ${cases.length * repetitions} 次执行，超过每批 5 次；请减少题数或重复次数。`;
  if (!Number.isInteger(maxCalls) || maxCalls < 2 || maxCalls > 12) return "单题调用上限应为 2–12。";
  for (const [index, item] of cases.entries()) {
    if (item.input.length > 2000) return `第 ${index + 1} 题超过 2000 字，请缩短输入。`;
    const facts = item.options.facts.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
    if (facts.length > 8 || facts.some(fact => fact.length > 500)) return `第 ${index + 1} 题的核对条件最多 8 条，每条不超过 500 字。`;
  }
  return "";
}

/** Called only after the operator confirms the visible batch and model charges. */
export function approvedEvaluationCases(cases: readonly DraftCase[]): EvaluationCase[] {
  return cases.map(item => ({ id: item.id, input: item.input, template: item.options.template,
    expectedFacts: item.options.facts.split(/\r?\n/u).map(line => line.trim()).filter(Boolean), approved: true }));
}
