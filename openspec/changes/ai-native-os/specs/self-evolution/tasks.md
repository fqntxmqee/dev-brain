---
demand-id: DM-20260606-003
change: ai-native-os
module: self-evolution
status: developing
---

# Self-Evolution — Tasks

> **v0.11.0 修订 2**: 经行业调研 (DSPy / GReaTer / SAHOO / DGM), 在博弈论审查基础上增加 5 项增量增强: 成功模式挖掘 / Reasoning Trace / Goal Drift Index / CostBudget / ProvenanceChain。详见 `design.md`。

## E.1 依赖 + 类型骨架

- [ ] `pnpm add -D ts-morph escomplex` (jscpd 走子进程,无需安装)
- [ ] `src/evolution/types.ts` 定义 `Insight` (含 type: "negative"|"positive") / `Diagnostic` / `Fix` / `ValidationResult` / `L2Score` / `EvalResult` / `EvalReport` / `EvolutionRun` / `RunSummary` / `L1FailureTrace` (含 agentReasoning?) / `Attribution` / `CostBudget` / `L3PromptEntry` (含 provenance)
- [ ] `src/observability/metrics.ts` 注册 evolution 全系列 metric (~25 个):
  - 基础: `evolution.insights_produced_total` / `evolution.positive_insights_total` / `evolution.diagnostics_run_total` / `evolution.diagnostics_validated_total` / `evolution.diagnostics_rejected_total` / `evolution.diagnostics_failed_total` / `evolution.insights_skipped_total`
  - 双轨 eval: `evolution.decision_set_pass_rate` / `evolution.monitor_set_pass_rate` / `evolution.capability_drift_alerts_total` / `evolution.prompts_rejected_by_drift_total`
  - 采纳/拒绝: `evolution.prompts_evolved_total` / `evolution.prompts_rejected_total` / `evolution.rollbacks_total`
  - 熔断: `evolution.circuit_breaker.state` / `evolution.skipped_circuit_open` / `evolution.circuit_breaker.reset_manual`
  - 用户反馈: `evolution.user_satisfaction_score` / `evolution.user_feedback_total{signal}` / `evolution.prompts_rejected_by_user_feedback_total`
  - v0.11.0 新增: `evolution.diagnostics_with_reasoning_total` / `evolution.goal_drift_detected_total` / `evolution.goal_drift_blocked_total` / `evolution.token_spent_total` / `evolution.token_budget_exceeded_total` / `evolution.daily_token_budget` / `evolution.provenance_chain_depth` / `evolution.success_pattern_adopted_total`
- [ ] 加 `l3.manual_write_denied_total`
- [ ] `config/rule-validator.yaml` — RuleValidator Level 2 规则初始配置 (R2-1 spec 引用 / R2-2 量化指标 / R2-3 模式匹配 / R2-4 路径过滤)

## E.2 InsightEngine (CAP-EVO-01) — 失败 + 成功双信号

> **v0.11.0 修订 2**: 增加成功模式挖掘 (DSPy BootstrapFewShot 启发)。

- [ ] `src/evolution/insight-engine.ts` — `class InsightEngine { run(): Promise<Insight[]>; extractSuccessPatterns(successes): Insight[] }`
- [ ] 输入: `codeHealth` snapshot (近 7 天) + `failures` JSONL + `successes` JSONL (NEW)
- [ ] 4 category 分类启发式 (context / spec / prompt / agent-stability)
- [ ] 成功模式提取 (NEW):
  - 扫描 acceptance 全 pass 的 subtask 的 prompt
  - 统计高频特征词与 pass rate 的相关性 (相关性 > 0.3 且出现 > 3 次 → positive insight)
  - type="positive", severity 默认 "low"
- [ ] 7 天内同 category 去重 (正负 pattern 分别去重)
- [ ] 数据不足 (< 3 trace) 跳过,记 `evolution.insights_skipped_total`
- [ ] 输出 top 10 insights (按 score 排序),落 `~/.dev-brain/evolution/insights-<date>.json`
- [ ] 单测 `tests/unit/evolution/insight-engine.test.ts`: 6 场景 (聚合/去重/数据不足/分类正确/成功模式发现/正负混合排序)

## E.3 DiagnosticLLM (CAP-EVO-02) — 两阶段分离 + Reasoning Trace

> **v0.11.0 修订 2**: Agent Reasoning Trace 作为可选 evidence (GReaTer 启发)。

- [ ] `src/evolution/diagnostic-llm.ts` — 两阶段分离式调用:
  - 阶段 1: `diagnose(insight, agentReasoning?) → Diagnostic { insightId, rootCause, rationale, confidence }`
  - 阶段 2: `suggestFix(diagnostic) → Fix { fix, diff?, specRefs[] }` (仅被采纳后调用)
- [ ] prompt 模板增加 Reasoning Trace 区块 (NEW):
  - 若 `agentReasoning` 存在,注入 evidence: "Agent Reasoning Trace: <agent_reasoning>"
  - 提示关注: Agent 是否说"不需要测试" (spec 不够强) / "不确定" (spec 不够清晰)
- [ ] 复用 v0.10.0 DeepSeek client
- [ ] DeepSeek 不可用 graceful skip,记 `evolution.diagnostics_failed_total`
- [ ] 落 `~/.dev-brain/evolution/diagnostics/<id>.json`
- [ ] 单测 `tests/unit/evolution/diagnostic-llm.test.ts`: 5 场景 (正常/超时/低质输出/不可用/含 reasoning trace)

## E.4 RuleValidator (CAP-EVO-02 双轨验证) — 含 RV-5 Goal Drift

> **v0.11.0 修订 2**: 新增 RV-5 Goal Drift Index (SAHOO + DGM 案例防护)。

- [ ] `src/evolution/rule-validator.ts` — `class RuleValidator { validateL1(d, diff?): ValidationResult; scoreL2(f): L2Score; calculateGoalDrift(diff): number }`
- [ ] Level 1 (门槛级,硬编码):
  - RV-1 rootCause 查证 (evidenceRefs 中找对应引用)
  - RV-2 逻辑一致 (rootCause 与 rationale 不自相矛盾)
  - RV-3 confidence 范围 (0.1~0.95,禁止极端值)
  - RV-4 格式完整 (schema 校验)
  - **RV-5 Goal Drift Index** (NEW): 扫描 diff 删除行,检测:
    - (a) 测试要求关键词删除 (vitest/test/case)
    - (b) 强制性措辞降级 (must/shall/必须)
    - (c) spec 引用移除 (CAP-*-*)
    - score < 0 → 拦截,写 `evolution.goal_drift_detected_total`
- [ ] Level 2 (加分级,YAML 配置): R2-1 spec 引用 / R2-2 量化指标 / R2-3 模式匹配 / R2-4 路径过滤
- [ ] 100% diagnostic 过 Level 1 (无例外)
- [ ] priority 计算: `confidence * 0.3 + L2_satisfactions * 0.1 + attribution_match * 0.4`
- [ ] 单测 `tests/unit/evolution/rule-validator.test.ts`: 6 场景 (全过/单条失败/极端 confidence/L2 加分/goalDrift 拦截/边界 score=0)

## E.5 EvalRunner + TaskPool (CAP-EVO-03 A/B Split)

### E.5.a TaskPool

- [ ] `src/evolution/task-pool.ts` — `class TaskPool { randomDraw(n): Task[]; rotate(): void; addExternal(tasks): void }`
- [ ] 初始化: 30 个固化任务 + 50+ 用户任务占位 + 20 个对抗性任务 = 100+ 池
- [ ] `tests/eval/pool/*.yaml` — 任务池存储 (含固化/对抗性/用户任务三类)
- [ ] 随机抽取: `crypto.randomUUID()` 驱动,不依赖外部熵源
- [ ] 每 2 周轮换: 随机淘汰 5 个 → 从外部池补充 5 个
- [ ] 外部池优先级: 对抗性任务 > 近期用户任务 > 手工设计
- [ ] 单测 `tests/unit/evolution/task-pool.test.ts`: 3 场景 (抽取/轮换/补充)

### E.5.b EvalRunner

- [ ] `src/evolution/eval-runner.ts` — `class EvalRunner { run(diff): Promise<EvalReport> }`
- [ ] 20 任务 × 3 次 = 60 次 eval
- [ ] 抽取逻辑: 前 5 个 = Decision Set,后 15 个 = Monitor Set (对 Evolution Service 不可见)
- [ ] 采纳条件: Decision Set +5% AND Monitor Set 下降 ≤ 3%
- [ ] 沙箱: 每个任务临时 worktree
- [ ] Monitor Set 下降 > 3% → 触发 `evolution.capability_drift` alert,阻止采纳
- [ ] 与 StateMachine (CAP-MAR-01) 联动
- [ ] timeout 5min/任务,失败标 timeout (在统计中计为 FAILED)
- [ ] Monitor Set 结果隔离: 在 EvalRunner 内部计算,不通过 API 暴露给 Evolution Service
- [ ] 单测 `tests/unit/evolution/eval-runner.test.ts`: 5 场景 (双轨通过/Decision 过 Monitor 退/超时/拒绝且 drifts/Monitor 隔离验证)

## E.6 EvolutionService + CostBudget + CircuitBreaker + FeedbackCollector

### E.6.a CostBudget (NEW — CAP-EVO-04)

- [ ] `src/evolution/cost-budget.ts` — `class CostBudgetManager { check(cost): boolean; spend(cost): void; reset(): void }`
- [ ] 每日预算默认 500K tokens (DeepSeek),env `DEV_BRAIN_EVOLUTION_DAILY_TOKEN_BUDGET` 可调
- [ ] 每次 runOnce 前置检查,预估成本 (diagnose ×5 + suggestFix ×3 + eval ×60 ≈ 68 次 DeepSeek 调用)
- [ ] 凌晨 00:00 自动 reset
- [ ] 写 `evolution.token_spent_total` / `evolution.token_budget_exceeded_total` / `evolution.daily_token_budget`
- [ ] 单测 `tests/unit/evolution/cost-budget.test.ts`: 3 场景 (正常消耗/超限跳过/跨日重置)

### E.6.b EvolutionService (CAP-EVO-04)

- [ ] `src/evolution/evolution-service.ts` — `class EvolutionService { runOnce(): Promise<RunSummary>; rollback(id): Promise<void> }`
- [ ] 完整流水线: 前置检查 (熔断 + CostBudget) → insight → diagnostic → RuleValidator L1 → suggestFix (top 3 by priority) → eval → feedback check → goalDrift check → circuit check → apply/reject
- [ ] `git apply --check` dry-run 再真 apply
- [ ] L3 write 含完整 ProvenanceChain (parentChain + diff + decisionRationale + rolledBackFrom?)
- [ ] 7 天观察期: 替换后 3 次 eval (每 24h),失败回滚
- [ ] 单测 `tests/unit/evolution/evolution-service.test.ts`: 7 场景 (完整周期成功/RV-1 拦截/eval 失败拒绝/熔断跳过/CostBudget 跳过/观察期回滚/L3 防非 evolution 写入)
- [ ] 集成测试 `tests/integration/evolution-e2e.test.ts`: 完整流程 + ProvenanceChain 验证

### E.6.c CircuitBreaker (CAP-EVO-05)

- [ ] `src/evolution/circuit-breaker.ts` — `class CircuitBreaker { isOpen(): boolean; recordResult(success: boolean): void; state(): "closed"|"half_open"|"open" }`
- [ ] 三态: closed → open (CB-1/2/3/4 触发) → half-open (24h 冷却) → 试运行 → closed/open
- [ ] 4 触发条件: CB-1 (1h 内 ≥5 reject) / CB-2 (24h 内 ≥3 rollback) / CB-3 (satisfaction < -0.5 持续 7 天) / CB-4 (24h 内 ≥3 capability_drift)
- [ ] 持久化 `~/.dev-brain/evolution/circuit-breaker-state.json`
- [ ] 每次 runOnce 前置检查熔断状态
- [ ] 单测 `tests/unit/evolution/circuit-breaker.test.ts`: 5 场景 (CB-1 触发/CB-2 触发/CB-3 触发/CB-4 触发/半开恢复/半开失败/手动重置)

### E.6.d FeedbackCollector (CAP-EVO-06)

- [ ] `src/evolution/feedback-collector.ts` — `class FeedbackCollector { record(taskId, signal): void; score(): number }`
- [ ] 飞书卡片 thumbs_up (+1) / thumbs_down (-2) / 72h 无操作 (0)
- [ ] 7 天滚动 satisfaction_score: `sum(signals) / max(total_tasks, 1)`
- [ ] satisfaction_score < -0.3 → 暂缓 prompt 采纳
- [ ] satisfaction_score < -0.5 持续 7 天 → 触发熔断 CB-3
- [ ] 单测 `tests/unit/evolution/feedback-collector.test.ts`: 3 场景 (正向/临界/触发熔断)

## E.7 L3 长期记忆 — 含 ProvenanceChain

- [ ] `src/evolution/l3-memory.ts` — `class L3LongTermMemory { read(); write(entry, opts?) }`
- [ ] write 默认拒绝非 evolution 调用,`--force` 标志打审计
- [ ] 落 `~/.dev-brain/l3-memory/prompts/<id>.json`,含:
  - `evolved_at` / `eval_pass_rate` / `parent_id` / `satisfaction_score_at_evolve`
  - `provenance.parentChain[]` / `provenance.diff` / `provenance.decisionRationale` / `provenance.rolledBackFrom?` (NEW)
- [ ] 回滚时标 `entry.status="rolled_back"`,保留 provenance 链不删除
- [ ] 单测 `tests/unit/evolution/l3-memory.test.ts`: 4 场景 (正常写入/非 evolution 拒绝/force 写入审计/回滚标记)

## E.8 CLI 入口

- [ ] `./cli evolve --once` — 单次跑,stdout 报告 (含 circuit 状态 / satisfaction 分数 / token 预算剩余)
- [ ] `./cli evolve --daemon` — 6h 周期,SIGTERM 优雅退出
- [ ] `./cli prompt revert <id>` — 手动回滚 (git revert + L3 标记)
- [ ] `./cli prompt list` — 列 active + rejected + quarantined prompts (含 provenance 摘要)
- [ ] `./cli prompt show <id>` — 展示完整 ProvenanceChain (parent chain + decision rationale)
- [ ] `./cli evolve --reset-circuit-breaker` — 手动重置熔断器 (写 audit)
- [ ] `./cli evolve --budget-status` — 查看当日 token 预算消耗情况 (NEW)
- [ ] `tests/unit/cli-evolve.test.ts` + `tests/unit/cli-prompt.test.ts`

## E.9 Grafana + 文档

- [ ] Grafana panel "Evolution Pipeline (v0.11.0)": 熔断器状态 + satisfaction 趋势 + A/B pass rate + 采纳/拒绝趋势 + token 预算剩余 + provenance_chain_depth
- [ ] `docs/evolution.md` (新) — 流程图 + 博弈论设计原理 + 行业对标 (DSPy/GReaTer/SAHOO/DGM) + 评测套件说明 + 熔断器操作 + 回滚指南
- [ ] `docs/USAGE.md` (扩) — 加 "prompt 回滚" + "熔断器操作" + "Self-Correction 调试" 章
- [ ] `tests/unit/ops-files.test.ts` panel 数更新

## E.10 验证

- [ ] `pnpm typecheck` 绿
- [ ] `pnpm test` 绿 (self-evolution 模块新增 ~45 测试场景)
- [ ] `pnpm test:coverage` 维持 85%/74%
- [ ] E2E: 跑 1 次完整 evolution,验证:
  - prompt 被替换 + 旧版本留底
  - L3 落库含完整 ProvenanceChain
  - 熔断器正常
  - CostBudget 正常消耗记录
- [ ] 手动 revert 验证: `./cli prompt revert <id>` → git revert + provenance 标记
- [ ] 熔断器场景测试: 连续 reject (CB-1) → 熔断 open → 24h → half-open → 试运行 → closed
- [ ] 用户反馈场景: satisfaction_score < -0.3 → 暂缓采纳
- [ ] Goal Drift 场景: 构造含测试要求删除的 diff → RV-5 拦截 → `evolution.goal_drift_detected_total` +1
- [ ] CostBudget 场景: 模拟超限 → runOnce 返回 skipped

## 集成

### 与 Phase D (CodeHealth) 集成

- [ ] `src/evolution/insight-engine.ts` — 接收 `CodeHealthForEvolution` 作为第 1 类输入 (codeHealth)
- [ ] topIssues 直接映射为 insight 候选 (dead_exports ↑ → "清理死代码" / complexity ↑ → "重构危险函数" / zombies ↑ → "清理僵尸文件")

### 与 Phase F (Context/Runtime) 集成

- [ ] L1FailureTrace 扩展: `agentReasoning?: string` 从 agent stdout 解析 `<thinking>` 标签内容 (CAP-MAR-04 联动)
- [ ] EvalRunner 与 StateMachine (CAP-MAR-01) 联动: 每个 eval 任务状态迁移
- [ ] FeedbackCollector 与 TaskDoneCard (CAP-COM-04) 联动: 卡片按钮 → feedback signal

### 与 Grafana 集成

- [ ] ~25 metric 全部在 Grafana panel "Evolution Pipeline (v0.11.0)" 渲染
