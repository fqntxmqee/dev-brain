---
demand-id: DM-20260606-003
change: ai-native-os
status: developing
target-version: v0.11.0
---

# ai-native-os — Tasks

> **3 phases, 4 components, ~21 new files, ~610 测试, 4 周**
>
> - **Phase D** — Code Observability (1 周) — 给 E 铺数据
> - **Phase E** — Self-Evolution (2 周) — "AI 驱动 AI" 核心
> - **Phase F** — Communication + Context + Multi-Agent (2 周) — UX + 鲁棒性

## Phase D — Code Observability (P0, Week 1)

> 详细任务见 `specs/code-observability/tasks.md`。核心交付:
> - AstAnalyzer (ts-morph + worker_thread 隔离) — CAP-CODE-01
> - DeadcodeDetector (KnipAdapter 入口驱动图主路径 + DeadcodeFinder 降级) — CAP-CODE-02
> - ComplexityReporter + DuplicationScanner (可插拔后端 + CRAP + 认知复杂度) — CAP-CODE-03
> - ZombieDetector 加权评分 + HotspotScorer (CodeScene 风格) + AICodeSmellDetector — CAP-CODE-04
> - SnapshoDelta 增量比较 + CodeHealthForEvolution 数据契约
> - 新增 ~28 测试场景 (~8 测试文件)

---

## Phase E — Self-Evolution (P0, Week 2-3)

> **目标:** 跑完整闭环 (insight → diagnostic → RuleValidator → eval → feedback check → circuit check → replace),落 L3 长期记忆。
> 核心 KPI: 自我进化 prompt 被采纳率 30~70%, 一次 self-correction 成功率 ≥ 40%。
> **v0.11.0 修订**: 增加 RuleValidator (E.4), TaskPool (E.5.a), CircuitBreaker (E.6.a), FeedbackCollector (E.6.b)。

### E.1 依赖 + 类型骨架

- [ ] `pnpm add -D ts-morph escomplex` (jscpd 走子进程,无需安装)
- [ ] `src/evolution/types.ts` 定义 `Insight` / `Diagnostic` / `Fix` / `ValidationResult` / `EvalResult` / `EvolutionRun` / `L1FailureTrace` / `Attribution`
- [ ] `src/observability/metrics.ts` 注册 evolution 全系列 metric (~15 个,含 circuit_breaker.state / satisfaction_score / ab_pass_rate 等)
- [ ] 加 `l3.manual_write_denied_total`
- [ ] `config/rule-validator.yaml` — RuleValidator Level 2 规则初始配置

### E.2 InsightEngine (CAP-EVO-01)

- [ ] `src/evolution/insight-engine.ts` — `class InsightEngine { run(): Promise<Insight[]> }`
- [ ] 输入: `codeHealth` snapshot (近 7 天) + `failures` JSONL + `attribution` 数据 (来自 CAP-MAR-04)
- [ ] 4 category 分类启发式 (context / spec / prompt / agent-stability)
- [ ] 7 天内同 category 去重
- [ ] 数据不足 (< 3 trace) 跳过,记 metric
- [ ] 落 `~/.dev-brain/evolution/insights-<date>.json`
- [ ] 单测 `tests/unit/evolution/insight-engine.test.ts`: 4 场景 (聚合/去重/数据不足/分类正确)

### E.3 DiagnosticLLM (CAP-EVO-02)

- [ ] `src/evolution/diagnostic-llm.ts` — 两阶段分离式调用:
  - 阶段 1: `diagnose(insight) → Diagnostic { insightId, rootCause, rationale, confidence }` (不输出 fix)
  - 阶段 2: `suggestFix(diagnostic) → Fix { fix, diff?, specRefs[] }` (仅被采纳后调用)
- [ ] 复用 v0.10.0 DeepSeek client
- [ ] DeepSeek 不可用 graceful skip
- [ ] 落 `~/.dev-brain/evolution/diagnostics/<id>.json`
- [ ] 单测 `tests/unit/evolution/diagnostic-llm.test.ts`: mock DeepSeek,4 场景 (正常/超时/低质输出/不可用)

### E.4 RuleValidator (CAP-EVO-02 双轨验证)

- [ ] `src/evolution/rule-validator.ts` — `class RuleValidator { validateL1(d: Diagnostic): ValidationResult; scoreL2(f: Fix): L2Score }`
- [ ] Level 1 (门槛级,硬编码): RV-1 rootCause 查证 / RV-2 逻辑一致 / RV-3 confidence 范围 / RV-4 格式完整
- [ ] Level 2 (加分级,YAML 配置): R2-1 spec 引用 / R2-2 量化指标 / R2-3 模式匹配 / R2-4 路径过滤
- [ ] 100% diagnostic 过 Level 1 (无例外)
- [ ] priority 计算: `confidence * 0.3 + L2_satisfactions * 0.1 + attribution_match * 0.4`
- [ ] 单测 `tests/unit/evolution/rule-validator.test.ts`: 4 场景 (全过/单条失败/极端 confidence/L2 加分)

### E.5 EvalRunner + TaskPool (CAP-EVO-03 A/B Split)

#### E.5.a TaskPool

- [ ] `src/evolution/task-pool.ts` — `class TaskPool { randomDraw(n): Task[]; rotate(): void; addExternal(tasks): void }`
- [ ] 初始化: 30 个固化任务 + 50+ 用户任务占位 + 20 个对抗性任务 = 100+ 池
- [ ] `tests/eval/pool/*.yaml` — 任务池存储
- [ ] 随机抽取: `crypto.randomUUID()` 驱动,不依赖外部熵源
- [ ] 每 2 周轮换: 随机淘汰 5 个 → 从外部池补充 5 个
- [ ] 外部池优先级: 对抗性任务 > 近期用户任务 > 手工设计
- [ ] 单测 `tests/unit/evolution/task-pool.test.ts`: 3 场景 (抽取/轮换/补充)

#### E.5.b EvalRunner

- [ ] `src/evolution/eval-runner.ts` — 20 任务 × 3 次 = 60 次 eval
- [ ] 抽取逻辑: 前 5 个 = Decision Set,后 15 个 = Monitor Set (对 Evolution Service 不可见)
- [ ] 采纳条件: Decision Set +5% AND Monitor Set 下降 ≤ 3%
- [ ] 沙箱: 每个任务临时 worktree
- [ ] Monitor Set 下降 > 3% → 触发 `capability_drift` alert,阻止采纳
- [ ] 与 StateMachine (CAP-MAR-01) 联动
- [ ] timeout 5min/任务,失败标 timeout
- [ ] 单测 `tests/unit/evolution/eval-runner.test.ts`: 4 场景 (双轨通过/Decision 过 Monitor 退/超时/拒绝且 drifts)

### E.6 EvolutionService + CircuitBreaker + FeedbackCollector

#### E.6.a EvolutionService (CAP-EVO-04)
- [ ] `src/evolution/evolution-service.ts` — `class EvolutionService { runOnce(): Promise<RunSummary>; rollback(id): Promise<void> }`
- [ ] 完整流水线: insight → diagnostic → RuleValidator L1 → suggestFix (top 3 by priority) → eval → feedback check → circuit check → apply/reject
- [ ] `git apply --check` dry-run 再真 apply
- [ ] 7 天观察期: 替换后 3 次 eval,失败回滚
- [ ] 单测 `tests/unit/evolution/evolution-service.test.ts`: 5 场景
- [ ] 集成测试 `tests/integration/evolution-e2e.test.ts`: 完整流程

#### E.6.b CircuitBreaker (CAP-EVO-05)
- [ ] `src/evolution/circuit-breaker.ts` — `class CircuitBreaker { isOpen(): boolean; recordResult(success: boolean): void }`
- [ ] 三态: closed → open (连续 reject/rollback/满意度低/能力退化) → half-open (24h 冷却) → 试运行 → closed/open
- [ ] 持久化 `~/.dev-brain/evolution/circuit-breaker-state.json`
- [ ] 每次 runOnce 前置检查熔断状态
- [ ] 单测 `tests/unit/evolution/circuit-breaker.test.ts`: 4 场景 (触发/半开恢复/半开失败/手动重置)

#### E.6.c FeedbackCollector (CAP-EVO-06)
- [ ] `src/evolution/feedback-collector.ts` — `class FeedbackCollector { record(taskId, signal): void; score(): number }`
- [ ] 飞书卡片 thumbs_up (+1) / thumbs_down (-2) / 72h 无操作 (0)
- [ ] 7 天滚动 satisfaction_score
- [ ] satisfaction_score < -0.3 → 暂缓 prompt 采纳
- [ ] satisfaction_score < -0.5 持续 7 天 → 触发熔断 CB-3
- [ ] 单测 `tests/unit/evolution/feedback-collector.test.ts`: 3 场景 (正向/临界/触发熔断)

### E.7 L3 长期记忆

- [ ] `src/evolution/l3-memory.ts` — `class L3LongTermMemory { read(); write(entry, opts?) }`
- [ ] write 默认拒绝非 evolution 调用,`--force` 标志打审计
- [ ] 落 `~/.dev-brain/l3-memory/prompts/<id>.json`,含 `evolved_at` / `eval_pass_rate` / `parent_id` / `satisfaction_score_at_evolve`

### E.8 CLI 入口

- [ ] `./cli evolve --once` — 单次跑,stdout 报告 (含 circuit/satisfaction 状态)
- [ ] `./cli evolve --daemon` — 6h 周期,SIGTERM 优雅退出
- [ ] `./cli prompt revert <id>` — 手动回滚
- [ ] `./cli prompt list` — 列 active + rejected + quarantined prompts
- [ ] `./cli evolve --reset-circuit-breaker` — 手动重置熔断器
- [ ] `tests/unit/cli-evolve.test.ts` + `tests/unit/cli-prompt.test.ts`

### E.9 Grafana + 文档

- [ ] Grafana panel "Evolution Pipeline (v0.11.0)": 熔断器状态 + satisfaction 趋势 + A/B pass rate + 采纳/拒绝趋势
- [ ] `docs/evolution.md` (新) — 流程图 + 博弈论设计原理 + 评测套件说明 + 熔断器操作 + 回滚指南
- [ ] `docs/USAGE.md` (扩) — 加 "prompt 回滚" + "熔断器操作" + "Self-Correction 调试" 章
- [ ] `tests/unit/ops-files.test.ts` panel 数更新

### E.10 验证

- [ ] `pnpm typecheck` 绿
- [ ] `pnpm test` 绿 (600 → ~680 测试)
- [ ] `pnpm test:coverage` 维持 85%/74%
- [ ] E2E: 跑 1 次完整 evolution,验证 prompt 被替换 + 旧版本留底 + L3 落库 + 熔断器正常
- [ ] 手动 revert 验证 git revert 路径
- [ ] 熔断器场景测试: 连续 reject → 熔断 open → 24h → half-open → 试运行
- [ ] 用户反馈场景测试: satisfaction_score < -0.3 → 暂缓采纳

---

## Phase F — Comm / Context / Multi-Agent (P1, Week 3-4)

> **目标:** 通信层流式 + 鉴权 + 多模态; 上下文 L1/L2/L3 分层 + recall; 多 Agent FSM + 沙箱 + 心跳 + self-correction + 验收。
> 3 个并行子 phase, 各 ~5 天。

### F.1 通信层 (CAP-COM-01..05)

> 详细任务见 `specs/communication-layer/tasks.md`。核心交付:
> - 结构化事件流 (5 种 CommunicationEvent) + CardKit v2.0 流式卡片
> - 层级可见性 (Header/Content/Collapse 三层)
> - 阶段总结 (5 个阶段 Summary) + 多 Agent 身份区分
> - 签名鉴权 + 多模态 (基本不变)
> - 新增 ~8 测试文件 (~28 场景)

### F.2 上下文引擎 (CAP-CTX-01..04)

> 详细任务见 `specs/context-engine/tasks.md`。核心交付:
> - 类型骨架 (types.ts) + 三层记忆 (L1/L2/L3) + TTL 管理
> - SleeptimeContextAgent (替代 DeliberateCompressor) — 5 步认知操作 + 4 种触发
> - RecallStrategy — 复合评分 (TF-IDF + recency + importance)
> - InjectPlan — token 预算分配 (80K 总预算, 7 级优先级)
> - 删除 `src/context/compressor.ts`
> - 新增 ~7 测试文件 (~30 场景)

### F.3 多 Agent 运行时 (CAP-MAR-01..05)

> 详细任务见 `specs/multi-agent-runtime/tasks.md`。核心交付:
> - StateMachine + CheckpointStore (JSON 持久化, crash 可恢复) — CAP-MAR-01
> - 双保险沙箱 (PreFlight 校验 + 双路径回滚: stash pop → git reset --hard 兜底) + SandboxGuarantee 等级 — CAP-MAR-02
> - 结构化心跳 (phase/progressPct/currentTool) + 停滞检测 + ProgressEvent 联动 — CAP-MAR-03
> - L1 归因 + Wink 3 类 misbehavior 双层分类 + 分流决策 (修复/进化/升级) — CAP-MAR-04
> - 分层验收金字塔 (FastGate → CoreGate → ReviewGate 非阻塞) — CAP-MAR-05
> - 新增 ~25 测试场景 (~8 测试文件)

### F.4 集成到 brain-engine

- [ ] `src/brain/brain-engine.ts` — 接入 recall-strategy + inject-plan (见 `specs/context-engine/tasks.md` 集成部分) + evolution-service (E.5) + acceptance-pipeline (F.3.e)
- [ ] `src/context/context-budget.ts` (v0.10.0) — `maybeSummarise()` 优先走 Sleeptime Agent (T3),不可用时退到原有 summarise 逻辑; 超 80K 硬上限走 T4 前台兜底
- [ ] `src/runtime/orchestrator.ts` — 替换 ad-hoc retry 为 state-machine (F.3.a) + self-correction (F.3.d)
- [ ] `src/gateway/feishu-gateway.ts` — 接入 CardKit v2.0 流式卡片 + EventBus (见 `specs/communication-layer/tasks.md` 集成部分)
- [ ] 集成测试 `tests/integration/full-loop.test.ts`: 飞书消息 → 多模态 → debate → OpenSpec → 子任务 (含 self-correction) → 验收 → 完成卡

### F.5 验证

- [ ] `pnpm typecheck` 绿
- [ ] `pnpm test` 绿 (~650 → ~750 测试, 预计 561 → ~750)
- [ ] `pnpm test:coverage` 维持 85%/74%
- [ ] 飞书 E2E: 发图片 + PR 链接 → 看到多模态解析 + 流式思考 + 完成卡
- [ ] Self-correction 一次成功率 ≥ 40% (在 eval suite 测)
- [ ] 心跳误杀率 < 1% (1000 任务统计)
- [ ] 沙箱回滚成功率 100%

---

## Cross-cutting (跨 phase)

- [ ] `src/config/env.ts` 加新 env: `DEV_BRAIN_SANDBOX_ENABLED` / `DEV_BRAIN_HEARTBEAT_MISSES` / `DEV_BRAIN_COMPLEXITY_DANGER=15` / `DEV_BRAIN_ZOMBIE_DAYS=90` / `DEV_BRAIN_REVIEWER_ENABLED` / `DEV_BRAIN_EVAL_THRESHOLD_PCT=5` / `DEV_BRAIN_FEISHU_VERIFICATION_TOKEN` / `DEV_BRAIN_CIRCUIT_BREAKER_COOLDOWN_HOURS=24` / `DEV_BRAIN_SATISFACTION_THRESHOLD=-0.3` / `DEV_BRAIN_MONITOR_DRIFT_THRESHOLD=-3` / `DEV_BRAIN_SELF_CORRECTION_MAX_ATTEMPTS=2` / `DEV_BRAIN_EVAL_POOL_MIN_SIZE=100` / `DEV_BRAIN_RECALL_SEMANTIC_WEIGHT=0.4` / `DEV_BRAIN_RECALL_RECENCY_WEIGHT=0.3` / `DEV_BRAIN_RECALL_IMPORTANCE_WEIGHT=0.3` / `DEV_BRAIN_L2_WARN_TOKENS=50000` / `DEV_BRAIN_L2_MAX_TOKENS=80000` / `DEV_BRAIN_INJECT_BUDGET_TOTAL=80000` / `DEV_BRAIN_INJECT_BUDGET_RECALL=4000`
- [ ] `package.json` 加 2 prod dep: `ts-morph` `escomplex` (jscpd 走子进程,只 dev 装)
- [ ] `CHANGELOG.md` v0.11.0 entry: "AI Native OS: code observability + self-evolution (with circuit breaker & user feedback) + comm/ctx/multi-agent enhancements"
- [ ] `README.md` 更新: 新功能章节 + 配置 env 列表 + 博弈论设计原理简介

## Final 验证 (全 phase 完成后)

- [ ] `pnpm typecheck` 绿
- [ ] `pnpm test` 绿 (预计 561 → ~750 测试)
- [ ] `pnpm test:coverage` stmt ≥ 85%, branch ≥ 74%
- [ ] `./cli doctor` 全绿
- [ ] Grafana 新 panel 渲染正常 (Code Health + Evolution Pipeline + 熔断器状态 + 用户满意度)
- [ ] 飞书 E2E 完整链路: 飞书消息 → 多模态 → debate → OpenSpec → 子任务执行 → 验收 → 完成卡 (含 thumbs 反馈)
- [ ] 自我进化 1 次: 跑 evolution-service,验证 RuleValidator → A/B Split → prompt 替换 + L3 落库 + 7 天观察期
- [ ] 熔断器场景: 连续 reject → open → 24h → half-open → 试运行 → closed
- [ ] 用户反馈场景: satisfaction_score 变化 → 影响采纳决策
- [ ] Acceptance criteria 18 项指标全部达标 (见 proposal.md 表格)
