---
demand-id: DM-20260606-003
change: ai-native-os
status: developing
---

# Context Engine Spec (Delta — v0.11.0)

本文为 AI Native OS 引入 3 层记忆模型 + recall 策略 + 后台记忆巩固。
已有 v0.10.0 能力 (InjectRules 4 源规则 + context-budget auto-summarise) 作为底层,
本 spec 在其上加显式 L1/L2/L3 分层、结构化记忆条目、异步 Sleeptime Agent、复合评分 recall、token 预算分配。

> **v0.11.0 修订**: 经行业调研 (Letta Sleep-Time Compute / CrewAI Cognitive Memory / ID-RAG) 和博弈论审查,
> 原始"5 round 触发 LLM 压缩 + 关键词 recall"设计已替换为异步 Sleeptime Agent + 复合评分 recall。
> 设计原理详见 `design.md` 和 `docs/philosophy.md`。

---

## 模块核心目的

context-engine 服务于 dev-brain 的四个核心能力:

| 核心能力 | context-engine 如何支撑 |
|---------|----------------------|
| **指令遵循** | L3 长期偏好确保用户编码风格/测试框架/Review 习惯在每次派发时被注入,Agent 不需要"猜测"用户意图 |
| **SDD 驱动** | L2 结构化存储 spec 引用 (`specRef`),Recall 时按 spec 条款精确检索相关上下文,驱动 Agent 严格按 spec 执行 |
| **长程自主规划** | L2 跨 round 传递决策/风险/发现,Recall 在子任务派发前注入历史失败模式,防止上下文丢失 |
| **辩证探索** | L2 保留辩论阶段的 assumptions/risks/decisions,Sleeptime Agent 后台检测矛盾并消解,不丢失关键分歧 |

---

## CAP-CTX-01 (REVISED) 三层记忆模型 — 结构化 + TTL

> **v0.11.0 修订**: L2 从自由文本 summary 改为结构化 Entry (8 种 type + importance + specRef + ttl),
> L3 从扁平 JSON 改为三级目录,TODO: 所有 Entry 增加 TTL 过期策略。

**Given** 引擎处理一次完整需求 (从飞书消息到任务完成)
**When** 任意业务代码需要读写上下文
**Then** 记忆按 3 层组织,各层独立 schema / 独立持久化 / 独立淘汰策略:

| 层 | 用途 | 生命周期 | 持久化 | 容量上限 |
|---|------|---------|--------|---------|
| **L1 工作记忆** | 单次 agent 调用内的临时变量 (token count、当前 step、工具结果栈) | 单次 adapter.send() 内 | 进程内存 Map | 16K tokens |
| **L2 任务记忆** | 单次任务内的跨 round 结构化上下文 (决策/假设/风险/发现/错误/摘要) | 一次 taskId 生命周期 | 进程内存 + checkpoint 序列化 | 80K tokens |
| **L3 长期偏好** | 跨任务的稳定偏好 (prompt 进化结果 / 编码风格 / 历史决策) | 永久 (只通过 evolution-service 写入) | `~/.dev-brain/l3-memory/` 三级目录 | 不限 |

### L1 工作记忆 (增加 Scope 隔离)

**And** L1 不进 prompt,只供 LLM tool 链路读取
**And** 增加 `scope` 参数,三种生命周期:
  - `tool_call` — 工具调用结束自动清除
  - `step` — 当前步结束自动清除
  - `subtask` — 子任务结束自动清除 (包含上面两级)
**And** `snapshot()` 返回不可变副本用于 checkpoint

**Scenario: Scope 隔离防止泄漏**
- GIVEN subtask A 写入 `L1.set("lastError", ..., "step")`
- WHEN subtask A 结束
- THEN L1.clearScope("subtask") 清除该 key
- AND subtask B 无法读到 subtask A 的 L1 数据

### L2 任务记忆 (结构化 Entry + TTL)

**And** L2 存储**结构化 Entry** (非自由文本 summary):

```typescript
interface L2Entry {
  id: string;
  type: 'decision' | 'assumption' | 'risk' | 'finding' | 'action' | 'error' | 'summary';
  content: string;             // ≤ 500 chars 原子事实
  importance: 1..5;            // 1=trivial, 5=critical
  roundNumber: number;
  subtaskId?: string;
  specRef?: string;            // 关联的 spec 条款 (支撑 SDD 驱动)
  conflicts?: string[];        // 与之矛盾的 entry id 列表
  ttl: number | null;          // 过期时间戳 (null = 不过期)
  createdAt: number;
  sourceEvidence?: string[];   // 指向 L1 可信源 (git diff / acceptance 结果, 非 Agent 自述)
}
```

**And** TTL 分级策略 (来源: Letta 社区最佳实践 2025):

| 内容类型 | TTL | 说明 |
|---------|-----|------|
| 决策 (decision) | null (永不过期) | 已做出的决策不可丢失 |
| 风险 (risk) | null | 识别出的风险需持续关注 |
| 假设 (assumption) | 30 天 | 假设会被后续验证或推翻 |
| 发现 (finding) | 30 天 | 被 3+ 次引用则提升为 null |
| 动作 (action) | 14 天 | 已执行的动作快速过时 |
| 错误 (error) | 14 天 | `type:root-cause` 除外 (永不过期) |
| 摘要 (summary) | 90 天 | 定期重建,旧摘要自然淘汰 |

**And** L2 与 context-budget.ts 协作: 超 80K 时触发 Trigger 4 前台兜底 (见 CAP-CTX-02)

**Scenario: 结构化 Entry 支持精确 Recall**
- GIVEN task "重构 trade 模块",R1 产出 decision: "使用 adapter 模式隔离旧接口"
- WHEN L2.addEntry({ type: "decision", content: "使用 adapter 模式隔离旧接口", importance: 5, specRef: "CAP-ADAPTER-01" })
- THEN 后续 Recall 可按 `type=decision` 或 `specRef=CAP-ADAPTER-01` 精确检索
- AND importance=5 确保在 token 预算紧张时优先保留

**Scenario: TTL 自动过期**
- GIVEN L2 有一条 error entry, createdAt = 15 天前, type ≠ "root-cause"
- WHEN TTL Manager 运行
- THEN 该 entry 被清除
- AND 写 `context.l2.expired_total{type="error"}` +1

### L3 长期记忆 (结构化目录)

**And** L3 从扁平 JSON 改为三级目录:

```
~/.dev-brain/l3-memory/
  prompts/           # Evolution Service 产出的 prompt 模板偏好
  preferences/       # 用户编码风格/测试框架/Review 习惯
  decisions/         # 跨任务的重大架构决策
```

**And** 每个 entry 包含:

```typescript
interface L3Entry {
  id: string;
  path: 'prompts' | 'preferences' | 'decisions';
  content: string;
  importance: 1..5;
  ttl: number | null;
  source: 'evolution' | 'manual';  // 写入来源
  evolved_at?: string;             // evolution-service 写入时带
  eval_pass_rate?: number;
  parent_id?: string;
}
```

**And** L3 由 evolution-service 周期产出,manual 写入需 `--force` 标志并打审计

**Scenario: L3 偏好驱动指令遵循**
- GIVEN L3 有 `preferences/testing.json`: `{ "preferred_test_framework": "vitest" }`
- WHEN OpenSpec 生成
- THEN generator prompt 追加 "用户偏好: 测试用 vitest"
- AND 产出的 tasks.md 自动包含 vitest 命令

**实现要点:**
- `src/context/l1-working-memory.ts` — 增加 `scope` 参数和 `clearScope()`
- `src/context/l2-task-memory.ts` — 结构化 Entry + TTL + `expire()` + checkpoint
- `src/context/l3-long-term-memory.ts` — 三级目录读写 + `expire()`
- `src/context/types.ts` — `L2Entry` / `L3Entry` / `L1Scope` 等类型
- `src/context/ttl-manager.ts` — TTL 过期管理 (纯函数,确定性规则,无 LLM 依赖)

---

## CAP-CTX-02 (REVISED) SleeptimeContextAgent — 异步记忆巩固

> **v0.11.0 修订**: 原始 `DeliberateCompressor` 在关键路径上触发 LLM 压缩,
> 阻塞主流程且影响 prompt cache。改为异步 Sleeptime Agent 模式 (来源: Letta Sleep-Time Compute, Apr 2025),
> 支持 5 步认知操作 (来源: CrewAI Cognitive Memory, 2025)。

### 双 Agent 架构

**Given** dev-brain 运行中
**When** 记忆需要维护 (编码/去重/消解/萃取/遗忘/压缩)
**Then** 这些操作不在关键路径上执行,而是由**后台 SleeptimeContextAgent** 异步完成:

| Agent | 角色 | 延迟要求 | 模型 | 操作 |
|-------|------|---------|------|------|
| **前台** (L1/L2 读写) | 任务执行中读写记忆 | 低延迟 (≤ 50ms) | N/A (纯内存) | addEntry / recall / snapshot |
| **后台** (SleeptimeContextAgent) | 空闲时记忆维护 | 无延迟约束 | DeepSeek (复用) | encode / consolidate / extract / forget / compress |

**And** 前台 Agent **不知道**后台正在做什么操作 (信息隔离,博弈论安全)
**And** 后台 Agent 的模型可独立配置,不影响前台延迟

### 5 步认知操作

**And** SleeptimeContextAgent 执行 5 步操作 (来源: CrewAI Cognitive Memory):

| 操作 | 功能 | 实现方式 |
|------|------|---------|
| **ENCODE** | 分析未处理 L2 entries,补全 type/importance/specRef | LLM 调用 (DeepSeek),批量处理 |
| **CONSOLIDATE** | 检测矛盾 entries,标记冲突,低重要性方设 TTL | 确定性规则 + LLM 辅助判断矛盾语义 |
| **EXTRACT** | 从 L2 summary 中萃取原子事实为新 entry | LLM 调用 (DeepSeek),输出结构化 JSON |
| **FORGET** | 清理过期 entries (TTL) | 确定性规则 (TTL Manager) |
| **COMPRESS** | 同主题 15+ entries 合并为 1 条 summary + 保留 top 3 原始 | LLM 调用 (DeepSeek),仅在 token > 50K 时执行 |

**And** 每步失败不阻塞其他步 (异常隔离)

### 触发策略

**And** 4 种触发条件 (替代原始的单条件 "5 round"):

| Trigger | 条件 | 频率 | 执行操作 |
|---------|------|------|---------|
| T1: 会话结束 | `task.complete` 事件 | 低 | ENCODE + CONSOLIDATE + FORGET |
| T2: 定时 | 每 6h cron | 中 | 全部 5 步 |
| T3: 警告线 | L2 token > 50K | 按需 | COMPRESS only |
| T4: 必须压缩 (前台兜底) | L2 token > 80K | 紧急 | 前台取最近 20 + importance top 10,其余丢弃 |

**And** T4 是安全网 — 即使后台 Agent 完全失效,L2 不会撑爆 token 预算
**And** T4 触发写 `context.compress.fallback_total` (应趋近 0)

### 压缩策略

**And** COMPRESS (T2/T3 触发) 的具体逻辑:
  - 按 `type` + `specRef` 分组
  - 同组 15+ entries 时触发合并:
    1. LLM 生成 1 条 summary entry (≤ 1K chars), 含关键决策/分歧/未决
    2. 保留 importance top 3 原始 entries
    3. 其余 12+ entries 设 TTL=7 天 (标记为"已被摘要替代")
  - 写 `context.sleeptime.compress_merged_total` +N

**And** LLM 调用失败时,退到取头尾各 5 round 拼接 (与原始 spec 兜底一致)

**Scenario: 会话结束后异步巩固**
- GIVEN 一次长任务完成 (3 轮辩论 + 4 个子任务)
- WHEN task.complete 触发 T1
- THEN SleeptimeContextAgent 后台运行:
  - ENCODE: 补全 20 条 entry 的 importance
  - CONSOLIDATE: 检测到 2 对矛盾 (assumption A vs finding B),标记 B.conflicts.push(A.id)
  - FORGET: 清除 5 条过期 error entries
- AND 前台不受影响,下次任务直接受益于更干净的 L2

**Scenario: 警告线触发压缩**
- GIVEN L2 token 估算 = 52K (> 50K)
- WHEN T3 触发
- THEN COMPRESS: 同主题 18 条 entries → 1 条 summary + 保留 top 3
- AND L2 token 降至 ~28K

**Scenario: 前台兜底 (最后防线)**
- GIVEN L2 token = 82K,后台 Agent 未响应
- WHEN T4 触发
- THEN 前台同步执行: 取最近 20 条 + importance=5 的所有 entries,其余丢弃
- AND 写 `context.compress.fallback_total` +1

**实现要点:**
- `src/context/sleeptime-agent.ts` — `class SleeptimeContextAgent { run(taskId, trigger): Promise<SleeptimeReport> }`
- 复用 DeepSeek client (v0.10.0),不新增 LLM 依赖
- 操作隔离: 每步 catch 异常,不阻塞其他操作
- metric: `context.sleeptime.runs_total{trigger}` / `context.sleeptime.operations_total{op}` / `context.sleeptime.duration_ms`

---

## CAP-CTX-03 (REVISED) Recall 策略 — 复合评分

> **v0.11.0 修订**: 原始 spec 的"关键词匹配"在不同 LLM 表述下会失效。
> 改为复合评分 (TF-IDF semantic × recency × importance), 来源: CrewAI 2025 + ID-RAG Sep 2025。

### 触发器与检索算法解耦

**Given** 任务执行到关键节点
**When** 节点触发器命中
**Then** RecallStrategy 保留原始 4 个节点触发,但**检索算法**从关键词匹配改为复合评分:

| 节点 | L1 recall | L2 recall | L3 recall | 注入到 |
|------|----------|-----------|-----------|--------|
| debate 收尾 → 进 OpenSpec | 不 | type=decision/assumption/risk | preferences (编码风格) | OpenSpec generator prompt |
| OpenSpec 生成前 | 不 | specRef 匹配历史相似 task + type=error (同 specRef 失败) | 不 | generator prompt |
| 子任务派发前 | 当前 step context | 父任务 spec 摘要 + type=error (历史失败模式) | preferences (仅测试框架) | agent system prompt |
| 失败重试前 | 当前 subtask 失败原因 | 同 specRef 历史所有 entries + type=error | 不 | self-correction prompt (CAP-MAR-04) |

### 复合评分公式

**And** Recall 按复合评分排序,不依赖 embedding (v0.11.0 用 TF-IDF):

```
score = 0.4 × tfidfSimilarity(entry.content, query)   // semantic
      + 0.3 × (1 / (1 + hours_since_created / 24))      // recency (天衰减)
      + 0.3 × (entry.importance / 5)                     // importance
```

**And** top-k 动态计算: 每个 entry 预算 ~500 chars,总 recall 预算 ≤ 4K tokens
**And** L3 recall 走精确 key 匹配 (L3 是结构化偏好,不是文档)
**And** 每次 recall 写 `context.recall.score_distribution` (histogram) + `context.recall.empty_total`

**Scenario: 子任务派发前复合评分 recall**
- GIVEN task T1 含 5 个子任务,st-4 即将派发
- WHEN 子任务派发节点触发
- THEN RecallStrategy 对 L2 entries 计算复合评分:
  - entry A: specRef 匹配 + importance=5 + created 2h ago → score=0.85
  - entry B: 关键词部分匹配 + importance=3 + created 24h ago → score=0.45
- AND 返回 top-k (约 8 条,≤ 4K tokens),注入 st-4 的 system prompt

**Scenario: 失败重试 recall 同 spec 历史**
- GIVEN subtask st-2 失败,specRef="CAP-ADAPTER-01"
- WHEN self-correction 触发
- THEN RecallStrategy 对同 specRef 的所有 entries 计算复合评分
- AND 返回历史失败模式 + 决策 + 风险
- AND 注入 self-correction prompt,提高修复成功率

**实现要点:**
- `src/context/recall-strategy.ts` — `class RecallStrategy { onNodeTrigger(node, taskId): RecallResult }`
- `src/context/scorer.ts` — TF-IDF + 复合评分实现 (纯函数,无 LLM 依赖,遵循博弈论 L1 可信源原则)
- 权重 env 化: `DEV_BRAIN_RECALL_SEMANTIC_WEIGHT=0.4` / `DEV_BRAIN_RECALL_RECENCY_WEIGHT=0.3` / `DEV_BRAIN_RECALL_IMPORTANCE_WEIGHT=0.3`
- embedding 升级路径: v0.12.0 将 TF-IDF 替换为 embedding,复合评分框架不变

---

## CAP-CTX-04 (NEW) InjectPlan — Token 预算分配

> **v0.11.0 新增**: 原始 spec 中 recall 结果"追加到 InjectRules content 后",
> 但未定义注入顺序和 token 预算上限。InjectPlan 确保上下文注入"刚好足够"。

**Given** Recall 结果 + InjectRules + 当前 task prompt 都需要进入 system prompt
**When** 组装最终 system prompt
**Then** 按 InjectPlan 分配 token 预算和注入优先级:

```
总预算: 80K tokens (env 可调)
├─ systemPrompt:  ~10K  (base system prompt, 固定)
├─ rules:         ~8K   (InjectRules, 固定)
├─ recall:        ≤4K   (Recall 结果, 动态)
├─ task:          ~30K  (当前 task prompt + spec 段落, 动态)
├─ history:       ~24K  (对话历史, 可被压缩)
└─ reserved:      ~8K   (10% 预留, 应对突发)
```

### 注入优先级

**And** 按优先级从高到低注入 (高优先级先占 token 预算):

| 优先级 | 来源 | 内容 | 说明 |
|--------|------|------|------|
| 100 | L3 | preferences (编码风格/测试框架) | 指令遵循的基础,必须最先注入 |
| 90 | InjectRules | 系统规则 | 不变 |
| 80 | L2 | type=decision | 已做出的决策,Agent 必须遵守 |
| 70 | L2 | type=risk | 已识别的风险 |
| 50 | L2 | type=assumption / type=finding | 上下文发现 |
| 40 | L2 | type=error | 仅 retry_pre 节点注入 |
| 30 | L1 | 当前 step context | 仅子任务派发时注入 |

**And** 低优先级条目在 token 预算耗尽时不注入 (不报错,写 `context.inject.skipped_total{reason="budget_exceeded"}`)

**And** recall 预算 ≤ 4K tokens 是**硬上限**,确保 task + history 有足够空间

**Scenario: Token 预算分配正常**
- GIVEN L3 preferences (500 tokens) + InjectRules (8K) + Recall result (3.5K) + task prompt (28K) + history (22K)
- WHEN InjectPlan 组装
- THEN 总 = 62K ≤ 80K,全部注入
- AND recall 3.5K ≤ 4K 上限,OK

**Scenario: Recall 结果超过预算被截断**
- GIVEN Recall 返回 12 条 entry (约 6K tokens)
- WHEN InjectPlan 组装
- THEN 取优先级 top-k (约 8 条,4K tokens)
- AND 剩余 4 条不注入,写 `context.inject.skipped_total{reason="budget_exceeded"}` +4

**Scenario: 整体超预算触发压缩**
- GIVEN systemPrompt + rules + recall + task + history = 85K > 80K
- WHEN InjectPlan 组装
- THEN 优先压缩 history (从 30K → 20K,触发 T3 压缩)
- AND 仍超 → 降低 recall budget 从 4K → 2K
- AND 最终 78K ≤ 80K

**实现要点:**
- `src/context/inject-plan.ts` — `class InjectPlan { assemble(entries, budget): InjectedPrompt }`
- 纯函数,无 LLM 依赖,无 I/O
- metric: `context.inject.total_tokens` (gauge) / `context.inject.skipped_total{reason}` / `context.inject.budget_utilization_pct`

---

## 集成: 与已有组件的协作

**And** 与 v0.10.0 context-budget.ts 协作:
  - context-budget.ts 的 `maybeSummarise` 接口保留
  - 当触发 `maybeSummarise` 时,优先走 Sleeptime Agent (T2/T3)
  - 如 Sleeptime Agent 不可用,走原有 summarise 逻辑 (兜底)

**And** 与 InjectRules 协同:
  - Recall 结果通过 InjectPlan 注入,排在 InjectRules 之后
  - InjectRules 的 `content` 和 Recall 的 `entries` 共享同一个 token 预算

**And** 与 AsyncLocalStorage 联动:
  - `withTask(taskId, () => ...)` 注入 L2 scope
  - Sleeptime Agent 运行时不注入 task scope

## Metric

新增 metric (替代原始 spec 的 3 个 compressor metric):

```
# L2 结构化记忆
context.l2.entries_total{type}            — 各类型 entry 数量 (gauge)
context.l2.tokens_estimated               — L2 token 估算 (gauge)
context.l2.expired_total{type}            — TTL 过期清理数 (counter)

# Sleeptime Agent
context.sleeptime.runs_total{trigger}     — 运行次数 (counter)
context.sleeptime.duration_ms             — 耗时 (histogram)
context.sleeptime.operations_total{op}    — 各操作计数 (counter)

# Recall
context.recall.score_distribution         — 评分分布 (histogram)
context.recall.empty_total                — 返回空结果 (counter)

# Compress
context.compress.fallback_total           — 前台兜底触发 (counter, 应趋近 0)

# Inject
context.inject.total_tokens               — 注入总 token (gauge)
context.inject.skipped_total{reason}      — 跳过注入 (counter)
context.inject.budget_utilization_pct     — token 预算使用率 (gauge)
```

## 验证

- `pnpm typecheck && pnpm test` 全绿
- L1 scope 隔离单测: 不同 scope 写入后 clearScope,验证隔离
- L2 TTL 单测: mock 时间,验证各类型在 TTL 后过期
- Sleeptime Agent 单测: mock DeepSeek,验证 5 步操作流程
- Recall 复合评分单测: 固定 L2 数据集,验证排序符合预期 (importance=5 + 近期 > importance=1 + 远期)
- InjectPlan 单测: 超预算场景截断,验证优先级排序
