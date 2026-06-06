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

> 详细任务见 `specs/self-evolution/tasks.md`。核心交付:
> - InsightEngine (失败 + 成功双信号,含 Success Pattern Mining) — CAP-EVO-01
> - DiagnosticLLM (两阶段分离 + Reasoning Trace) + RuleValidator (5 条 Level 1 规则含 RV-5 Goal Drift Index) — CAP-EVO-02
> - EvalRunner (A/B Split, Decision 5 + Monitor 15) + TaskPool (100+ 池) — CAP-EVO-03
> - EvolutionService (完整 pipeline + CostBudget + ProvenanceChain) + CostBudget (NEW) — CAP-EVO-04
> - CircuitBreaker (三态 + 4 触发条件) — CAP-EVO-05
> - FeedbackCollector (thumbs + 7 天滚动 satisfaction) — CAP-EVO-06
> - L3 长期记忆 (含完整 ProvenanceChain) + CLI 入口 + Grafana + 文档
> - 新增 ~45 测试场景 (~10 测试文件)

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
