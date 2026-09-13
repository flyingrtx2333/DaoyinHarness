# DaoyinHarness 记忆系统补全开发清单

> 状态：规划草案
> 适用范围：DaoyinHarness 本地运行时、云端运行时、主平台统一 Agent 记忆能力
> 目标：在保留现有 provenance / revision / ACL / share / invalidation 安全骨架的前提下，补齐 Episodic Retrieval、Hybrid Recall、Consolidation、Evaluation 与管理闭环。

---

## 0. 当前基线与总体判断

当前系统已经具备以下可靠性基础，后续开发应当复用而不是推翻：

- [x] 云端长期记忆 PostgreSQL 持久化：`durable_memories`。
- [x] 本地长期记忆 JSONL 持久化：`memory/memories.jsonl`。
- [x] `memory_search / memory_remember / memory_update / memory_forget` 四个 Agent 工具。
- [x] 记忆 `key / kind / scope / revision / state / expiresAt / source` 基本模型。
- [x] `active / superseded / forgotten / rejected` 状态语义。
- [x] 用户、组织、应用、跨应用 share 范围校验。
- [x] `memory_references` 记录每个 Run/Step 暴露过的具体记忆版本。
- [x] `memory_audit`、`memory_shares` 基础审计能力。
- [x] 记忆来源必须绑定真实 `turn.started` 用户原文或已完成业务 `tool.completed` 证据。
- [x] 记忆版本变化、撤销、过期后可阻止 stale memory 继续驱动当前模型。
- [x] 被失效记忆影响的历史 Turn 可以从后续模型上下文中隔离。
- [x] Memory 写入后刷新 Snapshot，同批未执行 Tool 不继续沿用旧上下文。
- [x] 自动召回与显式 `memory_search` 都受权限、版本、share、过期条件约束。

当前主要短板：

1. **召回质量不足**：自动召回仍以 lexical token/phrase/keyword 为主，没有 embedding / vector / rerank。
2. **缺少 Episodic Memory**：不能像 Session Query 一样可靠搜索“过去具体聊过什么、做过什么”。
3. **缺少 Memory Consolidation**：不同 key 间的语义重复、冲突、合并、衰减尚未系统处理。
4. **缺少生命周期评分**：importance / confidence / useCount / lastUsedAt 等不足。
5. **缺少 Query Rewrite**：仅对“继续/接着”等极少数短句做简单回溯。
6. **缺少完整效果评估**：当前没有可用于发布门槛的真实模型 Recall@K、误召回率、跨会话恢复率等指标。
7. **平台管理闭环不完整**：用户查看、编辑、冲突处理、跨应用授权、组织级治理 UI 仍需补齐。

目标架构：

```text
Memory System
├── Governance / Safety
│   ├── provenance
│   ├── revision
│   ├── ACL / scope
│   ├── share / revoke
│   ├── invalidation
│   └── audit
│
├── Episodic Memory
│   ├── session_search
│   ├── session_read
│   └── session_trace
│
├── Semantic Memory
│   ├── durable_memories
│   ├── lexical retrieval
│   ├── vector retrieval
│   └── rerank
│
├── Consolidation
│   ├── semantic dedup
│   ├── conflict detection
│   ├── merge / supersede
│   ├── decay
│   └── importance
│
└── Evaluation / Operations
    ├── recall metrics
    ├── stale-memory leakage
    ├── latency / cost
    ├── observability
    └── user management UI
```

---

# P0：必须优先补齐

## P0-1. 抽象可替换的 Memory Retrieval Provider

### 目标

把当前检索算法从 Repository 中拆出来，避免未来 lexical / pgvector / reranker 继续堆在 `postgres-memory-repository.ts`。

### 开发项

- [ ] 新增统一检索接口，例如：

```ts
export interface MemoryRetriever {
  recall(input: {
    identity: ExecutionIdentity;
    query: string;
    limit: number;
    includeDefaults: boolean;
  }): Promise<MemoryRecallCandidate[]>;
}
```

- [ ] Repository 继续负责：
  - namespace / owner / app / share / expiry / state 过滤；
  - revision / reference 验证；
  - transaction；
  - provenance；
  - audit。
- [ ] Retriever 只负责“候选记录中的相关性”。
- [ ] 现有 lexical 算法实现成 `LexicalMemoryRetriever`。
- [ ] 云端通过配置选择 Retriever，不让 Agent Core 感知 pgvector / embedding。
- [ ] 本地实现保持可运行，可先继续 lexical。

### 建议文件

- `packages/server-cloud/src/memory-retrieval.ts`
- `packages/server-cloud/src/memory-retrieval-lexical.ts`
- `packages/server-cloud/src/memory-retrieval-hybrid.ts`

### 验收

- [ ] 不改变现有 ACL / revision / share 语义。
- [ ] 切回 lexical provider 时行为与当前生产兼容。
- [ ] Retriever 不能直接获得其他 namespace 的候选数据。

---

## P0-2. Hybrid Recall：Lexical + Embedding

### 目标

解决“词不一样但语义高度相关”的召回失败。

### 开发项

- [ ] 为 `durable_memories` 增加 embedding 版本信息。
- [ ] PostgreSQL 启用 `pgvector` 或等价向量能力。
- [ ] 设计 embedding 字段：
  - `embedding`
  - `embedding_model`
  - `embedding_version`
  - `embedded_at`
- [ ] embedding 内容由以下字段组成：

```text
key + content + keywords + kind
```

- [ ] 新写入/更新 Memory 时同步生成 embedding，失败时：
  - 记忆写入不得回滚为“完全失败”，除非该发布阶段明确把 vector 设为强依赖；
  - 标记 `embedding_pending` 或兼容状态；
  - lexical recall 仍可用。
- [ ] 历史 Memory 做一次显式迁移/回填，不在普通服务启动时偷偷全量生成。
- [ ] 检索同时生成：
  - Lexical candidates；
  - Vector candidates。
- [ ] 合并候选去重。
- [ ] 引入融合策略，优先简单可解释方案：RRF 或 normalized weighted score。
- [ ] 不允许全局向量召回后再做权限过滤；必须先限定可访问 namespace，或在 SQL 中同时施加 owner/app/share/state 过滤。

### 初始建议

```text
lexical topK = 12
vector topK  = 12
merge        = <= 20
rerank       = top 6
```

具体参数必须通过真实样本评估后调整，不硬编码为“永远正确”。

### 验收案例

- [ ] Memory：“用户偏好精炼的技术回答”；Query：“以后别展开这么多”能召回。
- [ ] Memory：“禁止子 Agent 递归委派”；Query：“子 agent 能不能再分 agent？”能召回。
- [ ] 不相关但 embedding 相近的记录不会大量污染 Top 6。
- [ ] 过期、forgotten、无 share 的 Memory 即使向量最相似也绝不能召回。

---

## P0-3. Query Rewrite / Retrieval Query Builder

### 目标

自动召回不再只拿原始 `userMessage` 直接搜索。

### 开发项

- [ ] 新增 `MemoryQueryBuilder`。
- [ ] 输入至少包含：
  - 当前用户消息；
  - 最近 1~3 个用户 Turn；
  - 当前 Goal title / objective（若存在）；
  - 当前 App/Profile；
  - 当前 Step。
- [ ] 第一版优先使用确定性规则，不为每个 Step 新增额外 LLM 调用。
- [ ] 支持：
  - “继续 / 接着 / 那个 / 第二个 / 按之前方案”等指代；
  - 当前消息过短时补充最近明确主题；
  - 当前 Goal 关键词增强。
- [ ] 对复杂歧义允许 Agent 自主调用 `memory_search`，而不是强行猜。
- [ ] 预留可选模型 rewrite seam，仅在低置信度场景开启。

### 输出建议

```ts
{
  rawQuery: string;
  retrievalQuery: string;
  terms: string[];
  reasons: string[];
  confidence: "high" | "medium" | "low";
}
```

### 验收

- [ ] “继续”能回到上一明确主题。
- [ ] “第二个方案呢”能利用最近 Turn，而不是搜索“第二个方案”字面。
- [ ] 不修改真正发送给模型的用户原文。

---

## P0-4. Episodic Memory：Session Query

### 目标

补齐“记忆事实”和“过去实际发生过什么”的区别。

### 新能力

建议提供：

```text
session_search
session_read
session_trace
```

#### `session_search`

搜索历史用户消息、Assistant 最终文本、Tool 名称/摘要及可安全索引的证据摘要。

#### `session_read`

按 `sessionId + turn/run range` 获取一个受控历史片段。

#### `session_trace`

用于需要审计时查看某一历史 Run 的 Tool/状态时间线，不默认把巨大原始 payload 全部回灌模型。

### 开发项

- [ ] 云端 PostgreSQL 为 Session/Event 建立可检索索引。
- [ ] 优先考虑 PostgreSQL FTS / trigram；是否为 Session Search 引入向量检索可作为后续增量。
- [ ] 本地可使用 SQLite FTS 索引 transcript projection。
- [ ] Session Query 必须与长期 Memory 分开：

```text
Episodic = “2026-09-02 我们具体讨论了什么？”
Semantic = “长期结论是禁止递归子 Agent。”
```

- [ ] 对检索结果保留 `sessionId / turnId / eventSeq range`。
- [ ] 历史 Tool 原始输出默认不整块注入，只给摘要/预览，需要时再 trace/read。
- [ ] 不能搜索别的账号、企业或无权访问的历史 Session。

### 验收案例

- [ ] 用户问“我们之前讨论 Progress Detection 时怎么定的？”即使当时没有写入长期 Memory，也能通过 Session Search 找到。
- [ ] 搜索结果可回溯到真实历史 Event 范围。
- [ ] 被删除/不可访问 Session 不会通过索引泄露。

---

## P0-5. 自动召回与 Episodic Search 的协同策略

### 目标

避免每轮既搜长期 Memory 又扫历史 Session，造成噪声与延迟。

### 建议策略

- [ ] 默认每 Step：只做 Semantic Memory 自动 Recall。
- [ ] 以下情况才考虑 Episodic Search：
  - 用户明确说“之前 / 上次 / 某次 / 当时”；
  - 当前问题引用一个未出现在现有 Memory 的历史决策；
  - Agent 主动判断需要原始历史证据。
- [ ] Episodic Search 做成 Tool 或受控 runtime capability，不默认每 Step 常驻执行。
- [ ] 长期 Memory 命中时优先引用 Memory；需要证据时可再追溯其 source Session/Event。

---

## P0-6. Memory Retrieval 真实模型评估集

### 目标

建立发布前可重复的小样本真实模型验收，不用 mock。

### 必测场景

- [ ] 直接关键词命中。
- [ ] 同义改写命中。
- [ ] 中文长短表达差异。
- [ ] “继续/之前方案”指代。
- [ ] 不相关 Memory 不应出现。
- [ ] expired Memory 不召回。
- [ ] forgotten Memory 不召回。
- [ ] superseded 老 revision 不召回。
- [ ] revoked share 不召回。
- [ ] 不同账号隔离。
- [ ] 不同组织隔离。
- [ ] 跨 App 合法 share 正常召回。
- [ ] Session Search 能找到未固化为 Memory 的旧讨论。

### 初始指标

小样本先记录，不把少量样本包装成总体成功率：

- Recall@K
- Precision@K
- stale-memory leakage = 0
- cross-tenant leakage = 0
- wrong-revision leakage = 0
- retrieval latency p50/p95
- memory context chars
- 每 Run 自动召回次数
- Vector/Embedding 额外成本

---

# P1：记忆质量与长期演化

## P1-1. Semantic Dedup

### 问题

不同 key 可能表达同一事实：

```text
response.short = 喜欢简洁回答
profile.answer.preference = 不喜欢长篇展开
```

当前稳定 key 只能解决“同 key 更新”，不能解决“不同 key 同义”。

### 开发项

- [ ] 新 Memory 写入前进行候选近邻搜索。
- [ ] 相似度高且不冲突：提示 Agent 应 update/merge，而不是新建。
- [ ] 不允许仅凭 embedding 自动覆盖旧事实。
- [ ] 记录 dedup decision / candidate IDs。
- [ ] 管理 UI 可以查看相似 Memory。

---

## P1-2. Conflict Detection

### 目标

识别：

```text
用户偏好简洁
vs
用户偏好详细解释
```

### 开发项

- [ ] 同 stable key：继续使用 revision/supersede。
- [ ] 不同 key：建立语义冲突检测。
- [ ] 冲突状态不要自动二选一，按来源强度与时序处理。
- [ ] 明确用户当前更正 > 旧 Agent 推断。
- [ ] 对无法安全裁决的冲突标记 `needs_review` 或等价状态。
- [ ] 不允许后台自动把两个冲突事实都继续暴露给模型而无标记。

---

## P1-3. Memory Consolidation Pipeline

### 目标

让长期记忆不会随着使用时间无限堆积。

### 建议状态机

```text
new memory
  ↓
find similar
  ↓
├─ duplicate → merge / ignore
├─ correction → supersede
├─ conflict → mark conflict / review
├─ temporary → TTL
└─ new durable fact → active
```

### 开发项

- [ ] 设计 `MemoryConsolidator` 接口。
- [ ] Consolidation 不放进 Agent 主循环的关键路径。
- [ ] 可由受控定时任务/维护任务执行，但必须：
  - 有明确审计；
  - 不删除原始来源；
  - 不越权读取；
  - 不使用大模型自动覆写用户事实而无 revision 记录。
- [ ] 同一 Memory root 链保留版本历史。

---

## P1-4. Importance / Confidence / Usage Signals

### 建议新增字段

- [ ] `importance`
- [ ] `confidence`
- [ ] `last_recalled_at`
- [ ] `recall_count`
- [ ] `last_used_at`（只有能证明实际使用时再记录）
- [ ] `use_count`
- [ ] `last_confirmed_at`

### 原则

- `recall_count` ≠ `use_count`。
- Agent 推断来源的 confidence 默认不能等同于用户明确确认。
- 高频召回不代表事实更正确。

---

## P1-5. Decay / Expiry Policy

### 目标

让临时、低价值 Memory 自动降低召回优先级。

### 开发项

- [ ] TTL 继续作为硬过期。
- [ ] 增加软 decay，用于 ranking，不直接物理删除。
- [ ] 长期稳定偏好、明确决策可以低 decay。
- [ ] 临时环境事实、短期上下文高 decay。
- [ ] decay 参数与 `kind` 绑定，不能由模型随意设置极高持久性。

---

## P1-6. Memory Type 体系收敛

### 目标

避免 `kind/key/scope` 被 Agent 自由发挥成不可维护的命名集合。

### 开发项

- [ ] 明确 Memory taxonomy：
  - preference
  - durable_fact
  - long_term_goal
  - decision
  - validated_experience
  - organization_policy
- [ ] 明确禁止进入 Memory：
  - 当前 Run 进度
  - TODO
  - 临时计划
  - 一次性 Tool 结果
  - secrets / credentials
  - 大段原文
  - 未验证的人格/隐私推断
- [ ] key namespace 文档化。
- [ ] 对常用 key 提供 canonical registry。

---

## P1-7. Memory 写入语义质量控制

### 当前问题

来源验证只能证明“原文确实存在”，不能证明 Agent 总结正确。

### 开发项

- [ ] `memory_remember` 增加 lightweight consistency check。
- [ ] 用户陈述型 Memory：summary 不得超出 source excerpt 含义。
- [ ] Tool observation：只允许从可验证业务结果提炼，不保存推测。
- [ ] 对高风险组织事实/身份事实采用更严格确认或管理接口。
- [ ] 将“Agent 自主保存”在 UI 中明确区别于“用户明确确认”。

---

# P2：平台产品化与高级能力

## P2-1. 用户 Memory 管理 UI

- [ ] 查看 Memory 列表。
- [ ] 搜索。
- [ ] 查看来源 Session/Turn/Event。
- [ ] 查看 revision 链。
- [ ] 更正。
- [ ] forget。
- [ ] 查看跨 App share。
- [ ] 撤销 share。
- [ ] 查看 audit。
- [ ] 查看“最近在哪些 Run 被召回”。
- [ ] 冲突 Memory 管理。

---

## P2-2. 组织 / 企业 Memory 管理

- [ ] Organization Memory 独立视图。
- [ ] 企业管理员权限。
- [ ] 部门级 ACL。
- [ ] 资源/项目级 ACL。
- [ ] organization policy 与个人 preference 严格区分。
- [ ] 企业事实发布/撤销流程。
- [ ] 跨部门共享策略。

---

## P2-3. 跨 App Memory 策略统一

- [ ] 明确 `personal / application / organization` 三种 scope 的产品语义。
- [ ] 主平台统一签发 Memory capability。
- [ ] 淘汰重复的逐插件人工授权流程，同时保留真正的账号/组织边界。
- [ ] 兼容旧 `memory_shares` 数据迁移。
- [ ] App 卸载后 share 失效策略。
- [ ] App 重装后的 installation identity 策略。

---

## P2-4. Memory Observability

每个 Run Diagnostics 建议至少提供：

- [ ] autoRecall candidate count
- [ ] returned count
- [ ] lexical candidate count
- [ ] vector candidate count
- [ ] rerank count
- [ ] excluded invalid references
- [ ] excluded historical turns
- [ ] retrieval latency
- [ ] embedding latency
- [ ] explicit memory_search count
- [ ] memory mutation count
- [ ] memory refresh count

注意：不要在普通日志中输出 Memory 正文、隐私内容或 secrets。

---

## P2-5. Memory Provider Plugin Seam

### 目标

学习 DSH 的可替换设计，但保留道引统一治理层。

```text
Daoyin Memory Governance
          │
          ▼
Memory Retrieval Interface
    ├── Local Lexical
    ├── Postgres Hybrid
    ├── Enterprise Search
    └── Optional external provider
```

### 原则

- 外部 Provider 不能绕开：
  - ExecutionIdentity
  - ACL
  - revision
  - provenance
  - audit
  - revoke
- Provider 返回的是候选，不是最终授权结果。

---

# 数据库与迁移清单

## PostgreSQL

### 建议新增/调整

- [ ] `durable_memories.embedding`
- [ ] `durable_memories.embedding_model`
- [ ] `durable_memories.embedding_version`
- [ ] `durable_memories.embedded_at`
- [ ] importance/confidence/usage 字段或独立统计表。
- [ ] pgvector extension / index。
- [ ] Session FTS / trigram 索引或独立 projection 表。
- [ ] conflict / consolidation audit 表（若不复用 `memory_audit`）。

### 迁移要求

- [ ] additive migration。
- [ ] 不重写现有 revision 链。
- [ ] 不修改原 Event。
- [ ] embedding 回填是显式 operator job。
- [ ] 回填可暂停/续跑。
- [ ] 向量索引构建失败不能损坏 lexical recall。
- [ ] 提供迁移前后计数与校验报告。

---

# Agent / Prompt 行为清单

- [ ] 自动 Recall 仍由 Runtime 执行，不要求 Agent 每 Step 先手动 `memory_search`。
- [ ] `memory_search` 用于自动 Recall 不足、历史决策、复杂指代。
- [ ] Memory 永远标记为 reference data，不是 System Instruction。
- [ ] 当前用户明确更正优先于旧 Memory。
- [ ] 不因为召回 Memory 就自动写回新 Memory。
- [ ] 没有长期价值时不调用 `memory_remember`。
- [ ] 写 Memory 后刷新 Snapshot。
- [ ] 未执行的旧批次 Tool 参数在 Memory 刷新后不得继续执行。
- [ ] 成功的业务写 Tool 不因 Memory 刷新而重复。
- [ ] Session Search 返回的历史网页/Tool 内容仍视为不可信数据。

---

# 安全清单

- [ ] Vector Search 不能跨 namespace 泄露候选。
- [ ] embedding 服务请求不得包含不必要的身份字段、secret 或完整事件历史。
- [ ] 外部 embedding Provider 的数据处理策略需单独审核。
- [ ] forgotten / expired / superseded / revoked memory 必须在 lexical 和 vector 两条路径同时失效。
- [ ] vector index stale 时仍以 PostgreSQL 权威状态为最终判断。
- [ ] `MemoryReference(id, revision, grantId)` 保持最终引用凭据。
- [ ] 模型调用前、流式输出期间、模型完成后继续 `assertCurrent()`。
- [ ] Session Search 结果同样执行 account / scope / org 隔离。
- [ ] Memory 管理 UI 不暴露内部 service token。
- [ ] secrets 检查从正则逐步升级为更稳健的数据分类/泄漏保护，但不能把正则误称为完整 DLP。

---

# 测试与验收清单

根据项目当前规则，行为验收只做少量真实模型真实路径，不新增模拟模型回归套件。

## 静态检查

- [ ] TypeScript typecheck。
- [ ] 受影响文件 lint。
- [ ] SQL migration dry inspection。
- [ ] `git diff --check`。

## 小样本真实模型

每批 3~5 个核心场景，保留失败证据：

### Recall

- [ ] lexical exact hit。
- [ ] vector semantic hit。
- [ ] hybrid rerank。
- [ ] short follow-up query rewrite。
- [ ] irrelevant memory rejection。

### Governance

- [ ] forgotten leakage = 0。
- [ ] superseded old revision leakage = 0。
- [ ] revoked share leakage = 0。
- [ ] cross-account leakage = 0。
- [ ] cross-org leakage = 0。

### Episodic

- [ ] 能搜到过去 Session 中未进入长期 Memory 的具体讨论。
- [ ] 能追踪真实 Event 证据范围。
- [ ] Session Search 不自动执行旧 Tool。

### Consolidation

- [ ] 同义 Memory 提示合并。
- [ ] 明确更正正确 supersede。
- [ ] 冲突 Memory 不静默覆盖。

---

# 评估指标建议

不能只看“Memory 有没有被返回”。至少分四阶段：

```text
Retrieved
   ↓
Exposed to model
   ↓
Actually used
   ↓
Helpful / correct
```

建议记录：

- Recall@K
- Precision@K
- MRR / first relevant rank
- stale-memory leakage
- wrong-revision leakage
- cross-scope leakage
- episodic retrieval success
- semantic-memory recovery success
- query rewrite success
- false recall rate
- conflict detection accuracy
- dedup precision
- retrieval p50/p95 latency
- embedding cost
- model context inflation

真实模型小样本不能外推成总体成功率；报告必须记录 revision、模型、输入、召回候选、实际上下文、最终回答和失败阶段。

---

# 推荐实施顺序

## Phase A：Retrieval 基础重构

1. [ ] 抽 `MemoryRetriever` interface。
2. [ ] 把现有 lexical 算法迁入 provider。
3. [ ] 保持生产行为不变完成一次真实模型烟雾验收。

## Phase B：Episodic Memory

4. [ ] `session_search`。
5. [ ] `session_read`。
6. [ ] `session_trace`。
7. [ ] 建立 Session FTS index。
8. [ ] 小样本“之前讨论过什么”真实模型验收。

## Phase C：Hybrid Recall

9. [ ] pgvector/schema。
10. [ ] embedding service adapter。
11. [ ] backfill job。
12. [ ] Lexical + Vector fusion。
13. [ ] Top K rerank。
14. [ ] 真实 recall 对比。

## Phase D：Query Rewrite

15. [ ] deterministic query builder。
16. [ ] Goal + recent-turn enrichment。
17. [ ] complex ambiguity fallback to explicit `memory_search`。

## Phase E：Consolidation

18. [ ] semantic duplicate candidates。
19. [ ] conflict model/state。
20. [ ] merge/supersede workflow。
21. [ ] importance/confidence/usage signals。
22. [ ] decay。

## Phase F：产品化

23. [ ] 用户 Memory 管理 UI。
24. [ ] revision/provenance UI。
25. [ ] share/audit UI。
26. [ ] organization 管理。
27. [ ] 部门/资源 ACL。
28. [ ] observability dashboard。
29. [ ] Evaluation Workbench Memory metrics。

---

# Definition of Done

记忆系统不能因为“加了向量召回”就算完成。最终至少满足：

- [ ] 能回答“我长期偏好/决策是什么”。
- [ ] 能回答“我们以前具体什么时候讨论过什么”。
- [ ] 同义表达能召回。
- [ ] 不相关 Memory 不大量污染上下文。
- [ ] 更正后的旧版本不会回来。
- [ ] forgotten Memory 不会通过 Memory、旧历史、旧摘要或跨 App share 重新进入模型上下文。
- [ ] 每条进入上下文的长期 Memory 都能追溯 id/revision/source。
- [ ] 不同账号、组织、应用权限边界真实有效。
- [ ] 长期运行后不会因为 Memory 无限制堆积而明显降低 Recall 精度。
- [ ] 用户有能力查看、更正、忘记和审计自己的 Memory。
- [ ] 行为效果通过小样本真实模型验证，失败样本不隐藏。

---

## 最终优先级摘要

```text
P0
├── Retrieval Provider 抽象
├── Hybrid Recall
├── Query Rewrite
├── Episodic Session Search
└── 真实模型 Memory Evaluation

P1
├── Semantic Dedup
├── Conflict Detection
├── Consolidation
├── Importance / Confidence
├── Usage Signals
└── Decay / Lifecycle

P2
├── 用户管理 UI
├── Organization / Department ACL
├── 跨 App 产品化
├── Observability
└── External Memory Provider seam
```

当前最优路线不是推翻已有 Memory，而是：**保留治理层，补 Retrieval，补 Episodic Memory，再补 Consolidation。**
