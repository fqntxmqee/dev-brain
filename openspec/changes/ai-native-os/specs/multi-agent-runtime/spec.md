---
demand-id: DM-20260606-003
change: ai-native-os
status: developing
---

# Multi-Agent Runtime Spec (Delta — v0.11.0)

本文为 AI Native OS 多 Agent 运行时引入 5 项关键能力: 显式状态机 / 沙箱 / 心跳 / Self-Correction / 验收流水线。
v0.10.0 已有 ad-hoc retry + checkpoint + 3 个 adapter (claude/codex/cursor),本 spec 把"派发-执行-恢复"做成形式化闭环。

## CAP-MAR-01 (NEW) 显式状态机

**Given** 每个子任务在 BrainEngine 中有生命周期
**When** 状态变更请求到达
**Then** StateMachine 校验迁移合法性,非法迁移抛 `IllegalStateTransitionError`
**And** 合法的迁移:

```
PENDING ──dispatch──> RUNNING ──success──> SUCCESS (terminal)
                          │                  ▲
                          ├──self_correct──> RETRYING ──retry──> RUNNING
                          │
                          ├──max_attempts──> FAILED (terminal)
                          │
                          └──heartbeat_lost──> CANCELLED (terminal)
                          │
                          └──user_cancel──> CANCELLED (terminal)
```

**And** 状态变更写 `runtime.subtask.state_transition_total{from,to}` counter
**And** 非法迁移(如 SUCCESS → RUNNING)写 `runtime.subtask.illegal_transition_total` +1,日志带 trace_id

**实现要点:**
- `src/runtime/state-machine.ts` — `class SubtaskStateMachine { transition(from, to, ctx): asserts valid; canTransition(from, to): boolean; ALLOWED: Map<state, Set<state>>; }`
- 替换 v0.10.0 orchestrator.ts 里散落的 `if (status === "running") ...`
- 状态字段改为 discriminated union:`type State = "pending" | "running" | "retrying" | "success" | "failed" | "cancelled"`,编译期穷尽性检查
- 持久化:每次 transition 写 checkpoint,resume 时校验状态合法性

**Scenario: 正常 SUCCESS 路径**
- GIVEN subtask st-1 处于 PENDING
- WHEN dispatch 触发
- THEN state machine: PENDING → RUNNING
- AND 执行成功 → RUNNING → SUCCESS
- AND 整个链路上 counter: PENDING→RUNNING +1, RUNNING→SUCCESS +1

**Scenario: 重试循环**
- GIVEN st-2 第 1 次失败,policy 决定重试
- WHEN self_correction 触发(CAP-MAR-04)
- THEN state: RUNNING → RETRYING → RUNNING(第 2 次)
- AND `runtime.subtask.state_transition_total{from="running",to="retrying"}` +1
- AND 仍失败 → RETRYING → RUNNING(第 3 次) → 超过 maxAttempts → FAILED

**Scenario: 非法迁移被拒**
- GIVEN st-3 已 SUCCESS
- WHEN 异常代码尝试把 state 改回 RUNNING
- THEN StateMachine.transition() 抛 `IllegalStateTransitionError: SUCCESS → RUNNING`
- AND 写 `runtime.subtask.illegal_transition_total{from="success",to="running"}` +1
- AND 状态实际未改变(SUCCESS 仍为 SUCCESS)

**Scenario: 用户中途取消**
- GIVEN st-4 RUNNING
- WHEN 用户在飞书卡点 "取消"
- THEN state: RUNNING → CANCELLED (合法)
- AND adapter.send 收到 cancel 信号,触发 SIGTERM
- AND CAP-MAR-03 心跳停止

## CAP-MAR-02 (NEW) 沙箱执行

**Given** adapter 即将 spawn 子进程(claude / codex-minimax / cursor)
**When** 沙箱模式开启(`DEV_BRAIN_SANDBOX_ENABLED=true`)
**Then** SandboxManager 在执行前后:
  - **执行前**: `git stash push -u -m "sandbox-<taskId>"` 把 workDir 当前未提交修改暂存(若有冲突先 reject)
  - **执行中**: 子进程 cwd = workDir,但**所有文件写入受 git 跟踪**;`git status` 监控 diff 范围
  - **执行后 (success)**: `git stash pop` 不需要(已 commit 或留在 worktree)
  - **执行后 (failure)**: `git checkout -- .` + `git stash pop` 回滚到执行前
**And** 沙箱失败回滚写 `runtime.sandbox.rollback_total` +1
**And** 沙箱初始化失败(冲突)→ adapter 立即拒绝派发,任务标记 FAILED

**实现要点:**
- `src/runtime/sandbox.ts` — `class SandboxManager { enter(taskId): asserts; exit(taskId, success): Promise<void>; rollback(): Promise<void> }`
- 用 `simple-git` 或直接子进程调 `git`(已装)
- 沙箱粒度: per-subtask,每个 subtask 独立 worktree 副本(避免 subtask 间污染)
- 与 checkpoint 联动:沙箱 enter/exit 写 checkpoint,resume 时校验"上次 sandbox 是否完整退出"
- 性能:每次 git stash 约 50ms-200ms,可接受

**Scenario: 成功提交不回滚**
- GIVEN subtask st-1 即将 spawn claude
- WHEN SandboxManager.enter("task-X-st-1")
- THEN `git stash push` 空 stash (workDir clean)
- AND claude 改 3 文件 + commit
- WHEN exit(success)
- THEN 保留 3 文件的 commit,stash list 不增加

**Scenario: 失败回滚恢复现场**
- GIVEN st-2 失败,Claude 把 trade.ts 改坏 + 删了 2 个测试
- WHEN SandboxManager.exit(failure, "task-X-st-2")
- THEN `git checkout -- .` 还原 trade.ts
- AND `git clean -fd` 恢复被删的测试(若未被 git 跟踪则报 warning)
- AND `git stash pop` 还原执行前的本地修改
- AND 写 `runtime.sandbox.rollback_total` +1

**Scenario: 冲突时拒绝派发**
- GIVEN workDir 有用户未提交的本地修改(不是 sandbox 引起的)
- WHEN SandboxManager.enter("task-X-st-3")
- THEN `git stash push` 失败(merge conflict 或类似)
- AND 抛 `SandboxEnterError`
- AND 任务标记 FAILED,飞书提示"workDir 有未提交修改,请先 commit 或 stash"

## CAP-MAR-03 (NEW) 心跳回传

**Given** adapter.send() 派发了一个子进程(claude / codex 等)
**When** 子进程每 30s 输出一行 `__dev_brain_heartbeat__` 到 stdout (或 stderr)
**Then** HeartbeatWatcher 解析心跳,更新 `last_heartbeat_at`
**And** 连续 2 个心跳周期未更新(>60s)→ 触发 cancel + 标记 FAILED with reason="heartbeat_lost"
**And** 阈值可通过 env `DEV_BRAIN_HEARTBEAT_MISSES` 调整
**And** 写 `runtime.heartbeat.received_total` +1,`runtime.heartbeat.lost_total` +1

**实现要点:**
- `src/runtime/heartbeat.ts` — `class HeartbeatWatcher { start(adapter, ctx); stop(); }`
- adapter 包装层 (LocalClaudeCodeAdapter / LocalCodexAdapter) 在 stdout 解析心跳
- 超时 = `heartbeatMisses * heartbeatIntervalMs`,默认 60s
- 与 state-machine 联动:心跳丢失 → 状态 CANCELLED,触发 rollback
- 不动 v0.10.0 已有 cancel 逻辑(基于 SIGTERM),只在上层加超时

**Scenario: 正常心跳**
- GIVEN claude 跑一个 5min 的子任务
- WHEN claude 每 30s 输出 `__dev_brain_heartbeat__ <progress>50</progress>`
- THEN HeartbeatWatcher 持续更新 last_heartbeat_at
- AND 任务正常运行,无 cancel

**Scenario: 心跳丢失触发 cancel**
- GIVEN claude 在 step 3 之后卡住(无 stdout 输出)
- WHEN 60s 内无新心跳
- THEN HeartbeatWatcher 触发 cancel:
  - `child.kill("SIGTERM")`
  - state: RUNNING → CANCELLED (reason="heartbeat_lost")
  - `runtime.heartbeat.lost_total` +1
- AND SandboxManager.exit(failure) 触发回滚

**Scenario: 自定义阈值**
- GIVEN env `DEV_BRAIN_HEARTBEAT_MISSES=5` (5 个周期)
- WHEN 5 * 30s = 150s 无心跳
- THEN 才触发 cancel(给慢 agent 更多时间)

## CAP-MAR-04 (REVISED) Self-Correction 闭环 — L1 归因 + 分流决策

> **v0.11.0 修订**: 原设计为"失败后自动修复"的单一修复工具。经博弈论审查发现存在囚徒困境 — Agent 的失败成本被外部化,搭便车成为占优策略。修订为 L1 归因 + 分流决策: 偶发失败走修复路径,系统性失败走进化路径,不可归因的失败进入待观察队列。

### L1 归因数据

**Given** subtask 失败
**When** Self-Corrector 介入
**Then** 首先从 L1 可信源 (系统侧采集,Agent 无法篡改) 采集归因数据:

```
type L1FailureTrace = {
  taskId: string;
  agentName: string;
  timestamp: string;
  specRef: { specId: string; version: string; clause?: string };
  gitDiff: { filesChanged: number; additions: number; deletions: number; files: string[] };
  acceptance: { stage: "test"|"lint"|"typecheck"|"reviewer"; result: "pass"|"fail"; detail?: string }[];
  heartbeat: { startedAt: string; lastBeatAt: string; totalBeats: number; lostBeats: number };
  sandbox: { entered: boolean; rolledBack: boolean; conflict?: boolean };
};
```

**And** L1 数据可回答 80% 的归因问题 ("Agent 改了哪个文件但没加测试"、"Agent 是否超时/卡死"、"Agent 是否违反 spec 某条要求")

### Step 1: 归因分析 (Attribution)

**And** 归因引擎基于 L1 数据 (不依赖 Agent 自述的 reasoning) 产出 `Attribution`:

```
type Attribution = {
  violationType: "missing_test" | "spec_violation" | "timeout" | "lint_error" | "type_error" | "unattributable";
  agentAccountable: boolean;  // 归因到 Agent 决策 vs 系统环境 (timeout/heartbeat_lost 不是 Agent 的错)
  confidence: number;         // 归因本身的置信度
  evidenceRefs: string[];     // 指向 L1 trace 中的具体字段
};
```

**And** 归因判定规则:
  - `acceptance.stage="test" AND result="fail"` → violationType="missing_test", agentAccountable=true
  - `acceptance.stage="lint" AND result="fail"` → violationType="lint_error", agentAccountable=true (大概率)
  - `heartbeat.lostBeats > 0` → violationType="timeout", agentAccountable=false (非 Agent 可控)
  - 无法从 L1 数据判定 → violationType="unattributable" (不强行归因,避免 Agent 因恐惧误判而保守)

**And** 写 `self_correction.attribution_total{violationType, agentAccountable}` +1

### Step 2: 分流决策 (Triage)

**Given** 归因分析完成
**When** 分流决策触发
**Then** 根据 `violationType` + `historical_frequency` 分三路:

| 路径 | 条件 | 处理方式 |
|------|------|---------|
| **修复路径** | 偶发性失败 (historical_frequency < 5% 且 violationType ≠ "unattributable") | 重写 prompt + 重试 (最多 2 次), 不计入 Agent 绩效扣分 |
| **进化路径** | 系统性失败 (historical_frequency ≥ 5% 或同模式 7 天内 ≥ 3 次) | 产出 Insight 进 Evolution Pipeline,不自动重试 |
| **升级路径** | 不可恢复 (如 401 API key 失效) 或 Agent 能力边界 | 升级用户,不计入 Agent 绩效 |

**And** 7 天内同 violationType 重复失败 > 3 次 → 抛 `SpecRecurrentFailureError`,自动升级用户
**And** violationType="unattributable" → 标记为待观察,积累 ≥ 5 条同 pattern 后重新尝试归因

**And** 写 metric:
  - `self_correction.triage_total{path="repair"|"evolution"|"escalation"}`
  - `self_correction.unattributable_queue_size` (gauge)

### Step 3: 修复执行 (仅修复路径)

**Given** 分流决策为"修复路径"
**When** Self-Corrector 重试
**Then** 不再"同 prompt 再试",而是:
  1. 重读 spec: 从 L2 recall 当前 subtask 关联的 OpenSpec 段
  2. 附加归因报告: 在原 prompt 基础上追加 "上次失败归因: {violationType} at {evidenceRefs}"
  3. 重新 spawn,最多 2 次

**And** 一次性成功率 (首轮 → 一次 self-correction 解决) 目标 ≥ 40%
**And** Self-correction 最多 N 次 (默认 2,env `DEV_BRAIN_SELF_CORRECTION_MAX_ATTEMPTS` 可调)
**And** N 次后仍失败 → 升级用户 (不自动重试)

**And** 写 `runtime.self_correction.triggered_total` +1, `runtime.self_correction.repair_success_total` +1

**Scenario: 简单遗漏走修复路径**
- GIVEN subtask "实现日期筛选,带单元测试",Agent 输出仅实现无测试
- WHEN 归因引擎: violationType="missing_test", historical_frequency=2% (< 5%)
- THEN 分流 → 修复路径
- AND 改写 prompt 追加 "上次失败归因: missing_test,请补 vitest 写 ≥ 3 个 case"
- AND 第 2 次 spawn 输出含测试,通过

**Scenario: 系统性失败走进化路径**
- GIVEN 同 violationType="missing_test" 7 天内出现 4 次 (frequency=8%)
- WHEN 归因引擎: historical_frequency >= 5%
- THEN 分流 → 进化路径
- AND 产出 Insight { category="spec", summary="missing_test 系统性高频,建议强化 spec 中的测试要求" }
- AND 不自动重试,等待 Evolution Pipeline 修复 prompt/spec

**Scenario: 不可归因进入待观察**
- GIVEN Agent 失败但 L1 数据无法对应到明确的 violationType (非 test/lint/timeout)
- WHEN 归因引擎
- THEN violationType="unattributable"
- AND 不强行归因到 Agent,不扣绩效
- AND 记录到 `~/.dev-brain/self-correction/unattributable/`,等积累 ≥ 5 条同 pattern 后再尝试归因

**Scenario: 重复失败升级用户**
- GIVEN 同 spec "重构 trade 模块" 7 天内第 3 次 self-correction 仍失败
- WHEN Self-Corrector 累计失败次数
- THEN 抛 `SpecRecurrentFailureError: spec=<id> failed 3 times in 7 days`
- AND 任务 FAILED,飞书卡显示"建议用户复核 spec 或手动介入"
- AND 写 `runtime.self_correction.user_escalation_total` +1

**Scenario: 不可恢复类错误**
- GIVEN error = "401 Unauthorized" (API key 失效)
- WHEN Self-Corrector 归因
- THEN 识别为不可恢复,直接升级用户
- AND 写 `runtime.self_correction.skipped_total{reason="non_recoverable"}` +1

**实现要点:**
- `src/runtime/self-correction.ts` — `class SelfCorrector { attribute(failure: L1FailureTrace): Attribution; triage(attribution): Path; correct(ctx, attribution): Promise<CorrectedPrompt> }`
- `src/runtime/attribution-engine.ts` — `class AttributionEngine { analyze(trace): Attribution }` (纯函数,确定性规则)
- 复用 v0.10.0 RecallStrategy (CAP-CTX-03 失败重试前节点) 注入相关 context
- 与 state-machine 联动: 
  - 修复路径 → RETRYING → RUNNING
  - 进化路径 → FAILED (等待 Evolution)
  - 升级路径 → FAILED (等待用户)

## CAP-MAR-05 (NEW) 验收流水线

**Given** subtask 成功跑完(adapter.send done)
**When** AcceptancePipeline 介入
**Then** 自动按顺序跑:
  1. **单元测试**: `pnpm test --filter <changed-package>`(或全量,env 配)
  2. **Lint**: `pnpm lint <changed-files>`
  3. **类型检查**: `pnpm typecheck --noEmit`(子集)
  4. **Reviewer agent** (可选, env `DEV_BRAIN_REVIEWER_ENABLED`): spawn codex 扮演 reviewer 角色,产出 review comment
**And** 任一环节失败 → subtask 标记 FAILED with reason=具体阶段
**And** 全部通过 → subtask 真正 SUCCESS,触发 TaskDoneCard (CAP-COM-04)
**And** 写 `runtime.acceptance.{stage}_total{result=pass|fail}` counter

**实现要点:**
- `src/runtime/acceptance-pipeline.ts` — `class AcceptancePipeline { run(subtask, artifacts): Promise<AcceptanceResult> }`
- 复用 v0.10.0 HeartbeatWatcher 监控 acceptance 子进程(也会卡)
- Reviewer agent:走 v0.8.0 native backend,prompt 模板 "你是 code reviewer,看这个 diff,给出 ≤ 5 条 review comments"
- 测试失败兜底:`pnpm test` 5min 超时 → FAILED,记 timeout

**Scenario: 单测通过全链路绿**
- GIVEN subtask 改 trade.ts + 加 test/trade.test.ts
- WHEN AcceptancePipeline.run
- THEN 跑 `pnpm test trade.test.ts` → 12/12 pass
- AND `pnpm lint trade.ts` → 0 error
- AND `pnpm typecheck` → 0 error
- AND subtask 升级为 SUCCESS

**Scenario: Lint 失败被捕获**
- GIVEN subtask 输出有未用 import
- WHEN AcceptancePipeline.run → lint 阶段
- THEN 失败,subtask FAILED with reason="lint_failed"
- AND 触发 Self-Correction(CAP-MAR-04),重写 prompt 强调 "请清理未用 import"
- AND Self-Correction 后再跑 lint,通过 → SUCCESS

**Scenario: Reviewer agent 提改进建议但通过**
- GIVEN subtask 改完,reviewer agent 产出 3 条建议("变量名可优化","少一个边界 case")
- WHEN AcceptancePipeline.run → reviewer 阶段
- THEN 视为"有建议但通过",subtask 仍 SUCCESS
- AND review comments 写 `~/.dev-brain/acceptance-reviews/<taskId>.md` 供用户翻阅
- AND 不阻塞主任务
