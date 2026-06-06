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

> **目标:** 跑 4 项分析器,产出每日 `CodeHealthSnapshot`,上报 4 gauge metric。
> 阻塞 Phase E 的 evolution(没有 snapshot 数据,insight 引擎产不出"代码侧"建议)。

### D.1 依赖 + 类型骨架

- [ ] `pnpm add -D ts-morph escomplex` (jscpd 走子进程,无需安装)
- [ ] `src/observability/code-health/types.ts` 定义 `AstSnapshot` / `DeadcodeReport` / `ZombieReport` / `CodeHealthSnapshot`
- [ ] `src/observability/metrics.ts` 注册 4 新 gauge: `code.dead_exports` / `code.complexity_p95` / `code.duplication_pct` / `code.zombie_files`
- [ ] 1 counter: `code.ast.parse_failed_total{file}`

### D.2 AstAnalyzer (CAP-CODE-01)

- [ ] `src/observability/code-health/ast-analyzer.ts` — `class AstAnalyzer { parse(sources): Promise<AstSnapshot> }`
- [ ] 用 `ts-morph` 解析 .ts,产出 `files[]` / `functions[]` / `exports[]`
- [ ] 失败兜底:语法错文件单独 catch,产出 `{ path, error }` + 写 `code.ast.parse_failed_total`
- [ ] mtime 缓存: `~/.dev-brain/code-health/ast-cache-<hash>.json`,基于文件 mtime 失效
- [ ] 性能: 单文件 < 500ms (P95)
- [ ] 单测 `tests/unit/code-health/ast-analyzer.test.ts`: 5 个 case (含语法错文件、缓存命中)

### D.3 DeadcodeFinder (CAP-CODE-02)

- [ ] `src/observability/code-health/deadcode-finder.ts` — 找 0 references 的 export
- [ ] 豁免: 测试文件 (`*.test.ts` / `__tests__/`) + 入口 `src/index.ts`
- [ ] 准确率 ≥ 90% (人工 spot-check 20 样本)
- [ ] 动态 import 误报: 写 `code.deadcode.dynamic_import_missed_total` + 提示 `// @keepalive`
- [ ] 7 天内新增文件豁免(避免新 API 误判)
- [ ] 单测 `tests/unit/code-health/deadcode-finder.test.ts`: 含 fixture (legacy-helper + 动态 import)

### D.4 ComplexityReporter + DuplicationScanner (CAP-CODE-03)

- [ ] `src/observability/code-health/complexity-reporter.ts` — `escomplex` 算圈复杂度
- [ ] 阈值默认 15,env `DEV_BRAIN_COMPLEXITY_DANGER=15` 可调
- [ ] `src/observability/code-health/duplication-scanner.ts` — spawn `jscpd` 子进程,解析 JSON
- [ ] jscpd 路径探测: `node_modules/.bin/jscpd` → 全局 `jscpd` → fallback 写 `code.duplication_scan_failed_total` + duplication_pct=-1
- [ ] 单测 `tests/unit/code-health/complexity-reporter.test.ts` (mock escomplex)
- [ ] 单测 `tests/unit/code-health/duplication-scanner.test.ts` (mock spawn)

### D.5 ZombieDetector (CAP-CODE-04)

- [ ] `src/observability/code-health/zombie-detector.ts` — 4 条件全满足才标 zombie: >90 天未改 / 无测试 / deadExports 含其导出 / LOC > 50
- [ ] 复用 `git log -1 --format=%ct <file>` 拿最后改动时间
- [ ] 测试覆盖判定: 反向扫描 `tests/**/*.test.ts` 找 import
- [ ] env `DEV_BRAIN_ZOMBIE_DAYS=90` 可调
- [ ] 单测 `tests/unit/code-health/zombie-detector.test.ts`: 4 场景 (命中/活跃/LOC 过滤/无测试)

### D.6 Snapshot 打包 (集成)

- [ ] `src/observability/code-health/snapshot.ts` — `CodeHealthSnapshot.build(projectRoot)`
- [ ] 顺序跑 5 步,异常隔离 (jscpd 失败不影响其他)
- [ ] 落 `~/.dev-brain/code-health/<YYYY-MM-DD>.json`
- [ ] cron 每日 02:00 触发
- [ ] 写 `code.snapshot.taken_total` / `code.snapshot.failed_total` / `code.snapshot.partial_total`
- [ ] 单测 `tests/unit/code-health/snapshot.test.ts`: 完整路径 + jscpd 失败 partial

### D.7 Grafana + 文档

- [ ] `ops/grafana/dev-brain-dashboard.json` 加 panel "Code Health (v0.11.0)",4 个 metric
- [ ] `docs/code-health.md` (新) — 4 项观测含义 + 5 个 Playbook
- [ ] `docs/observability.md` (扩) — 加 5 个新 metric 含义
- [ ] `tests/unit/ops-files.test.ts` 更新 panel 数量断言 (17 → 18)

### D.8 验证

- [ ] `pnpm typecheck` 绿
- [ ] `pnpm test` 绿 (561 → ~600 测试)
- [ ] `pnpm test:coverage` 维持 85%/74%
- [ ] 实跑 `CodeHealthSnapshot.build(dev-brain/)` 验证产出 + metric 上报
- [ ] jscpd 未装时 graceful skip,partial_total 写入

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

### F.1 通信层 (CAP-COM-01..04)

#### F.1.a StreamingPusher (CAP-COM-01)

- [ ] `src/gateway/streaming-pusher.ts` — 单例,持 `Map<planMessageId, Buffer>`
- [ ] 节流 200ms,合并相邻内容
- [ ] 卡片用 `updateCard` 而非 `sendCard`
- [ ] 飞书 API 4xx/5xx backoff 500ms 重试 1 次
- [ ] 写 `gateway.streaming.push_failed_total`
- [ ] 任务结束 state="done" 一次性 flush
- [ ] 单测 `tests/unit/gateway/streaming-pusher.test.ts`: 4 场景 (节流合并/失败重试/flush/超时)

#### F.1.b SignatureVerifier (CAP-COM-02)

- [ ] `src/gateway/signature-verifier.ts` — HMAC-SHA256,常时间比较
- [ ] secret 优先级: env `DEV_BRAIN_FEISHU_VERIFICATION_TOKEN` > `~/.dev-brain/secret` > fail-fast
- [ ] daemon 启动时 secret 缺失立即 exit 2
- [ ] 写 `gateway.signature.verified_total` / `gateway.signature.rejected_total`
- [ ] 强制化: v0.9.0 已有 URL 验签,本 spec 把 card.action 等回调也强制化
- [ ] 单测 `tests/unit/gateway/signature-verifier.test.ts`: 4 场景

#### F.1.c MultimodalParser (CAP-COM-03)

- [ ] `src/gateway/multimodal-parser.ts` — 3 子 parser: image OCR / file download / PR link
- [ ] MiniMax vision 走 native 通道 (复用 v0.8.0 backend)
- [ ] GitHub 链接走 `gh pr view` 子进程
- [ ] 附件落 `~/.dev-brain/attachments/`,不污染 workDir
- [ ] OCR 置信度 < 0.7 标 `ocr_low_confidence: true`
- [ ] 整链路 trace_id 贯穿
- [ ] 单测 `tests/unit/gateway/multimodal-parser.test.ts`: 4 场景 (图片/文件/PR/低置信度)

#### F.1.d TaskDoneCard (CAP-COM-04)

- [ ] `src/gateway/task-done-card.ts` — `buildTaskDoneCard(task, artifacts): Card`
- [ ] 6 字段: summary / changes / tests / artifacts / trace_id (+ 1 状态色)
- [ ] changes 从 `git diff --stat HEAD~1 HEAD` 拿
- [ ] 长输出 (> 28KB) 走 `card-degrader` 三段降级 (v0.9.0 已有)
- [ ] 失败时 summary 含可读错误摘要 (从 stderr 抽关键行)
- [ ] 原地 update 而非 send
- [ ] 单测 `tests/unit/gateway/task-done-card.test.ts`: 3 场景 (success/fail/长输出)

### F.2 上下文引擎 (CAP-CTX-01..04)

> 详细任务见 `specs/context-engine/tasks.md`。核心交付:
> - 类型骨架 (types.ts) + 三层记忆 (L1/L2/L3) + TTL 管理
> - SleeptimeContextAgent (替代 DeliberateCompressor) — 5 步认知操作 + 4 种触发
> - RecallStrategy — 复合评分 (TF-IDF + recency + importance)
> - InjectPlan — token 预算分配 (80K 总预算, 7 级优先级)
> - 删除 `src/context/compressor.ts`
> - 新增 ~7 测试文件 (~30 场景)

### F.3 多 Agent 运行时 (CAP-MAR-01..05)

#### F.3.a StateMachine (CAP-MAR-01)

- [ ] `src/runtime/state-machine.ts` — `class SubtaskStateMachine { transition(); canTransition() }`
- [ ] 状态: `pending | running | retrying | success | failed | cancelled` (discriminated union)
- [ ] 6 个 ALLOWED 迁移边
- [ ] 非法迁移抛 `IllegalStateTransitionError`
- [ ] 写 `runtime.subtask.state_transition_total{from,to}` / `runtime.subtask.illegal_transition_total{from,to}`
- [ ] 持久化:每次 transition 写 checkpoint
- [ ] 替换 v0.10.0 orchestrator.ts 里散落的 `if (status === "running") ...`
- [ ] 单测 `tests/unit/runtime/state-machine.test.ts`: 5 场景 (正常/重试/非法/取消/重置)

#### F.3.b SandboxManager (CAP-MAR-02)

- [ ] `src/runtime/sandbox.ts` — `class SandboxManager { enter(); exit(); rollback() }`
- [ ] 执行前 `git stash push -u -m "sandbox-<taskId>"`
- [ ] 执行中 cwd=workDir,git status 监控 diff
- [ ] 成功 exit: 保留 commit/stash
- [ ] 失败 exit: `git checkout -- .` + `git clean -fd` + `git stash pop`
- [ ] 冲突时 reject 派发,任务 FAILED
- [ ] 写 `runtime.sandbox.rollback_total`
- [ ] 与 checkpoint 联动
- [ ] 单测 `tests/unit/runtime/sandbox.test.ts`: 4 场景 (成功提交/失败回滚/冲突拒绝/无修改)

#### F.3.c HeartbeatWatcher (CAP-MAR-03)

- [ ] `src/runtime/heartbeat.ts` — `class HeartbeatWatcher { start(); stop() }`
- [ ] 解析 `__dev_brain_heartbeat__ <progress>50</progress>` token
- [ ] 连续 2 个周期 (>60s) 未更新 → cancel + 标 FAILED
- [ ] 阈值 env `DEV_BRAIN_HEARTBEAT_MISSES` 可调
- [ ] 写 `runtime.heartbeat.received_total` / `runtime.heartbeat.lost_total`
- [ ] adapter 包装层解析 stdout
- [ ] 单测 `tests/unit/runtime/heartbeat.test.ts`: 4 场景 (正常/丢失/自定义阈值/无 token)

#### F.3.d SelfCorrector + AttributionEngine (CAP-MAR-04)

- [ ] `src/runtime/attribution-engine.ts` — `class AttributionEngine { analyze(trace: L1FailureTrace): Attribution }`
- [ ] L1 可信源 5 字段: specRef / gitDiff / acceptance / heartbeat / sandbox
- [ ] 归因规则: missing_test / spec_violation / timeout / lint_error / type_error / unattributable
- [ ] 与 CAP-EVO-01 联动: attribution 数据作为 insight-engine 的第四类输入
- [ ] 单测 `tests/unit/runtime/attribution-engine.test.ts`: 4 场景

- [ ] `src/runtime/self-correction.ts` — `class SelfCorrector { attribute(); triage(); correct() }`
- [ ] 3 步流程: Step 1 归因 (attribution-engine) → Step 2 分流 (修复/进化/升级) → Step 3 修复执行 (仅修复路径)
- [ ] 修复路径: 偶发失败 (hf < 5%) → 重写 prompt + 重试,最多 2 次
- [ ] 进化路径: 系统失败 (hf ≥ 5%) → 产出 Insight 进 Evolution Pipeline,不自动重试
- [ ] 升级路径: 不可恢复 (401) / 能力边界 → 升级用户
- [ ] unattributable → 待观察队列,积累 ≥ 5 条同 pattern 重新归因
- [ ] 写 `runtime.self_correction.triage_total{path}` / `runtime.self_correction.unattributable_queue_size`
- [ ] 单测 `tests/unit/runtime/self-correction.test.ts`: 5 场景 (修复/进化/升级/unattributable/N 次上限)

#### F.3.e AcceptancePipeline (CAP-MAR-05)

- [ ] `src/runtime/acceptance-pipeline.ts` — 4 阶段: unit test / lint / typecheck / reviewer agent
- [ ] 任一失败 → subtask FAILED with reason
- [ ] 全过 → SUCCESS,触发 TaskDoneCard (CAP-COM-04)
- [ ] 复用 HeartbeatWatcher 监控 acceptance 子进程
- [ ] Reviewer agent 走 v0.8.0 native backend
- [ ] 写 `runtime.acceptance.{stage}_total{result}`
- [ ] 5min timeout
- [ ] 单测 `tests/unit/runtime/acceptance-pipeline.test.ts`: 4 场景

### F.4 集成到 brain-engine

- [ ] `src/brain/brain-engine.ts` — 接入 recall-strategy + inject-plan (见 `specs/context-engine/tasks.md` 集成部分) + evolution-service (E.5) + acceptance-pipeline (F.3.e)
- [ ] `src/context/context-budget.ts` (v0.10.0) — `maybeSummarise()` 优先走 Sleeptime Agent (T3),不可用时退到原有 summarise 逻辑; 超 80K 硬上限走 T4 前台兜底
- [ ] `src/runtime/orchestrator.ts` — 替换 ad-hoc retry 为 state-machine (F.3.a) + self-correction (F.3.d)
- [ ] `src/gateway/feishu-gateway.ts` — 接入 streaming-pusher (F.1.a) + signature-verifier (F.1.b) + multimodal-parser (F.1.c) + task-done-card (F.1.d)
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
