---
demand-id: DM-20260606-003
change: ai-native-os
status: developing
---

# Self-Evolution Spec (Delta — v0.11.0)

本文为 AI Native OS 引入 4 项自我进化能力: insight 聚合 → LLM 诊断 → 评测回归 → 替换落库。
v0.10.0 已有 audit.log 记录所有失败 trace,但缺人/AI 复盘机制;本 spec 把"失败 → 修复"做成闭环。

## CAP-EVO-01 (NEW) Insight 聚合引擎

**Given** CodeHealthSnapshot (Phase D) + 失败 trace JSONL (`~/.dev-brain/failures/failures-YYYY-MM-DD.jsonl`)
**When** InsightEngine 周期任务触发(每 6h 一次,cron)
**Then** 拉最近 7 天数据,聚合产出 `Insight` 候选列表:
  - 分类四类: `context` (召回不足) / `spec` (规范不清) / `prompt` (模板不优) / `agent-stability` (超时/沙箱失败)
  - 每条 insight 含: `{ id, category, summary, evidenceRefs[], severity: low|med|high, suggestedFix }`
  - 优先级: severity × 频次 = score,取 top 10
**And** 写 `evolution.insights_produced_total` +N (N = produced),`evolution.insights_applied_total` 后续在 EVO-04 落库时计
**And** 7 天内同 category 重复 insight 去重(避免刷屏)

**实现要点:**
- `src/evolution/insight-engine.ts` — `class InsightEngine { run(): Promise<Insight[]>; }`
- 输入: `codeHealth` snapshot (最近 7 天) + `failures` JSONL (按 trace_id 聚合)
- 分类启发式:
  - `context`: 失败 trace 中含 "missing context" / "不知道" / "上下文" 关键词
  - `spec`: OpenSpec acceptance 阶段有 "not implemented" / "missing field"
  - `prompt`: 同一 prompt 模板 7 天失败 ≥ 3 次
  - `agent-stability`: 含 "timeout" / "heartbeat_lost" / "sandbox_rollback"
- 输出 JSON 落 `~/.dev-brain/evolution/insights-<date>.json`,供 DiagnosticLLM 消费

**Scenario: 聚合出 3 条 insight**
- GIVEN 最近 7 天: 12 个失败 trace + 1 份 code snapshot
  - 5 个失败含 "missing context" → category=context
  - 3 个失败含 "timeout" → category=agent-stability
  - 2 个失败含 "not implemented" → category=spec
- WHEN InsightEngine.run
- THEN 产出 3 条 insight,按 score 排序
- AND 写 `evolution.insights_produced_total` +3
- AND insights.json 落盘

**Scenario: 同 category 去重**
- GIVEN 上次跑出 2 条 category=context 的 insight
- WHEN 这次又聚出 1 条 context 类
- THEN 该条标 `duplicateOf: <prev-id>`,不重复入 list
- AND log warn

**Scenario: 数据不足跳过**
- GIVEN 最近 7 天 < 3 个失败 trace 且 code snapshot 缺数据
- WHEN InsightEngine.run
- THEN 写 `evolution.insights_skipped_total{reason="insufficient_data"}` +1
- AND 不产空 list,等下个周期

## CAP-EVO-02 (REVISED) LLM 诊断 — 全量双轨验证 + 分离判断与建议

> **v0.11.0 修订**: 原设计仅使用单模型自评 confidence 阈值 (>= 0.5) 做门控。经博弈论审查发现存在委托代理困境 — DiagnosticLLM 有动机策略性输出高置信度。修订为全量双轨 RuleValidator + 分离判断与建议。

### 阶段 1: 诊断 (必过 RuleValidator Level 1)

**Given** InsightEngine 已产出 top 10 insights
**When** DiagnosticLLM 处理每条 insight
**Then** 调 DeepSeek (复用 v0.10.0 fallback-classifier 已接的 LLM 通道),prompt 模板:
  ```
  你是 AI 研发系统的诊断员。看以下失败信号:
  - Insight: <summary>
  - Evidence: <evidenceRefs[]>  (含 trace_id / 失败 log / OpenSpec 段)
  - 最近 7 天同 category 出现 <N> 次
  
  请输出:
  1. 根因分类: prompt | spec | context | agent-stability
  2. 诊断的理由和依据 (引用 evidence 中的具体条目)
  3. 置信度: 0..1 (基于证据充分性,非主观把握)
  ```
**And** 输出 `Diagnostic { insightId, rootCause, rationale, confidence: 0..1 }`
**And** 写 `evolution.diagnostics_run_total` +1

### 阶段 1.5: RuleValidator 全量双轨验证

**Given** DiagnosticLLM 产出了 diagnostic
**When** **每条** diagnostic 进入 RuleValidator (100% 覆盖,无例外)
**Then** RuleValidator 按 Level 1 规则验证 (确定性规则,非 LLM):

| 规则 | 验证内容 | 方式 |
|------|---------|------|
| RV-1 | rootCause 在 evidence 中能否找到对应引用 | 字符串匹配 evidenceRefs |
| RV-2 | rootCause 与 rationale 是否逻辑一致 (不能自相矛盾) | 简单规则 (如 rootCause="prompt" 时 rationale 必须提及 prompt 模板) |
| RV-3 | confidence 是否在合理范围 (0.1~0.95,禁止极端值 0/1) | 数值范围检查 |
| RV-4 | diagnostic 输出格式完整 (insightId/rootCause/rationale/confidence 齐全) | schema 校验 |

**And** Level 1 **任一不通过** → diagnostic 直接丢弃,写 `evolution.diagnostics_rejected_total{reason="rule_validator_l1"}` +1
**And** Level 1 **全部通过** → 进入阶段 2 (建议生成),附带 priority 分数:
  - `priority = confidence * 0.3 + L2_satisfactions * 0.1 + attribution_match * 0.4`
  - L2_satisfactions: 阶段 2 中满足的 Level 2 规则数
  - attribution_match: L1 归因数据对 rootCause 的支持度 (0~1)

**And** 写 `evolution.diagnostics_validated_total` +1

### 阶段 2: 建议生成 (仅诊断被采纳后)

**Given** diagnostic 通过 RuleValidator Level 1
**When** System 决定采纳该诊断 (按 priority 排序,top 5)
**Then** DiagnosticLLM 调第二次 (分离调用):
  ```
  基于以下诊断结果:
  - Root Cause: <rootCause>
  - 诊断依据: <rationale>
  
  请生成修复方案:
  1. 修复建议: 一段 ≤ 200 字说明
  2. 可应用 diff (若是 prompt 类,改 prompt 模板;若是 spec 类,改 spec.md 字段)
  3. 修复方案引用的 spec 条款 (如 CAP-XXX-YY)
  ```
**And** 输出 `Fix { fix, diff?, specRefs[] }`
**And** 写 Level 2 规则验证结果:

| 规则 | 验证内容 | 方式 |
|------|---------|------|
| R2-1 | fix 引用具体 spec 条款 | 正则匹配 `CAP-[A-Z]+-\d+` |
| R2-2 | fix 包含量化指标 | 检测数字+单位模式 (如 "≥ 3 个 case") |
| R2-3 | rootCause 分类与历史 pattern 一致 | 与 insight-engine 历史分类比对 |
| R2-4 | diff 仅修改 prompt/spec 文件 (不碰业务代码) | `git diff --stat` 路径过滤 |

**And** fix + diff + L2 验证结果写入 `~/.dev-brain/evolution/diagnostics/<id>.json`(可审计)
**And** diff 字段走 unified diff 格式,可被 `git apply` 直接应用

### 兜底

**And** DeepSeek 不可用时记 `evolution.diagnostics_failed_total`,跳过该 insight,不阻塞主循环

**实现要点:**
- `src/evolution/diagnostic-llm.ts` — `class DiagnosticLLM { diagnose(insight): Promise<Diagnostic>; suggestFix(diagnostic): Promise<Fix> }`
- `src/evolution/rule-validator.ts` — `class RuleValidator { validateL1(d): ValidationResult; scoreL2(fix): L2Score }` (纯函数,确定性规则)
- Level 1 规则硬编码,Level 2 规则走 YAML 配置 (`config/rule-validator.yaml`),允许后续扩展
- 复用 Phase A.1 (v0.10.0) DeepSeek client,不做新通道

**Scenario: 正常诊断 + 双轨通过 + 建议生成**
- GIVEN insight: "prompt 模板 X 7 天失败 5 次,error 都是 'missing test'"
- WHEN DiagnosticLLM.diagnose → RuleValidator L1 全部通过 → priority=0.72
- THEN System 采纳该诊断,调 suggestFix
- AND 返: fix="在 prompt 模板追加 vitest 单测要求", diff="+ <hint>必带 vitest 单测,≥ 3 个 case</hint>"
- AND L2 R2-2 通过 (含量化指标 "≥ 3 个 case")

**Scenario: RuleValidator L1 拦截 (rootCause 无证据)**
- GIVEN diagnostic 声称 rootCause="prompt" 但 rationale 未引用任何 evidenceRefs
- WHEN RuleValidator L1
- THEN RV-1 失败 → diagnostic 被丢弃
- AND 写 `evolution.diagnostics_rejected_total{reason="rule_validator_l1"}` +1

**Scenario: RuleValidator L1 拦截 (confidence 极端值)**
- GIVEN diagnostic.confidence = 0.99
- WHEN RuleValidator L1
- THEN RV-3 失败 (confidence > 0.95)
- AND 丢弃,防止 DiagnosticLLM 策略性标高分

**Scenario: DeepSeek 不可用**
- GIVEN DeepSeek API 503
- WHEN DiagnosticLLM 调 API
- THEN catch 异常,写 `evolution.diagnostics_failed_total` +1
- AND 跳过该 insight,继续处理下一条
- AND 主循环不中断

## CAP-EVO-03 (REVISED) 评测回归 — A/B Split + Monitor Set 轮换

> **v0.11.0 修订**: 原设计为固定的 5 个标准任务集,经博弈论审查存在 Goodhart 定律风险 — Evolution Service 会反向工程固化的 eval suite。修订为随机抽取 + Decision/Monitor 双轨 + 定期轮换。

### 任务池与随机抽取

**Given** 系统维护一个任务池 P (≥ 100 个任务,存储在 `tests/eval/pool/*.yaml`)
**When** EvalRunner 触发 eval
**Then** 从 P 中随机抽取 20 个任务:
  - 前 5 个 = **Decision Set** (用于 prompt 采纳决策,对 Evolution Service 可见)
  - 后 15 个 = **Monitor Set** (用于监控能力退化,对 Evolution Service **不可见**)

**And** Evolution Service 只看到 20 个任务的平均结果,无法区分哪些是 Decision 哪些是 Monitor
**And** Monitor Set 结果独立统计,触发 capability_drift 告警时对 Evolution Service 隐藏

### 任务池管理

**And** 任务池大小 ≥ 100,包含:
  - 初始固化任务 30 个 (团队手工设计,覆盖 bug fix / 新功能 / 重构 / 多模态 / 长程任务)
  - 用户真实任务 50+ 个 (近 30 天实际任务,匿名化后加入)
  - 对抗性任务 20 个 (设计来检测 prompt 退化,如边界 case、歧义需求)

**And** 每 2 周轮换: 从 Decision Set 历史使用记录中随机淘汰 5 个任务,从外部池补充 5 个
**And** 轮换的随机性来自 `crypto.randomUUID()`,不依赖外部熵源
**And** 外部池补充优先级: 对抗性任务 > 近期用户任务 > 手工设计任务

### 采纳条件

**And** 对每个任务跑 3 次 (取中位数),跑新版本 (apply diff) vs 基线版本 (HEAD)
**And** 新 prompt 采纳条件:
  - Decision Set 通过率**显著提升** +5% (与基线比)
  - Monitor Set 通过率**未显著下降** (下降 ≤ 3%)
  - 两者都满足才允许替换

**And** 如果 Monitor Set 下降 > 3%:
  - 触发 `evolution.capability_drift` 告警 (仅内部日志 + 用户可见)
  - 阻止该 prompt 采纳 (即使 Decision Set 通过)
  - 写 `evolution.prompts_rejected_by_drift_total` +1

### 输出与 metric

**And** 输出 `EvalReport { decisionSetPass, monitorSetPass, deltaPct, pass: bool, rejectedByDrift: bool }`
**And** 写 metric:
  - `evolution.decision_set_pass_rate` (gauge)
  - `evolution.monitor_set_pass_rate` (gauge, 内部可见)
  - `evolution.capability_drift_alerts_total` (counter)
  - `evolution.prompts_rejected_by_drift_total` (counter)

**实现要点:**
- `src/evolution/eval-runner.ts` — `class EvalRunner { run(diff): Promise<EvalReport> }`
- `src/evolution/task-pool.ts` — `class TaskPool { randomDraw(n): Task[]; rotate(): void }` (管理 100+ 任务池和轮换)
- 任务 YAML 格式: 含 prompt / expected_output_criteria / 期望 metric 变化 / category / difficulty
- 沙箱: 每个任务跑在临时 worktree,避免污染主 repo
- 与 StateMachine (CAP-MAR-01) 联动: 每个任务按 SUCCESS/FAILED 计
- 资源: 20 任务 × 3 次 = 60 次,每次 ≤ 5min,总计需增加 eval 资源预算
- Monitor Set 结果隔离: 在 EvalRunner 内部计算,不通过 API 暴露给 Evolution Service

**Scenario: 新 prompt 双轨通过**
- GIVEN diff = 改 prompt 模板追加 "必带 vitest 单测"
- WHEN EvalRunner 随机抽取 20 个任务
- THEN Decision Set 5 任务平均 pass 78%→85% (delta=+7pp)
- AND Monitor Set 15 任务平均 pass 72%→74% (delta=+2pp,未下降)
- AND pass=true,允许替换

**Scenario: Monitor Set 检测到退化**
- GIVEN diff 改 prompt 删 "请简明扼要" 提示
- WHEN EvalRunner
- THEN Decision Set pass 70%→76% (delta=+6pp,超过 +5% 门槛)
- BUT Monitor Set pass 68%→62% (delta=-6pp,下降超过 3%)
- AND pass=false (rejectedByDrift=true)
- AND 写 `evolution.prompts_rejected_by_drift_total` +1
- AND Evolution Service 只知道"被拒绝",不知道 Monitor Set 的具体分数

**Scenario: 任务超时**
- GIVEN 某任务跑 5min 未完成
- WHEN EvalRunner
- THEN 该次跑标 timeout,不影响其他任务
- AND 该任务在 Decision/Monitor 集统计中计为 FAILED

## CAP-EVO-04 (REVISED) 进化服务编排

> **v0.11.0 修订**: 流水线增加 RuleValidator 阶段、用户反馈检查、自动熔断前置检查。

**Given** 上面阶段 (insight → diagnostic → RuleValidator → eval) 全部就绪
**When** EvolutionService cron 触发(每 6h)
**Then** 完整流水线:
  ```
  [cron 0 */6 * * *]
       ↓
  EvolutionService.runOnce()
       ↓  ← 前置检查: 熔断器状态 (CAP-EVO-05)
  1. InsightEngine.run() → insights[]
       ↓
  2. for insight in top-5:
       DiagnosticLLM.diagnose(insight) → diagnostic
       ↓
       RuleValidator.validateL1(diagnostic) → pass/fail
       if fail: skip, 写 rejected_total
       if pass: 计算 priority, 按 priority 排序
       ↓
       top 3 (by priority): DiagnosticLLM.suggestFix(diagnostic) → fix + diff
       ↓
  3. EvalRunner.run(diff) → evalReport
       ↓  ← 用户反馈检查 (CAP-EVO-06)
  4. if evalReport.pass AND satisfaction_score >= -0.3:
       a. apply diff (git apply --check → git apply)
       b. commit "evolution: <summary>"
       c. L3LongTermMemory.write({...}, {fromEvolution: true})
       d. 写 `evolution.prompts_evolved_total` +1
       e. 进入 7 天观察期 (quarantine)
     else:
       diff 落 rejected/,记 rejected_total
  ```
**And** 完整链路写 trace_id,可从 audit 还原 "哪条 insight → 哪个 diagnostic → RuleValidator 结果 → 哪个 eval → 是否替换"
**And** 7 天观察期:替换的 prompt 进 `quarantine`,eval-runner 再跑 3 次(每 24h),持续通过才正式启用;失败则 `git revert`

**实现要点:**
- `src/evolution/evolution-service.ts` — `class EvolutionService { runOnce(): Promise<RunSummary>; rollback(promptId): Promise<void>; }`
- `src/evolution/l3-memory.ts` — `class L3LongTermMemory { read(); write(entry, opts?: { fromEvolution?: boolean }) }`,默认拒绝非 evolution 调用
- `src/evolution/circuit-breaker.ts` — `class CircuitBreaker { isOpen(): boolean; recordResult(success: boolean): void }` (CAP-EVO-05)
- 替换走 `git apply --check` 先 dry-run,通过才真 apply
- 7 天观察期:每次跑 eval-runner 都覆盖 active prompt,失败立即回滚
- CLI 暴露 `./cli prompt revert <id>` 人工回滚入口

**Scenario: 完整周期成功**
- GIVEN 熔断器关闭,cron 触发,产 1 条 insight → diagnostic → RuleValidator L1 pass + priority=0.72 → fix + diff → eval pass (Decision +5%, Monitor -1%)
- AND 用户满意度 > -0.3
- WHEN EvolutionService.runOnce
- THEN diff apply,commit,落 L3,evolved_total +1
- AND trace_id 贯穿整链路,审计可还原

**Scenario: RuleValidator L1 拦截**
- GIVEN diagnostic 生成但 RV-1 失败 (rootCause 无证据引用)
- WHEN EvolutionService
- THEN diagnostic 不入 eval,写 `evolution.diagnostics_rejected_total{reason="rule_validator_l1"}` +1
- AND 不阻塞其他 diagnostic 的处理

**Scenario: eval 失败拒绝**
- GIVEN 同上,但 eval delta=-3pp (未达 +5% 门槛) 或 Monitor Set 下降 > 3%
- WHEN EvolutionService
- THEN diff 不 apply,落 rejected/
- AND rejected_total +1
- AND L3 不写新 entry

**Scenario: 熔断器开启,跳过本轮**
- GIVEN 上次熔断器因连续 reject 被触发 (CAP-EVO-05)
- WHEN EvolutionService.runOnce
- THEN 不执行 insight pipeline,写 `evolution.skipped_circuit_open` +1
- AND log warn "Evolution skipped: circuit breaker is open"

**Scenario: 7 天观察期回滚**
- GIVEN 某 prompt 替换后 7 天内第 3 次 eval 退化
- WHEN EvolutionService 周期任务
- THEN `git revert` 到替换前
- AND 写 `evolution.rollbacks_total` +1
- AND L3 标 `entry.status="rolled_back"`

**Scenario: 手动回滚 CLI**
- GIVEN 用户跑 `./cli prompt revert prm-2026-06-06-001`
- WHEN CLI
- THEN git revert 该 commit
- AND 提示"已回滚到 <sha>"

**Scenario: L3 写入被非 evolution 调用**
- GIVEN 业务代码误调 `L3LongTermMemory.write({...})` 未传 `fromEvolution: true`
- WHEN write
- THEN 抛 `L3WriteDeniedError`,写 `l3.manual_write_denied_total` +1
- AND 走 `--force` 标志时打审计 `l3.manual_write` 进 audit

## CAP-EVO-05 (NEW) Evolution Service 自动熔断机制

> **v0.11.0 新增**: P0 Safety Net。即使激励机制设计正确,仍需熔断作为最后安全网。

**Given** Evolution Service 周期性运行 prompt 进化流水线
**When** 短时间内出现连续异常信号
**Then** CircuitBreaker 自动打开,暂停进化周期,防止系统状态进一步恶化

### 熔断触发条件

**And** 在以下任一条件满足时,熔断器打开 (open):

| 触发条件 | 阈值 | 说明 |
|---------|------|------|
| CB-1 | 1h 内 `evolution.prompts_rejected_total` ≥ 5 | diagnostic/eval 连续被拒,可能 DiagnosticLLM 或 RuleValidator 异常 |
| CB-2 | 24h 内 `evolution.rollbacks_total` ≥ 3 | 观察期内连续回滚,可能 eval suite 与实际能力严重脱节 |
| CB-3 | `evolution.satisfaction_score` < -0.5 持续 7 天 | 用户持续不满,进化方向偏离用户价值 |
| CB-4 | `evolution.capability_drift_alerts_total` ≥ 3 (24h) | Monitor Set 连续检测到能力退化 |

**And** 熔断器打开后:
  - `EvolutionService.runOnce()` 不执行 insight pipeline
  - 写 `evolution.circuit_breaker.state` (gauge, 0=closed / 1=half-open / 2=open)
  - 写 `evolution.skipped_circuit_open` +1
  - 通知用户 (飞书卡片 + metric alert)

### 恢复机制

**And** 熔断器打开后进入**半开 (half-open)** 状态:
  - 半开状态持续 24h 冷却期
  - 冷却期内不做任何 evolution,只记录 metric
  - 冷却期结束后,允许 **1 次试运行** (dry-run,不实际 apply diff)
  - 试运行 eval pass → 熔断器关闭 (closed),恢复正常周期
  - 试运行 eval fail → 熔断器重新打开 (open),冷却期重置

**And** 手动恢复: `./cli evolve --reset-circuit-breaker` 强制关闭熔断器 (写 audit 日志)

### 实现要点

- `src/evolution/circuit-breaker.ts` — `class CircuitBreaker { isOpen(): boolean; recordResult(success: boolean): void; state(): "closed"|"half_open"|"open" }`
- 使用标准三态熔断器模式 (closed → open → half-open → closed)
- 状态持久化到 `~/.dev-brain/evolution/circuit-breaker-state.json`,daemon 重启后保留
- 每次 runOnce 前置检查: `if (circuitBreaker.isOpen()) { skip; return; }`

### Metric

- `evolution.circuit_breaker.state` (gauge, 0=closed / 1=half-open / 2=open)
- `evolution.skipped_circuit_open` (counter)
- `evolution.circuit_breaker.reset_manual` (counter)

**Scenario: 连续 reject 触发熔断**
- GIVEN 1h 内 5 个 diagnostic 全部被 RuleValidator L1 或 eval 拒绝
- WHEN EvolutionService 触发第 6 个周期
- THEN 熔断器打开,跳过本轮
- AND 飞书通知 "Evolution 自动暂停: 1h 内 5 次连续拒绝,冷却 24h"

**Scenario: 冷却后半开试运行**
- GIVEN 熔断器 open 24h 后
- WHEN EvolutionService 执行试运行 (dry-run,不实际 apply)
- THEN eval pass → 熔断器 closed,恢复周期
- AND eval fail → 熔断器 reopen,冷却期重置

**Scenario: 手动强制恢复**
- GIVEN 管理员确认系统正常,熔断器 open 中
- WHEN `./cli evolve --reset-circuit-breaker`
- THEN 熔断器 closed, 写 audit "circuit_breaker.manual_reset by <user>"

## CAP-EVO-06 (NEW) 用户反馈信号集成

> **v0.11.0 新增**: P0 Safety Net。解决 Evolution Service 与用户之间的信息不对称 — 没有用户反馈,系统会在信息真空中优化指标而偏离用户价值。

### 反馈采集

**Given** 每次任务完成 (SUCCESS 或 FAILED),TaskDoneCard (CAP-COM-04) 已发送
**When** 用户在飞书卡片上点击反馈按钮
**Then** 系统接收反馈信号:
  - **thumbs_up** → satisfaction_signal = +1
  - **thumbs_down** → satisfaction_signal = -2 (负面反馈权重更高,因用户倾向不主动点负反馈)
  - **无操作** (72h 内无反馈) → satisfaction_signal = 0 (视为中性,非缺失)

**And** 反馈写入 `~/.dev-brain/feedback/<taskId>.json`,含 `{ taskId, signal, timestamp, trace_id }`

### 滚动窗口评分

**And** 计算 7 天滚动窗口 satisfaction_score:
  ```
  satisfaction_score = sum(signals in last 7 days) / max(total_tasks in last 7 days, 1)
  范围: -2 到 +1
  ```

**And** satisfaction_score 作为 Evolution Service 采纳决策的**必要条件** (非充分条件):
  - `satisfaction_score >= -0.3` → 允许 prompt 采纳 (仍需 eval pass)
  - `satisfaction_score < -0.3` → 即使 eval pass,也暂缓 prompt 采纳
  - `satisfaction_score < -0.5` 持续 7 天 → 触发熔断 CB-3 (CAP-EVO-05)

### Metric

- `evolution.user_satisfaction_score` (gauge, 7 天滚动)
- `evolution.user_rollback_rate` (gauge, 用户手动回滚频率)
- `evolution.prompts_rejected_by_user_feedback_total` (counter)
- `evolution.user_feedback_total{signal}` (counter, thumbs_up / thumbs_down)

### 实现要点

- `src/evolution/feedback-collector.ts` — `class FeedbackCollector { record(taskId, signal): void; score(): number }`
- 飞书卡片增加两个交互按钮: "👍 满意" / "👎 不满意" (复用 v0.9.0 卡片按钮审批机制)
- 反馈信号作为第四类 evolution 输入 (除 code snapshot + failure trace + metrics)
- 与熔断器联动: 用户持续不满自动暂停进化

**Scenario: 用户满意度正常,进化继续**
- GIVEN 7 天内 10 个任务完成,6 个 thumbs_up,1 个 thumbs_down,3 个无操作
- WHEN EvolutionService.runOnce
- THEN satisfaction_score = (6 + (-2)) / 10 = 0.4 >= -0.3
- AND 允许 prompt 采纳 (仍需 eval pass)

**Scenario: 用户持续不满触发熔断**
- GIVEN 7 天内 satisfaction_score < -0.5 持续 7 天
- WHEN EvolutionService.runOnce
- THEN 熔断器触发 (CB-3),进化暂停
- AND 飞书通知 "Evolution 暂停: 用户满意度连续 7 天低于阈值,请检查进化方向"

**Scenario: 单次差评不阻塞进化**
- GIVEN 7 天内 20 个任务完成,1 个 thumbs_down,其余无反馈
- WHEN EvolutionService.runOnce
- THEN satisfaction_score = (-2) / 20 = -0.1 >= -0.3 → 不阻塞

## 集成: 一键执行 + 可观测

**Given** 6 个模块各自分离 (InsightEngine / DiagnosticLLM / RuleValidator / EvalRunner / CircuitBreaker / FeedbackCollector)
**When** 用户跑 `./cli evolve --once` (单次) 或 `--daemon` (持续)
**Then** 单次模式: 跑完整 runOnce,产出 summary 报告到 stdout
**And** 持续模式: 6h 周期 + SIGTERM 优雅退出(完当前 cycle 才退)
**And** metric 持续上报:
  - `evolution.insights_produced_total` / `evolution.diagnostics_run_total` / `evolution.diagnostics_validated_total` / `evolution.diagnostics_rejected_total`
  - `evolution.decision_set_pass_rate` / `evolution.monitor_set_pass_rate` / `evolution.capability_drift_alerts_total`
  - `evolution.prompts_evolved_total` / `evolution.prompts_rejected_total` / `evolution.prompts_rejected_by_drift_total`
  - `evolution.circuit_breaker.state` / `evolution.skipped_circuit_open`
  - `evolution.user_satisfaction_score` / `evolution.user_feedback_total`
  - `evolution.rollbacks_total`
**And** Grafana panel "Evolution Pipeline (v0.11.0)" 展示关键 metric + 熔断器状态 + 用户满意度趋势

**实现要点:**
- 复用 v0.10.0 metrics.ts,加 ~15 个新 counter/gauge
- ops/grafana/dev-brain-dashboard.json 加 panel #18 "Evolution Pipeline (v0.11.0)"
- 文档: docs/evolution.md (新) 解释整套流程 + 博弈论设计原理 + 回滚指南
