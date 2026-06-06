---
demand-id: DM-20260606-002
change: spec-driven-workflow
status: developing
---

# Intent Classifier Spec (Delta — v0.10.0)

本文为 spec-driven-workflow 引入的新 capability,描述意图识别子系统的契约。

## CAP-INT-01 (NEW) DeepSeek 意图分类

**Given** Gateway 收到用户文本消息 `text`,包含 `chatId` 和 `senderOpenId`
**When** BrainEngine 处理该消息
**Then** 调用 `IntentClassifier.classify(text, context)` 返 `Intent` 对象
**And** Intent 必含字段:
  - `type: "feature" | "bug" | "refactor" | "query" | "config"`
  - `entities: string[]` (从文本抽取的命名实体)
  - `urgency: "low" | "normal" | "high" | "critical"`
  - `affected_modules: string[]` (推测影响的代码模块)
  - `intent_score: number` (0-1,DeepSeek 置信度)
  - `trace_id: string`
**And** 分类耗时 < 2s (P95)
**And** 失败/超时自动降级到 `IntentFallbackClassifier` (MiniMax haiku)

**实现要点:**
- `src/intent/deepseek-adapter.ts` — HTTPS POST 到 `https://api.deepseek.com/v1/chat/completions`
- `src/intent/classifier.ts` — 主 orchestrator,捕获异常后切 fallback
- `src/intent/fallback-classifier.ts` — MiniMax haiku 兜底
- 5 档 type 是封闭集合,新增档位需改 `IntentType` union + DeepSeek system prompt
- 失败 3 次连续 (config: `intentMaxRetries=3`) 抛 `IntentClassifyError`

**Scenario: feature 类需求被正确分类**
- GIVEN 用户文本 "trade 模块加日期筛选"
- WHEN 调用 classifier
- THEN `type === "feature"`,`entities` 包含 "trade" 和 "date_filter",`affected_modules` 包含 `"trade/**"`

**Scenario: DeepSeek 不可用时降级**
- GIVEN `DEV_BRAIN_DEEPSEEK_API_KEY` 未设置或 HTTP 503
- WHEN 调用 classifier
- THEN 自动调用 fallback (MiniMax haiku) 并返回同结构 Intent
- AND 写 `intent.fallback` 事件到日志,`brain.intent.fallback_total` counter +1

**Scenario: 文本超长截断**
- GIVEN 文本 > 8K tokens
- WHEN 调用 DeepSeek
- THEN 截断到前 8K tokens (留 system prompt 空间),DeepSeek 仍能基于摘要分类

## CAP-INT-02 (NEW) Intent 元数据传递

**Given** Classifier 返 Intent 对象
**When** BrainEngine 把它挂到 `BrainTaskPlan.metadata.intent`
**Then** 后续 Debate / OpenSpec 生成 / 进度报告都能读到
**And** `BrainTaskPlan` 序列化 (计划卡片 / OpenSpec) 时包含 intent JSON
**And** 卡片按钮回调里也能反向解出 intent.type 决定下一步行为 (e.g. bug 类需求跳 issue 模板)

**实现要点:**
- `BrainTaskPlan.metadata: { intent?: Intent; ... }` 字段为可选
- 序列化时使用 `JSON.stringify(intent)`;不脱敏因为不含敏感数据 (但 `applied_rules` 留空)
- Intent 含 `trace_id` 让下游日志能关联

## CAP-INT-03 (NEW) 意图缓存

**Given** 同一 chatId 60s 内发来 2 条相同文本 (e.g. "重发" 重试)
**When** Classifier 收到第二条
**Then** 直接返回缓存 (TTL=60s),不发第二次 DeepSeek 请求
**And** 缓存 key = `sha256(chatId + text)`,命中后 metric `intent.cache.hit_total` +1

**实现要点:**
- 内存 LRU + TTL,不持久化
- 关闭 daemon 时清空
- 命中率通过 `intent.cache.{hit,miss}_total` 观测
