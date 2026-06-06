---
demand-id: DM-20260606-003
change: ai-native-os
module: context-engine
status: developing
---

# Context Engine — Tasks

> **v0.11.0 修订**: 经行业调研 (Letta Sleep-Time Compute / CrewAI Cognitive Memory), 原始"5 round 触发 LLM 压缩 + 关键词 recall"设计已替换为异步 Sleeptime Agent + 复合评分 recall + InjectPlan token 预算。详见 `design.md`。

## 1. 类型骨架

- [ ] `src/context/types.ts` — 定义 `L1Scope` / `L2Entry` (8 种 type) / `L3Entry` / `L3Path` / `RecallResult` / `InjectPlan` / `InjectedEntry` / `SleeptimeReport`
- [ ] `src/observability/metrics.ts` 注册 context 全系列 metric (~10 个,含 sleeptime 操作计数/recall 评分分布/compress fallback)

## 2. L1/L2/L3 三层记忆 (CAP-CTX-01)

- [ ] `src/context/l1-working-memory.ts` — 进程内存 Map,带 scope 隔离 (`tool_call` / `step` / `subtask`),snapshot/restore,16K token 上限
- [ ] `src/context/l2-task-memory.ts` — 结构化 L2Entry (8 种 type: decision/assumption/risk/finding/action/error/summary),importance 1-5,TTL,specRef,sourceEvidence
- [ ] `src/context/l3-long-term-memory.ts` — 三级目录 (prompts/preferences/decisions) + TTL 标签,复用 Phase E.7 的 L3LongTermMemory 类,非 evolution 写入拒绝
- [ ] `src/context/ttl-manager.ts` — TTL 过期策略: decision/risk ∞, assumption/finding 30d (被引用 ≥3 次提升), action/error 14d (root-cause ∞), summary 90d
- [ ] AsyncLocalStorage 注入 L2 scope: `withTask(taskId, () => ...)`
- [ ] 单测 `tests/unit/context/l1-working-memory.test.ts`: 3 场景 (scope 隔离/snapshot/restore)
- [ ] 单测 `tests/unit/context/l2-task-memory.test.ts`: 4 场景 (写入/复合评分 recall/checkpoint/TTL 过期)
- [ ] 单测 `tests/unit/context/ttl-manager.test.ts`: 4 场景 (各类 TTL/提升/永不过期/批量过期)

## 3. SleeptimeContextAgent (CAP-CTX-02)

> 替代原始 DeliberateCompressor。双 Agent 架构: 前台不阻塞,后台异步执行记忆操作。

- [ ] `src/context/sleeptime-agent.ts` — `class SleeptimeContextAgent { async run(taskId): Promise<SleeptimeReport> }`
- [ ] 5 步认知操作:
  - **ENCODE**: 分析未处理 entries,补全 type/importance/specRef (可选 LLM: DeepSeek, low priority)
  - **CONSOLIDATE**: 检测矛盾 entries,高 importance 方保留,低方标 TTL=7d
  - **EXTRACT**: 从 summary 中萃取原子事实 → 新 L2Entry (type=finding)
  - **FORGET**: 清理过期 entries (按 TTL)
  - **COMPRESS**: 仅在 token > 50K 时,同主题 ≥15 entries → 1 summary + 保留 top 3
- [ ] 4 种触发:
  - T1: 会话结束 (task.complete) → encode + consolidate + forget
  - T2: 每 6h 定时 (cron) → 全部 5 步
  - T3: L2 token > 50K 警告线 → compress only
  - T4: L2 token > 80K 紧急 → 前台兜底 fallback (最近 20 + 重要性 top 10)
- [ ] 复用 DeepSeek client,不可用时 graceful skip (仅跳过 LLM 步骤,FORGET/COMPRESS 仍执行)
- [ ] T2 cron 注册: 在 BrainEngine 调度器中注册每 6h 触发 `sleeptimeAgent.run(taskId, 'T2')`, cron 走 `src/brain/scheduler.ts` (v0.10.0 已有)
- [ ] 删除旧文件: `src/context/compressor.ts` (功能合并到 SleeptimeContextAgent),更新所有 import 引用
- [ ] 写 `context.sleeptime.runs_total{trigger}` / `context.sleeptime.duration_ms` / `context.sleeptime.operations_total{op}` / `context.compress.fallback_total`
- [ ] 单测 `tests/unit/context/sleeptime-agent.test.ts`: 5 场景 (全部操作/仅 compress/DeepSeek 不可用/前台兜底/T4 触发)

## 4. RecallStrategy (CAP-CTX-03)

- [ ] `src/context/recall-strategy.ts` — 4 节点触发器保留 (debate_end / openspec_pre / subtask_dispatch / retry_pre)
- [ ] `src/context/scorer.ts` — 复合评分: `score = 0.4 × tfidfSimilarity + 0.3 × recency + 0.3 × importance`, TF-IDF 手写纯函数 (无外部依赖, ~80 行)
- [ ] top-k 动态: 每个 entry ~500 chars,总 recall 预算 ≤ 4K tokens (由 InjectPlan 控制)
- [ ] 权重 env 可配: `DEV_BRAIN_RECALL_SEMANTIC_WEIGHT=0.4` / `DEV_BRAIN_RECALL_RECENCY_WEIGHT=0.3` / `DEV_BRAIN_RECALL_IMPORTANCE_WEIGHT=0.3`
- [ ] embedding 升级路径标 TODO (v0.12.0)
- [ ] L3 走精确 key 匹配 (按 L3Path)
- [ ] 写 `context.recall.score_distribution` (histogram) / `context.recall.empty_total`
- [ ] 单测 `tests/unit/context/scorer.test.ts`: 4 场景 (TF-IDF/recency 衰减/importance 加权/空结果)
- [ ] 单测 `tests/unit/context/recall-strategy.test.ts`: 4 节点 × 2 场景 (命中/空)

## 5. InjectPlan (CAP-CTX-04)

- [ ] `src/context/inject-plan.ts` — `class InjectPlan { build(recall, rules, task): InjectedEntry[] }`
- [ ] Token 预算分配: total 80K, systemPrompt 10K, rules 8K, recall ≤4K, task 30K, history 24K, reserved 8K (10%)
- [ ] 7 级优先级注入: L3 preferences=100 > InjectRules=90 > L2 decisions=80 > risks=70 > findings=50 > assumptions=40 > errors=30
- [ ] 硬上限强制: 超预算时从最低优先级开始裁剪,写 `context.inject.skipped_total{source}`
- [ ] 单测 `tests/unit/context/inject-plan.test.ts`: 4 场景 (正常分配/超预算裁剪/空 recall/优先级排序)

## 集成

- [ ] `src/brain/brain-engine.ts` — 接入 recall-strategy + inject-plan
- [ ] `src/context/context-budget.ts` (v0.10.0) — `maybeSummarise()` 优先走 Sleeptime Agent (T3),不可用时退到原有 summarise 逻辑; 超 80K 硬上限走 T4 前台兜底
