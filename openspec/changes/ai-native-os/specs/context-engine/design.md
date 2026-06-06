---
demand-id: DM-20260606-003
change: ai-native-os
module: context-engine
status: developing
---

# Context Engine 深度设计：Grill with Docs 3 轮

**日期**: 2026-06-06
**关联**: `docs/philosophy.md`

---

## 目标锚定

### L1 — 用户说想要什么？

> "三层记忆模型 L1/L2/L3 + 关键节点 Recall 策略 + L2 有意压缩"

原始 spec (CAP-CTX-01..03) 的描述:
- L1 工作记忆: 单次 agent 调用内的临时变量，16K token 上限
- L2 任务记忆: 单次任务内跨 round 上下文，80K token 上限，5 round 触发 LLM 摘要
- L3 长期偏好: 永久偏好，只通过 evolution-service 写入
- Recall: 4 个节点触发 (debate_end / openspec_pre / subtask_dispatch / retry_pre)

### L2 — 本质上用户想达成什么？

**用户不是在要"三层存储"，用户在要一个能力：**

> Agent 在每一刻都能获得"刚好足够"的上下文来做正确决策——不多（浪费 token），不少（丢失关键信息），不错（被噪声淹没）。

翻译成系统目标:
1. **信号分离**: 把有用的上下文（决策、分歧、风险、偏好）和无用的上下文（寒暄、重复指令、已执行结果）分开
2. **适时注入**: 不在所有时刻塞入所有上下文，而是在"需要这个信息的时刻"精准注入
3. **跨时间传递**: 昨天的决策影响今天的行动，前一个子任务的教训传递给下一个子任务

### L3 — 约束条件是什么？

| 约束 | 来源 | 严苛度 |
|------|------|--------|
| Token 预算有限 (80K system prompt 上限) | v0.10.0 context-budget.ts | 硬约束 |
| 上下文不能被 LLM 自述的 reasoning 污染 | 博弈论审查共识 | 硬约束 |
| L3 长期记忆不能被非 evolution 调用写入 | CAP-EVO-04 | 硬约束 |
| Recall 策略必须"按需"而非"全量"注入 | 工程 + 博弈论共识 | 软约束 |
| 压缩不能丢失关键决策/分歧/风险信息 | v0.11.0 spec | 软约束 |
| 不能依赖单一 LLM 做压缩质量判定 (道德风险) | 博弈论审查共识 | 硬约束 |

### 核心矛盾

```
Token 预算有限 (80K)
    ↕
需要保留的上下文随任务复杂度线性增长
    ↕
压缩会丢失信息，不压缩会超预算
    ↕
关键问题: 什么该保留？什么时候该注入？
```

**这就是 context-engine 要解决的本质问题。**

---

---

## 第 1 轮: 问题空间探索 — "业界怎么解决这个问题的？"

### 信息来源

| 来源 | 类型 | 关键内容 |
|------|------|---------|
| [Letta (MemGPT) Sleep-Time Compute](https://arxiv.org/pdf/2504.13171) (Apr 2025) | 论文 + 开源项目 | OS 风格记忆层次、双 Agent 架构、sleeptime 异步记忆巩固 |
| [CrewAI Cognitive Memory](https://crewai.com/blog/how-we-built-cognitive-memory-for-agentic-systems) (2025) | 产品博客 | 5 步认知操作、统一 Memory API、复合评分 recall |
| [Letta SleepTime Agents Best Practices](https://forum.letta.com/t/sleeptime-agents-for-memory-consolidation-best-practices-guide/154) (2025) | 社区最佳实践 | 记忆过期策略、双 Agent 分离、元认知模块 |
| [ID-RAG: Identity Retrieval-Augmented Generation](https://ar5iv.labs.arxiv.org/html/2509.25299) (Sep 2025) | 论文 | 身份知识图谱防止 persona drift |
| [CrewAI Token Efficiency Audit](https://dev.to/garybotlington/i-audited-crewais-default-patterns-for-token-efficiency-score-43100-1c5c) (2025) | 独立审计 | 默认配置仅 43/100 分，主要原因: 全量上下文传递 |
| [4 种多 Agent 上下文传递策略](https://zhuanlan.zhihu.com/p/2013557939936436639) (Mar 2026) | 工程深度文章 | 共享状态/消息传递/上下文胶囊/路由层级 |
| [RAG-Driven Memory Architectures](https://ieeexplore.ieee.org/abstract/document/11080430) (IEEE Access, Jul 2025) | 综述论文 | 混合记忆分类: episodic/semantic/procedural/emotional |

### 关键发现

#### 发现 1: 业界已经抛弃"5-round 触发 LLM 压缩"模式

原始 spec 的设计:
```
L2 每 5 个 round 触发 LLM 摘要 → 替换 20 round 为 1 条 summary
```

**Letta 的方案更好**: 
- 双 Agent 架构 — 前台 Agent 不做记忆管理（不阻塞用户），后台 Sleeptime Agent 异步做
- Sleeptime Agent 可以用更强的模型（不影响延迟）
- 记忆操作在 idle 期间完成 — 不抢用户时间，不影响 prompt cache

**CrewAI 的教训**:
- "全量上下文传递"是 token 效率的杀手（默认配置仅 43/100）
- 应该把"压缩什么"和"何时压缩"分开处理

**对 dev-brain 的影响**: L2 的"5 round 触发 LLM 压缩"应该改为**异步 Sleeptime Agent 模式**。压缩不应该在关键路径上。

#### 发现 2: 记忆需要 5 步认知操作，不是"压缩就完了"

CrewAI 的 Cognitive Memory 定义了 5 个操作:

| 操作 | 含义 | dev-brain 原始 spec 是否有 |
|------|------|--------------------------|
| **Encode** | 分析内容，推断 scope/category/importance | ❌ 没有 |
| **Consolidate** | 解决矛盾（"用了 MySQL" 替代 "用了 PostgreSQL"） | ❌ 没有 |
| **Recall** | 复合评分: 语义 × 时效 × 重要性 | ⚠️ 有关键词匹配，无复合评分 |
| **Extract** | 从原始 Agent 输出中提取原子事实 | ❌ 没有 |
| **Forget** | 基于半衰期/scope/age 的有意遗忘 | ❌ 没有 |

**对 dev-brain 的影响**: Recall 不能只是"关键词匹配 + 4 个节点触发"。需要复合评分，需要主动遗忘。

#### 发现 3: 业界共识架构 — 双 Agent + 混合存储 + 上下文胶囊

```
2025-2026 年共识架构要素:
  1. 双 Agent: 前台快速响应 + 后台深度记忆
  2. 混合存储: 向量 DB (快速语义) + 结构化存储 (精确关系)
  3. 上下文胶囊: Agent 之间不传原始输出，传压缩后的高密度胶囊
  4. 分层记忆: episodic (高 churn) / semantic (慢变) / identity (最稳定)
  5. 记忆过期: 不同类型不同 TTL
```

**对 dev-brain 的影响**: 原始 spec 的三层 L1/L2/L3 是对的，但缺少:
- 前台/后台 Agent 分离
- 结构化存储（L3 目前是扁平 JSON）
- 记忆过期策略
- 上下文胶囊（Agent 间传 L2 全量不切实际）

#### 发现 4: Letta 的记忆过期策略直接可用

| 内容类型 | 过期策略 | 适用 dev-brain |
|---------|---------|--------------|
| 会话上下文 | 30 天（被引用 3+ 次则提升） | → L2 短期任务记忆 |
| 决策记录 | 永不过期 | → L2 中的 decisions |
| 调试/错误 | 14 天（`type:root-cause` 除外） | → L2 中的 failures |
| 用户偏好 | 永不过期 | → L3 长期偏好 |
| 项目上下文 | 项目标记 inactive 时归档 | → L3 项目级偏好 |

---

## 第 2 轮: 方案对比 — "在 dev-brain 的约束下哪个最优？"

### 候选方案

| 方案 | 核心思路 | 代表项目 | 优势 | 劣势 |
|------|---------|---------|------|------|
| **A: 原始 spec** | L1/L2/L3 三层，5-round LLM 压缩，关键词 recall | dev-brain v0.11.0 原 spec | 简单，已设计 | token 效率低(43/100)，缺遗忘/过期/萃取，无复合评分 |
| **B: Letta 风格** | 双 Agent + sleeptime + OS 虚拟记忆 | Letta | 成熟(arXiv 论文 + 生产验证)，缓存友好，模型可独立选择 | 重(Git 版本控制 ~10GB/agent)，对 dev-brain 过于复杂 |
| **C: CrewAI 风格** | 5 步认知操作 + 统一 Memory API + 复合评分 | CrewAI | 操作完整(编码/巩固/recall/萃取/遗忘)，API 简洁 | 多用户隔离是后加的，并发写入有锁问题 |
| **D: 混合精简版 (推荐)** | 吸取 B 的双 Agent 架构 + C 的认知操作 + dev-brain 的 L1/L2/L3 分层 | 新设计 | 轻量，切合 dev-brain 约束，博弈论安全 | 需要重新设计接口 |

### 方案对比矩阵

| 维度 | A (原 spec) | B (Letta) | C (CrewAI) | D (混合) |
|------|-----------|-----------|------------|---------|
| Token 效率 | ⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ |
| 记忆质量 | ⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ |
| 实现复杂度 | ⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ |
| 博弈论安全 | ⭐⭐ | ⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐⭐ |
| dev-brain 适配 | ⭐⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ |
| 遗忘机制 | ❌ | ✅ (TTL) | ✅ (半衰期) | ✅ (TTL) |
| 矛盾消解 | ❌ | ✅ | ✅ | ✅ (异步) |
| 双 Agent 分离 | ❌ | ✅ | ❌ | ✅ |

### 推荐: 方案 D — 混合精简版

**理由**:
1. Letta 的 Git 版本控制 (~10GB) 对 dev-brain 的本地运行场景过重
2. CrewAI 的并发锁问题在 dev-brain 单用户场景下不存在
3. 双 Agent 架构是 2025 年共识，但 dev-brain 不需要完整的 OS 虚拟记忆
4. dev-brain 的 L1/L2/L3 分层框架是正确的，只需补充认知操作和异步机制

---

## 第 3 轮: 详细设计

### 3.1 架构概览

```
                    ┌─────────────────────────────┐
                    │      Brain Engine            │
                    │  (任务派发 / 状态机)          │
                    └─────────────┬───────────────┘
                                  │
              ┌───────────────────┼───────────────────┐
              │                   │                   │
     ┌────────▼────────┐  ┌──────▼──────┐  ┌────────▼────────┐
     │  L1 工作记忆     │  │ L2 任务记忆  │  │ L3 长期偏好      │
     │  (Foreground)   │  │ (Foreground) │  │ (Background)    │
     │                 │  │              │  │                 │
     │  进程内 Map      │  │ 进程内 +      │  │ ~/.dev-brain/   │
     │  16K token 上限  │  │ checkpoint   │  │ l3-memory/      │
     │  单次 adapter    │  │ 序列化        │  │                 │
     │  调用内          │  │ 单 taskId     │  │ 跨 task 永久     │
     │                 │  │ 生命周期      │  │                 │
     └────────┬────────┘  └──────┬──────┘  └────────┬────────┘
              │                   │                   │
              │    ┌──────────────┼──────────────┐    │
              │    │              │              │    │
              │    │   ┌──────────▼──────────┐   │    │
              │    │   │  RecallStrategy      │   │    │
              │    │   │  (复合评分召回)       │   │    │
              │    │   └──────────┬──────────┘   │    │
              │    │              │              │    │
              │    │   ┌──────────▼──────────┐   │    │
              │    │   │  InjectRules        │   │    │
              │    │   │  (组装 → system      │   │    │
              │    │   │   prompt 注入)       │   │    │
              │    │   └─────────────────────┘   │    │
              │    └──────────────────────────────┘    │
              │                                        │
     ┌────────▼────────────────────────────────────────▼────────┐
     │              Sleeptime Context Agent (Background)         │
     │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
     │  │ Encode   │  │Consolidate│  │ Extract  │  │ Forget   │ │
     │  │ 分类+打分 │  │ 去重+消解 │  │ 原子萃取  │  │ TTL淘汰  │ │
     │  └──────────┘  └──────────┘  └──────────┘  └──────────┘ │
     │                                                          │
     │  Model: DeepSeek (复用, low priority, no latency bound)   │
     │  Trigger: 会话结束 / 每 6h / L2 token > 50K              │
     └─────────────────────────────────────────────────────────┘
```

### 3.2 核心改动 vs 原始 spec

| 原始 spec | 混合精简版 | 改动理由 |
|-----------|----------|---------|
| L2 "5 round 触发 LLM 摘要" | **异步 Sleeptime Agent**: 会话结束 + 每 6h + token > 50K 触发 | 避免阻塞关键路径，支持用更强模型，不影响 prompt cache (Letta 2025 发现) |
| Recall "关键词匹配" | **复合评分**: `score = α·semantic + β·recency + γ·importance + δ·node_match` | CrewAI 生产验证，关键词匹配在不同 LLM 表述下会失效 |
| L3 "扁平 JSON 文件" | **结构化分级**: `prompts/` / `preferences/` / `decisions/` 三级目录 + TTL 标签 | 支持遗忘策略、按类型过滤召回 |
| 无遗忘机制 | **TTL 过期**: 会话 30d / 错误 14d / 决策 ∞ / 偏好 ∞ | Letta 社区最佳实践 |
| 无矛盾消解 | **后台 Consolidate**: Sleeptime Agent 检测矛盾 → 标记 → 异步消解 | CrewAI Cognitive Memory 的 Consolidate 操作 |
| Recall 仅 4 个固定节点 | **可扩展触发器 + 复合评分**: 节点触发器保留，但 recall 的"选什么"改为复合评分 | 工程共识: 触发器和检索算法应解耦 |

### 3.3 L1 工作记忆（保持简单，增加 Scope 隔离）

```typescript
// CAP-CTX-01 修订: L1 增加 scope 隔离 + 不可变快照

interface L1WorkingMemory {
  // 写入: 仅当前 adapter.send() 内
  set(key: string, value: unknown, scope: 'tool_call' | 'step' | 'subtask'): void;
  get<T>(key: string): T | undefined;
  
  // 快照: 不可变副本用于 checkpoint
  snapshot(): Readonly<Record<string, unknown>>;
  
  // scope 隔离: subtask 结束自动清除该 scope 的所有 key
  // 防止 L1 变量泄漏到下一个 subtask（原始 spec 已有，保留）
  clearScope(scope: 'tool_call' | 'step' | 'subtask'): void;
}
```

**改动**: 增加 `scope` 参数，三种生命周期 (`tool_call` < `step` < `subtask`)，比原始 spec 的单层清空更精细。来源: CrewAI 的 State 分层模式。

### 3.4 L2 任务记忆（核心改动最大）

```typescript
// CAP-CTX-02 修订: 结构化 Entry + 异步压缩 + 复合评分 Recall

interface L2TaskMemory {
  // ===== 写入（前台,低延迟）=====
  addEntry(entry: L2Entry): void;
  
  // ===== Recall（前台,低延迟）=====
  recall(needle: string, k?: number, filters?: RecallFilter): L2Entry[];
  // 复合评分: score = α·semantic + β·recency + γ·importance
  // 默认 α=0.4, β=0.3, γ=0.3, k=5
  
  // ===== 压缩（后台 Sleeptime Agent,不阻塞前台）=====
  // 不再在关键路径上触发
  compress(strategy: CompressStrategy): Promise<CompressResult>;
  
  // ===== 持久化 =====
  checkpoint(): L2Checkpoint;
  restore(ckpt: L2Checkpoint): void;
}

interface L2Entry {
  id: string;
  type: 'decision' | 'assumption' | 'risk' | 'finding' | 'action' | 'error' | 'summary';
  content: string;             // ≤ 500 chars 原子事实
  importance: 1..5;            // 1=trivial, 5=critical
  roundNumber: number;
  subtaskId?: string;
  specRef?: string;            // 关联的 spec 条款
  conflicts?: string[];        // 与之矛盾的 entry id 列表
  ttl?: number;                // 过期时间戳 (null = 不过期)
  createdAt: number;
  sourceEvidence?: string[];   // 指向原始 Agent 输出的引用（L1 可信源原则）
}
```

**关键设计决策**:

1. **结构化 Entry > 自由文本**。原始 spec 的 LLM 摘要生成 ~2K token 自由文本，但自由文本无法做精确 TTL、重要性排序、矛盾检测。结构化 Entry 是 CrewAI + ID-RAG 的共识方向。

2. **复合评分替代关键词匹配**。原始 spec 的 Recall 用关键词匹配，但不同 LLM 对同一概念表述方式不同。复合评分公式: `score = 0.4 × semantic_similarity + 0.3 × (1 / hours_since_created) + 0.3 × (importance / 5)`。不依赖 embedding（v0.11.0 用 TF-IDF + Jaccard，embedding 留 v0.12.0）。

3. **压缩走后台 Sleeptime Agent**。原始 spec 的"5 round 触发 LLM 压缩"在关键路径上，阻塞主流程。改为 Sleeptime Agent 异步执行:
   ```
   Trigger: 会话结束 OR 每 6h OR L2 token > 50K
   Model: DeepSeek (复用, 无延迟约束)
   操作:
     Consolidate: 合并同主题 entries，消解矛盾
     Extract: 从 Agent 原始输出中萃取原子事实
     Forget: 清理过期 entries (TTL)
     Compress: 15+ entries 同主题时合并为 1 条 summary + 保留 top 3 原始
   ```

### 3.5 L3 长期记忆（结构化 + TTL）

```typescript
// CAP-CTX-03 修订: 结构化分级目录 + TTL

interface L3LongTermMemory {
  read(path: L3Path, filters?: L3Filter): Promise<L3Entry[]>;
  write(entry: L3Entry, opts?: { fromEvolution?: boolean }): Promise<void>;
  
  // 新增: 遗忘
  expire(): Promise<number>;  // 返回清除的条目数
}

type L3Path = `prompts/${string}` | `preferences/${string}` | `decisions/${string}`;

interface L3Entry {
  id: string;
  path: L3Path;
  content: string;
  importance: 1..5;
  ttl: number | null;             // null = never expire
  evolved_at?: string;            // evolution-service 写入时带
  eval_pass_rate?: number;        // evolution-service 写入时带
  parent_id?: string;             // evolution 链
  source: 'evolution' | 'manual'; // 写入来源
}
```

**L3 目录结构**:
```
~/.dev-brain/l3-memory/
  prompts/           # Evolution Service 产出的 prompt 偏好
    prm-xxx.json     #   TTL: null (永不过期,但可被 evolution 更新)
  preferences/       # 用户编码风格偏好
    style.json       #   TTL: null
    testing.json     #   TTL: null
    review.json      #   TTL: null
  decisions/         # 重大决策记录
    arch-xxx.json    #   TTL: null
```

### 3.6 Recall 策略（解耦触发器与检索算法）

```typescript
// CAP-CTX-04 修订: 触发器 × 检索算法解耦

interface RecallStrategy {
  // 触发器: 何时触发 (与原始 spec 保持一致的 4 个节点)
  //   debate_end / openspec_pre / subtask_dispatch / retry_pre
  onNodeTrigger(node: RecallNode, taskId: string): Promise<RecallResult>;
}

interface RecallResult {
  entries: {
    l2: L2Entry[];   // 来自 L2 的复合评分 top-k
    l3: L3Entry[];   // 来自 L3 的精确 key 匹配
  };
  totalTokens: number;
  node: RecallNode;
}

// 复合评分实现 (不依赖 embedding, v0.11.0 用 TF-IDF)
function scoreL2Entry(entry: L2Entry, query: string, now: number): number {
  const semantic = tfidfSimilarity(entry.content, query);  // 0..1
  const recency = 1 / (1 + (now - entry.createdAt) / 3600000); // 小时衰减
  const importance = entry.importance / 5;                  // 0..1
  
  return 0.4 * semantic + 0.3 * recency + 0.3 * importance;
}
```

**与原始 spec 的关键差异**:

| 原始 spec | 混合精简版 |
|----------|----------|
| 4 个节点触发器 + 关键词匹配 | 4 个节点触发器 + 复合评分 (TF-IDF semantic × recency × importance) |
| Recall 注入 system prompt 末尾 | 注入位置由 InjectRules 按优先级排序: L3 偏好 → L2 决策 → L2 风险 → L2 发现 |
| top-k 默认 5 | top-k 改为 dynamic: 每个 entry 的预算 ~500 chars，总 recall 预算 ≤ 4K tokens |

### 3.7 InjectRules 协同（新增）

原始 spec 中 recall 结果"追加到 InjectRules content 后"，但没有定义注入顺序和 token 预算分配。新增:

```typescript
// 新增: 上下文注入预算分配

interface InjectPlan {
  budget: {
    total: number;            // 总 token 预算 (默认 80K)
    systemPrompt: number;     // base system prompt (固定)
    rules: number;            // InjectRules (固定)
    recall: number;           // Recall 结果 (动态, ≤ 4K)
    task: number;             // 当前 task prompt (动态)
    history: number;          // 对话历史 (动态, 可能被压缩)
    reserved: number;         // 预留 (10% 总预算)
  };
  entries: InjectedEntry[];   // 按 priority 排序
}

interface InjectedEntry {
  source: 'l2' | 'l3' | 'rules' | 'task';
  priority: number;           // 高 = 先注入
  content: string;
  tokenEstimate: number;
}
```

**注入顺序** (优先级从高到低):
1. L3 偏好 (priority=100) — 用户编码风格/测试框架偏好，必须最先让 Agent 看到
2. InjectRules (priority=90) — 系统规则
3. L2 决策 (priority=80) — 已做出的决策
4. L2 风险 (priority=70) — 识别的风险
5. L2 发现/假设 (priority=50) — 上下文发现
6. L2 错误 (priority=40) — 仅 retry_pre 节点注入

### 3.8 DeliberateCompressor → SleeptimeContextAgent

原始 spec 的 `DeliberateCompressor` 在关键路径上触发 LLM 压缩。改为:

```typescript
// 新增: 后台上下文 Agent (替代 DeliberateCompressor)

class SleeptimeContextAgent {
  // 异步执行,不阻塞主任务
  async run(taskId: string): Promise<SleeptimeReport> {
    const l2 = this.l2Memory;
    
    // Step 1: ENCODE — 分析未处理的 entries, 补全 type/importance/specRef
    const unprocessed = l2.getUnprocessed();
    for (const entry of unprocessed) {
      entry.type = await this.classifyEntry(entry);
      entry.importance = await this.scoreImportance(entry);
    }
    
    // Step 2: CONSOLIDATE — 检测矛盾并消解
    const conflicts = this.detectConflicts(l2.getAll());
    for (const [a, b] of conflicts) {
      if (a.importance >= b.importance) {
        b.conflicts.push(a.id);
        b.ttl = now + 7 * 86400000; // 矛盾方 7 天后过期
      }
    }
    
    // Step 3: EXTRACT — 从 L2 summaries 中萃取原子事实
    const summaries = l2.getByType('summary');
    for (const s of summaries) {
      const facts = await this.extractFacts(s.content); // LLM call (DeepSeek)
      for (const fact of facts) {
        l2.addEntry({ type: 'finding', content: fact, ... });
      }
    }
    
    // Step 4: FORGET — 清理过期 entries
    const expired = l2.expire();
    
    // Step 5: COMPRESS (仅在 token > 50K 时)
    if (l2.estimateTokens() > 50000) {
      await this.compressByTheme(l2); // 同主题 15+ entries → summary + top 3
    }
    
    return { encoded: unprocessed.length, consolidated: conflicts.length, 
             extracted: facts.length, forgotten: expired, compressed: ... };
  }
}
```

**触发策略**:
```
Trigger 1: 会话结束 (task.complete 事件) → 低频率运行 (encode + consolidate + forget)
Trigger 2: 每 6h 定时 → 中等频率 (all 5 steps)
Trigger 3: L2 token > 50K 警告线 → 立即触发 (compress only)
Trigger 4: L2 token > 80K 必须压缩 → 前台兜底: 取最近 20 entries + 重要性 top 10, 其余丢弃
```

### 3.9 与博弈论共识的一致性检查

| 博弈论共识 | context-engine 如何满足 |
|----------|----------------------|
| 不依赖 LLM 自述 reasoning | L2 entry 的 `sourceEvidence` 指向 Agent 实际产出(文件/git diff/测试结果)，不依赖 Agent 自述 |
| 不可归因的不过度归因 | Extract 萃取时, 置信度 < 0.7 的 fact 标 `confidence: low`, 不进入主 recall 路径 |
| 激励相容 | Sleeptime Agent 只做记忆管理, 不影响 Agent 的绩效评估。前台 Agent 不知道后台在做压缩(信息隔离) |
| Safety Net | Trigger 4 的前台兜底是最后安全网 — 即使后台 Agent 完全失效, L2 不会撑爆 token 预算 |

### 3.10 Metric

新增 (替代原始 spec 的 3 个 compressor metric):

```
context.l2.entries_total{type}           — L2 各类型 entry 数量
context.l2.tokens_estimated              — L2 token 估算 (gauge)
context.l2.expired_total                 — TTL 过期清理数
context.sleeptime.runs_total{trigger}    — Sleeptime Agent 运行次数
context.sleeptime.duration_ms            — Sleeptime Agent 耗时 (histogram)
context.sleeptime.operations_total{op}   — encode/consolidate/extract/forget/compress 各操作计数
context.recall.score_distribution        — Recall 评分分布 (histogram)
context.recall.empty_total               — Recall 返回空结果次数
context.compress.fallback_total          — 前台兜底压缩触发次数 (应趋近 0)
```

### 3.11 文件清单变更

```
修改:
  src/context/l1-working-memory.ts   — 增加 scope 参数
  src/context/l2-task-memory.ts      — 结构化 Entry + 复合评分 + TTL
  src/context/l3-long-term-memory.ts — 结构化目录 + TTL + expire()
  src/context/recall-strategy.ts     — 复合评分替代关键词匹配
  src/context/compressor.ts          — 重构为 SleeptimeContextAgent

新增:
  src/context/sleeptime-agent.ts     — SleeptimeContextAgent 主类
  src/context/types.ts               — L2Entry / L3Entry / InjectPlan 等类型
  src/context/scorer.ts              — TF-IDF + 复合评分实现
  src/context/ttl-manager.ts         — TTL 过期管理

删除:
  src/context/compressor.ts          — 功能合并到 SleeptimeContextAgent
  (原始 DeliberateCompressor 不再需要独立文件)

新增测试:
  tests/unit/context/sleeptime-agent.test.ts
  tests/unit/context/scorer.test.ts
  tests/unit/context/ttl-manager.test.ts
  tests/unit/context/l2-task-memory.test.ts (扩展)
```

---

## 设计总结

### 与原始 spec 的差异

| 维度 | 原始 spec | 混合精简版 |
|------|----------|----------|
| **压缩时机** | 5 round 同步触发 | Sleeptime Agent 异步 (4 种 trigger) |
| **压缩方式** | LLM 摘要 (~2K token 自由文本) | 5 步认知操作 (encode/consolidate/extract/forget/compress) |
| **Recall** | 关键词匹配 | 复合评分: 0.4·semantic + 0.3·recency + 0.3·importance |
| **遗忘** | 无 | TTL 分级: 会话 30d / 错误 14d / 决策 ∞ / 偏好 ∞ |
| **矛盾处理** | 无 | 后台 consolidate 消解 |
| **L2 结构** | 自由文本 summary | 结构化 Entry (8 种 type + importance + specRef + ttl) |
| **L3 结构** | 扁平 JSON | 三级目录 (prompts/preferences/decisions) |
| **token 预算** | 无显式分配 | InjectPlan: recall ≤ 4K, 总预算 80K, 10% 预留 |
| **博弈论安全** | 未考虑 | L1 可信源做 evidence, 前台/后台信息隔离 |

### 行业对标

| 特性 | 来源 |
|------|------|
| 双 Agent (前台+后台) | Letta Sleep-Time Compute (Apr 2025) |
| 5 步认知操作 | CrewAI Cognitive Memory (2025) |
| 复合评分 recall | CrewAI + ID-RAG (Sep 2025) |
| 结构化 L2 Entry | IEEE Access 综述 (Jul 2025) 的 episodic/semantic 分离 |
| TTL 记忆过期 | Letta 社区最佳实践 (2025) |
| 上下文胶囊 (InjectPlan 预算) | 多 Agent 上下文传递策略 (Mar 2026) |
| L1 可信源 evidence | dev-brain 博弈论审查共识 (Jun 2026) |
