import { createHash } from "node:crypto";
import type { ToolDescriptor } from "@daoyin/harness-tools/registry";

/** 能力包风险等级：只读查询、普通写入、高危/付费/破坏性操作 */
export type CapabilityRisk = "read" | "write" | "high";

/**
 * 能力包元数据清单 (Capability Pack Manifest)
 */
export interface CapabilityPackManifest {
  /** 能力包唯一标识符 */
  id: string;
  /** 版本号 */
  version: string;
  /** 显示标题 */
  title: string;
  /** 功能概述 */
  summary: string;
  /** 适用的意图关键词/标签 */
  intents: readonly string[];
  /** 典型触发正例输入 */
  examples: readonly string[];
  /** 负向/不应触发的反例输入 */
  negativeExamples: readonly string[];
  /** 该能力包所打包暴露的工具名称列表 */
  toolNames: readonly string[];
  /** 强依赖的前置能力包 ID 列表（自动并入选择） */
  dependencies: readonly string[];
  /** 关联的操作资源类型 */
  resourceKinds: readonly string[];
  /** 激活该能力包所必须具备的上下文环境标识 */
  requiredContext: readonly string[];
  /** 风险等级 */
  risk: CapabilityRisk;
}

/** 语义意图分类结果项 */
export interface CapabilitySemanticIntent {
  label: string; objective: string; confidence: number; packIds: readonly string[];
}

/** 语义分析服务打分结果 */
export interface CapabilitySemanticResult {
  rerankScores: Readonly<Record<string, number>>; intents: readonly CapabilitySemanticIntent[];
}

/** 语义向量检索与意图分析提供方接口 */
export interface CapabilitySemanticProvider {
  retrieve?(input: { query: string; clauses: readonly string[]; candidates: readonly CapabilityPackManifest[];
    signal: AbortSignal }): Promise<Readonly<Record<string, number>>>;
  analyze(input: { query: string; clauses: readonly string[]; candidates: readonly CapabilityPackManifest[];
    signal: AbortSignal }): Promise<CapabilitySemanticResult>;
}

/**
 * 动态能力路由决策回执
 */
export interface CapabilityRouteDecision {
  /** 路由算法版本标识 */
  algorithmVersion: "hybrid-v1";
  /** 当前全量能力包目录的 SHA256 摘要 */
  catalogDigest: string;
  /** 符合上下文与风险准入的候选包数量 */
  eligiblePackCount: number;
  /** 最终命中的能力包 ID 列表 */
  selectedPackIds: string[];
  /** 暴露给大模型的动态工具总数（上限 48） */
  exposedToolCount: number;
  /** 注入 Prompt 的 Tool Schema 字符总数（上限 48,000） */
  schemaCharacters: number;
  /** 识别出的用户意图标签与置信度 */
  intents: Array<{ label: string; confidence: number; packIds: string[] }>;
  /** 降级机制说明：none 无降级、lexical 纯倒排词法匹配、safe-readonly 保守只读兜底 */
  fallback: "none" | "lexical" | "safe-readonly";
  /** 因未显式授权而被阻断的高危包 ID 列表 */
  blockedHighRiskPackIds: string[];
  /** 各阶段路由耗时毫秒数 */
  latencyMs: { eligibility: number; retrieval: number; rerank: number; classify: number };
}

/**
 * 能力路由最终返回结果
 */
export interface CapabilityRouteResult {
  /** 路由决策详情 */
  decision: CapabilityRouteDecision;
  /** 路由模型生成的公开操作说明，仅用于用户界面，不写入路由诊断事件 */
  commentary?: string;
  /** 最终选定暴露给 Agent 运行时的工具名称集合 */
  selectedToolNames: ReadonlySet<string>;
  /** 运行态动态按需追加只读能力包 */
  expandReadonly(query: string): { addedPackIds: string[]; selectedToolNames: ReadonlySet<string> };
}

interface RouteInput {
  message: string; continuity?: string; packs: readonly CapabilityPackManifest[]; tools: readonly ToolDescriptor[];
  availableContext?: readonly string[]; explicitHighRiskPackIds?: readonly string[]; pinnedPackIds?: readonly string[];
  semantic?: CapabilitySemanticProvider; signal: AbortSignal;
}
interface Ranked { pack: CapabilityPackManifest; rrf: number; normalized: number; continuity: number }
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u;
const elapsed = (start: number): number => Math.round((performance.now() - start) * 100) / 100;
const list = (value: readonly string[], max: number, length: number): boolean =>
  Array.isArray(value) && value.length <= max &&
  value.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= length);


export function validateCapabilityCatalog(packs: readonly CapabilityPackManifest[], tools: readonly ToolDescriptor[]): void {
  if (packs.length < 1 || packs.length > 256 || tools.length > 2_000) {
    throw new Error("Invalid capability catalog size.");
  }
  const toolNames = new Set(tools.map((tool) => tool.name));
  const packIds = new Set<string>();
  for (const pack of packs) {
    if (!ID.test(pack.id) || !ID.test(pack.version) || packIds.has(pack.id) ||
      !pack.title.trim() || pack.title.length > 100 || !pack.summary.trim() || pack.summary.length > 1_000 ||
      !["read", "write", "high"].includes(pack.risk) ||
      !list(pack.intents, 32, 120) || !list(pack.examples, 32, 300) ||
      !list(pack.negativeExamples, 32, 300) || !list(pack.toolNames, 16, 100) ||
      pack.toolNames.length < 1 || new Set(pack.toolNames).size !== pack.toolNames.length ||
      !pack.toolNames.every((name) => toolNames.has(name)) || !list(pack.dependencies, 16, 100) ||
      !list(pack.resourceKinds, 16, 100) || !list(pack.requiredContext, 16, 100)) {
      throw new Error("Invalid capability pack.");
    }
    packIds.add(pack.id);
  }
  for (const pack of packs) {
    if (!pack.dependencies.every((dependency) => packIds.has(dependency) && dependency !== pack.id)) {
      throw new Error("Invalid capability dependency.");
    }
  }
}
export function splitCapabilityIntents(raw: string): string[] {
  const protectedValues: string[] = [];
  const normalized = raw.normalize("NFKC").toLowerCase().replace(
    /[\u0060]{3}[\s\S]*?[\u0060]{3}|https?:\/\/[^\s]+|["'\u201c\u201d\u300c\u300d][^"'\u201c\u201d\u300c\u300d]{1,500}["'\u201c\u201d\u300c\u300d]/gu,
    (value) => " __protected_" + String(protectedValues.push(value) - 1) + "__ ",
  );
  const pieces = normalized.split(
    /(?:[。！？!?；;\n]+|(?:，|,)?\s*(?:同时|然后|并且|另外|接着|随后|以及|再)\s*)/u,
  ).map((value) => value.trim()).filter(Boolean).slice(0, 12);
  const restored = pieces.map((piece) => piece.replace(
    /__protected_(\d+)__/gu, (_all, index: string) => protectedValues[Number(index)] ?? "")
    .replace(/\s+/gu, " ").trim());
  const clauses: string[] = [];
  for (const piece of restored) {
    if ([...piece].length < 2 && clauses.length) clauses[clauses.length - 1] += " " + piece;
    else clauses.push(piece);
    if (clauses.length === 6) break;
  }
  return clauses.length ? clauses : [normalized.trim()].filter(Boolean);
}
function tokens(value: string): string[] {
  const normalized = value.normalize("NFKC").toLowerCase();
  const ascii = normalized.match(/[a-z0-9][a-z0-9_.-]*/gu) ?? [];
  const han = [...normalized.matchAll(/[\p{Script=Han}]+/gu)].flatMap((match) => {
    const characters = [...match[0]], result = [...characters];
    for (let index = 0; index + 1 < characters.length; index++) {
      result.push(characters[index]! + characters[index + 1]!);
    }
    return result;
  });
  return [...ascii, ...han];
}
function packText(pack: CapabilityPackManifest): string {
  return [pack.title, pack.summary, ...pack.intents, ...pack.examples,
    ...pack.negativeExamples, ...pack.resourceKinds].join("\n");
}
function explicitPackIds(message: string, packs: readonly CapabilityPackManifest[]): Set<string> {
  const normalized = message.normalize("NFKC").toLowerCase();
  const han = new Set([...(normalized.match(/[\p{Script=Han}]/gu) ?? [])]);
  const hanBigrams = new Set((normalized.match(/[\p{Script=Han}]+/gu) ?? []).flatMap((part) => {
    const characters = [...part];
    return characters.slice(0, -1).map((character, index) => character + characters[index + 1]!);
  }));
  return new Set(packs.filter((pack) => [pack.id, pack.title, ...pack.intents, ...pack.examples, ...pack.toolNames]
    .some((value) => {
      const trigger = value.normalize("NFKC").toLowerCase().trim();
      if ([...trigger].length < 4) return false;
      if (normalized.includes(trigger)) return true;
      if (!/^[\p{Script=Han}]+$/u.test(trigger)) return false;
      const characters = [...new Set([...trigger])];
      const bigrams = [...trigger].slice(0, -1).map((character, index) => character + [...trigger][index + 1]!);
      const matchingBigrams = bigrams.filter((value) => hanBigrams.has(value)).length;
      return characters.every((character) => han.has(character)) &&
        matchingBigrams >= Math.max(2, Math.ceil(bigrams.length * 0.6));
    })).map((pack) => pack.id));
}
function bm25(query: string, packs: readonly CapabilityPackManifest[]): CapabilityPackManifest[] {
  const documents = packs.map((pack) => tokens(packText(pack)));
  const queryTokens = [...new Set(tokens(query))];
  const average = documents.reduce((sum, document) => sum + document.length, 0) / Math.max(1, documents.length);
  return packs.map((pack, index) => {
    const document = documents[index]!, counts = new Map<string, number>();
    for (const token of document) counts.set(token, (counts.get(token) ?? 0) + 1);
    let score = 0;
    for (const token of queryTokens) {
      const frequency = counts.get(token) ?? 0;
      if (!frequency) continue;
      const present = documents.reduce((sum, candidate) => sum + (candidate.includes(token) ? 1 : 0), 0);
      const inverse = Math.log(1 + (documents.length - present + 0.5) / (present + 0.5));
      score += inverse * (frequency * 2.2) /
        (frequency + 1.2 * (0.25 + 0.75 * document.length / Math.max(1, average)));
    }
    return { pack, score };
  }).filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.pack.id.localeCompare(right.pack.id))
    .slice(0, 24).map((item) => item.pack);
}
function rank(query: string, clauses: readonly string[], packs: readonly CapabilityPackManifest[],
  continuity: string, vectorScores: Readonly<Record<string, number>> = {}): Ranked[] {
  const fused = new Map<string, number>();
  for (const text of [query, ...clauses]) {
    bm25(text, packs).forEach((pack, index) =>
      fused.set(pack.id, (fused.get(pack.id) ?? 0) + 1 / (60 + index + 1)));
  }
  Object.entries(vectorScores).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 24).forEach(([packId], index) =>
      fused.set(packId, (fused.get(packId) ?? 0) + 1 / (60 + index + 1)));
  const maximum = Math.max(...fused.values(), 0), contextTokens = new Set(tokens(continuity));
  return packs.map((pack) => {
    const rrf = fused.get(pack.id) ?? 0;
    const overlap = tokens(packText(pack)).filter((token) => contextTokens.has(token)).length;
    return { pack, rrf, normalized: maximum ? rrf / maximum : 0, continuity: Math.min(1, overlap / 5) };
  }).filter((item) => item.rrf > 0)
    .sort((left, right) => right.rrf - left.rrf || left.pack.id.localeCompare(right.pack.id)).slice(0, 40);
}
function descriptorSize(tool: ToolDescriptor): number {
  return JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }).length;
}
function digest(packs: readonly CapabilityPackManifest[]): string {
  return createHash("sha256").update(JSON.stringify(
    packs.map((pack) => [pack.id, pack.version, pack.toolNames]))).digest("hex");
}
function bound(candidates: readonly { pack: CapabilityPackManifest; score: number }[],
  tools: readonly ToolDescriptor[], pinned: ReadonlySet<string>): CapabilityPackManifest[] {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const size = (pack: CapabilityPackManifest): number =>
    pack.toolNames.reduce((sum, name) => sum + descriptorSize(byName.get(name)!), 0);
  const ordered = [...candidates].sort((left, right) => {
    const leftPinned = pinned.has(left.pack.id) ? 1 : 0, rightPinned = pinned.has(right.pack.id) ? 1 : 0;
    return rightPinned - leftPinned ||
      right.score / (1 + size(right.pack) / 8_000) - left.score / (1 + size(left.pack) / 8_000) ||
      left.pack.id.localeCompare(right.pack.id);
  });
  const selected: CapabilityPackManifest[] = [];
  let toolCount = 0, schemaCharacters = 0;
  for (const item of ordered) {
    const additions = item.pack.toolNames.filter((name) =>
      byName.has(name) && !selected.some((pack) => pack.toolNames.includes(name)));
    const characters = additions.reduce((sum, name) => sum + descriptorSize(byName.get(name)!), 0);
    if (selected.length >= 6 || toolCount + additions.length > 48 || schemaCharacters + characters > 48_000) continue;
    selected.push(item.pack); toolCount += additions.length; schemaCharacters += characters;
  }
  return selected;
}
/**
 * 执行动态能力路由决策（核心算法流程）
 *
 * 步骤：
 * 1. 准入过滤：基于上下文标识 (availableContext) 与高危授权 (explicitHighRiskPackIds) 筛选合法包；
 * 2. 依赖解析拓扑排序：确保选定包的前置依赖完整闭包；
 * 3. 混合召回：拆分复合意图子句，结合 BM25 词法与向量嵌入进行 RRF（Reciprocal Rank Fusion）倒数融合排序；
 * 4. 语义意图分类与重排：融合置信度打分与会话连续性权重；
 * 5. 安全预算裁剪：严格限制不超过 6 个能力包、48 个工具总数与 48,000 字符 Tool Schema 上限；
 * 6. 保守降级：若全流程未匹配到明确意图，回退至 safe-readonly 安全只读能力包集合。
 *
 * @param input 路由入参（包含用户消息、上下文、能力包列表与工具池）
 * @returns 路由决策详情与最终暴露的工具名集合
 *
 * @example
 * ```json
 * // 路由决策返回结构示例：
 * {
 *   "decision": {
 *     "algorithmVersion": "hybrid-v1",
 *     "catalogDigest": "4f9b8a...",
 *     "eligiblePackCount": 12,
 *     "selectedPackIds": ["workbench_core", "file_operations"],
 *     "exposedToolCount": 8,
 *     "schemaCharacters": 14200,
 *     "intents": [
 *       { "label": "file_inspection", "confidence": 0.89, "packIds": ["file_operations"] }
 *     ],
 *     "fallback": "none",
 *     "blockedHighRiskPackIds": [],
 *     "latencyMs": { "eligibility": 0.4, "retrieval": 1.2, "rerank": 8.5, "classify": 8.5 }
 *   },
 *   "selectedToolNames": ["view_file", "list_dir", "grep_search"]
 * }
 * ```
 */
export async function routeCapabilities(input: RouteInput): Promise<CapabilityRouteResult> {
  if (!input.message.trim() || input.message.length > 16_000) throw new Error("Invalid capability route query.");
  validateCapabilityCatalog(input.packs, input.tools); input.signal.throwIfAborted();
  const eligibilityStarted = performance.now(), availableTools = new Set(input.tools.map((tool) => tool.name));
  const contexts = new Set(input.availableContext ?? []), explicit = new Set(input.explicitHighRiskPackIds ?? []);
  const blockedHighRiskPackIds: string[] = [];
  let eligible = input.packs.filter((pack) => pack.toolNames.some((name) => availableTools.has(name)) &&
    pack.requiredContext.every((item) => contexts.has(item)));
  eligible = eligible.filter((pack) => {
    if (pack.risk !== "high" || explicit.has(pack.id)) return true;
    blockedHighRiskPackIds.push(pack.id); return false;
  });
  let changed = true;
  while (changed) {
    const ids = new Set(eligible.map((pack) => pack.id));
    const next = eligible.filter((pack) => pack.dependencies.every((dependency) => ids.has(dependency)));
    changed = next.length !== eligible.length; eligible = next;
  }
  const eligibilityMs = elapsed(eligibilityStarted), retrievalStarted = performance.now();
  const clauses = splitCapabilityIntents(input.message);
  const semanticSignal = AbortSignal.any([input.signal, AbortSignal.timeout(1_500)]);
  let vectorScores: Readonly<Record<string, number>> = {};
  let fallback: CapabilityRouteDecision["fallback"] = "none";
  const lexicalRanked = rank(input.message, clauses, eligible, (input.continuity ?? "").slice(0, 1_500));
  let semantic: CapabilitySemanticResult | undefined;
  const vectorTask = input.semantic?.retrieve && eligible.length ? input.semantic.retrieve({
    query: input.message, clauses, candidates: eligible, signal: semanticSignal,
  }).then((scores) => {
    const allowed = new Set(eligible.map((pack) => pack.id));
    if (Object.entries(scores).some(([packId, score]) =>
      !allowed.has(packId) || !Number.isFinite(score) || score < -1 || score > 1)) {
      throw new Error("Invalid vector capability result.");
    }
    return scores;
  }).catch(() => { fallback = "lexical" as const; return {}; }) : Promise.resolve({});
  const semanticStarted = performance.now();
  const semanticTask = input.semantic && lexicalRanked.length ? input.semantic.analyze({
    query: input.message, clauses, candidates: lexicalRanked.slice(0, 20).map((item) => item.pack), signal: semanticSignal,
  }).then((value) => {
      const allowed = new Set(lexicalRanked.slice(0, 20).map((item) => item.pack.id));
      if (value.intents.length > 6 || value.intents.some((intent) =>
        !intent.label.trim() || intent.label.length > 120 || !intent.objective.trim() ||
        intent.objective.length > 500 || !Number.isFinite(intent.confidence) || intent.confidence < 0 ||
        intent.confidence > 1 || intent.packIds.some((packId) => !allowed.has(packId))) ||
        Object.entries(value.rerankScores).some(([packId, score]) =>
          !allowed.has(packId) || !Number.isFinite(score) || score < 0 || score > 1)) {
        throw new Error("Invalid semantic capability result.");
      }
      return value;
    }).catch(() => { fallback = "lexical" as const; return undefined; }) : Promise.resolve(undefined);
  [vectorScores, semantic] = await Promise.all([vectorTask, semanticTask]);
  if (!input.semantic && fallback === "none") fallback = "lexical";
  const ranked = rank(input.message, clauses, eligible,
    (input.continuity ?? "").slice(0, 1_500), vectorScores);
  const retrievalMs = elapsed(retrievalStarted);
  const semanticMs = elapsed(semanticStarted), confidence = new Map<string, number>();
  for (const intent of semantic?.intents ?? []) {
    if (intent.confidence < 0.55) continue;
    for (const packId of intent.packIds) {
      confidence.set(packId, Math.max(confidence.get(packId) ?? 0, intent.confidence));
    }
  }
  const pinned = new Set([...(input.pinnedPackIds ?? []), ...explicitPackIds(input.message, eligible)]);
  let scored = ranked.map((item) => {
    const rerank = semantic === undefined ? item.normalized : (semantic.rerankScores[item.pack.id] ?? 0);
    const classifier = confidence.get(item.pack.id) ?? 0;
    const score = semantic ?
      0.45 * rerank + 0.25 * classifier + 0.15 * item.normalized + 0.10 + 0.05 * item.continuity :
      0.70 * item.normalized + 0.20 + 0.10 * item.continuity;
    return { pack: item.pack, score };
  }).filter((item) => pinned.has(item.pack.id) || item.score >= 0.58 ||
    ((confidence.get(item.pack.id) ?? 0) >= 0.65 && item.score >= 0.50));
  if (!scored.length) {
    fallback = "safe-readonly";
    scored = ranked.filter((item) => item.pack.risk === "read" && item.normalized >= 0.42)
      .slice(0, 3).map((item) => ({ pack: item.pack, score: item.normalized }));
  }
  const byId = new Map(eligible.map((pack) => [pack.id, pack]));
  for (const packId of pinned) {
    const pack = byId.get(packId);
    if (pack && !scored.some((item) => item.pack.id === packId)) scored.push({ pack, score: 2 });
  }
  for (const item of [...scored]) for (const dependency of item.pack.dependencies) {
    const pack = byId.get(dependency);
    if (pack && !scored.some((candidate) => candidate.pack.id === dependency)) {
      scored.push({ pack, score: item.score });
    }
  }
  const selected = bound(scored, input.tools, pinned), selectedPackIds = new Set(selected.map((pack) => pack.id));
  const names = new Set(selected.flatMap((pack) => [...pack.toolNames])
    .filter((name) => input.tools.some((tool) => tool.name === name)));
  const byName = new Map(input.tools.map((tool) => [tool.name, tool]));
  const decision: CapabilityRouteDecision = {
    algorithmVersion: "hybrid-v1", catalogDigest: digest(input.packs), eligiblePackCount: eligible.length,
    selectedPackIds: [...selectedPackIds], exposedToolCount: names.size,
    schemaCharacters: [...names].reduce((sum, name) => sum + descriptorSize(byName.get(name)!), 0),
    intents: (semantic?.intents ?? []).filter((intent) => intent.confidence >= 0.55).map((intent) => ({
      label: intent.label, confidence: intent.confidence,
      packIds: intent.packIds.filter((packId) => selectedPackIds.has(packId)),
    })),
    fallback, blockedHighRiskPackIds,
    latencyMs: { eligibility: eligibilityMs, retrieval: retrievalMs, rerank: semanticMs, classify: semanticMs },
  };
  const semanticCommentary = [...new Set((semantic?.intents ?? [])
    .filter((intent) => intent.confidence >= 0.55)
    .map((intent) => intent.objective.trim())
    .filter(Boolean))]
    .slice(0, 3)
    .join("；");
  const lexicalObjectives = clauses.map((clause) => clause.trim()).filter(Boolean).slice(0, 3).join("；");
  const commentary = semanticCommentary || (lexicalObjectives ? `当前目标：${lexicalObjectives}` : "");
  return {
    decision, ...(commentary ? { commentary } : {}), selectedToolNames: names,
    expandReadonly(query: string) {
      const additions = rank(query, splitCapabilityIntents(query),
        eligible.filter((pack) => pack.risk === "read"), "")
        .filter((item) => !selectedPackIds.has(item.pack.id)).slice(0, 2).map((item) => item.pack);
      for (const pack of additions) {
        if (selectedPackIds.size >= 6) break;
        selectedPackIds.add(pack.id);
        for (const name of pack.toolNames) if (names.size < 48 && byName.has(name)) names.add(name);
      }
      decision.selectedPackIds = [...selectedPackIds]; decision.exposedToolCount = names.size;
      decision.schemaCharacters = [...names].reduce((sum, name) => sum + descriptorSize(byName.get(name)!), 0);
      return { addedPackIds: additions.map((pack) => pack.id).filter((id) => selectedPackIds.has(id)),
        selectedToolNames: names };
    },
  };
}
