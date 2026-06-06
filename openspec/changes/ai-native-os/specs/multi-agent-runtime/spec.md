---
demand-id: DM-20260606-003
change: ai-native-os
status: developing
---

# Multi-Agent Runtime Spec (Delta — v0.11.0)

本文为 AI Native OS 多 Agent 运行时引入 5 项关键能力: 显式状态机(含 checkpoint 持久化) / 双保险沙箱 / 结构化心跳 / L1 归因 + Wink 分类 + 分流决策 / 分层验收金字塔。
v0.10.0 已有 ad-hoc retry + checkpoint + 3 个 adapter (claude/codex/cursor),本 spec 把"派发-执行-恢复"做成形式化闭环。

> **设计依据**: `design.md` — Grill with Docs 3 轮分析 (LangGraph 1.0 checkpointing / 事务性快照论文 / Wink 自干预 / 分层验收)

## CAP-MAR-01 (REVISED) 显式状态机 + Checkpoint 持久化

> **v0.11.0 修订**: 保留 6 状态 FSM,增加 CheckpointStore (JSON 文件持久化)。LangGraph 1.0 共识: crash 后可恢复,不丢上下文。

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

### Checkpoint 持久化

**And** 每次合法 transition 后,CheckpointStore 异步写 checkpoint (不阻塞状态迁移):

```typescript
class CheckpointStore {
  async save(state: SubtaskState, ctx: CheckpointContext): Promise<void>;
  async load(taskId: string): Promise<SubtaskState | null>;
  validate(stored: SubtaskState, expected: SubtaskState): boolean;
}
```

**And** 持久化内容: `{ taskId, subtaskId, state, transitionHistory[], agentName, sandboxBaselineSha, attemptNumber, savedAt }`
**And** 存储路径: `~/.dev-brain/checkpoints/<taskId>/subtask-<n>.json`
**And** resume 时从 checkpoint 恢复,校验状态合法性后继续执行
**And** checkpoint 损坏时写 `runtime.checkpoint.corrupt_total` +1,任务标记 FAILED

**实现要点:**
- `src/runtime/state-machine.ts` — `class SubtaskStateMachine { transition(from, to, ctx): asserts valid; canTransition(from, to): boolean; ALLOWED: Map<state, Set<state>>; }`
- `src/runtime/checkpoint-store.ts` — `class CheckpointStore { save(); load(); validate() }` (NEW)
- 替换 v0.10.0 orchestrator.ts 里散落的 `if (status === "running") ...`
- 状态字段改为 discriminated union:`type State = "pending" | "running" | "retrying" | "success" | "failed" | "cancelled"`,编译期穷尽性检查

**Scenario: 正常 SUCCESS 路径**
- GIVEN subtask st-1 处于 PENDING
- WHEN dispatch 触发
- THEN state machine: PENDING → RUNNING
- AND checkpoint 异步写入 `~/.dev-brain/checkpoints/<taskId>/st-1.json`
- AND 执行成功 → RUNNING → SUCCESS
- AND 整个链路上 counter: PENDING→RUNNING +1, RUNNING→SUCCESS +1

**Scenario: 重试循环**
- GIVEN st-2 第 1 次失败,policy 决定重试
- WHEN self_correction 触发(CAP-MAR-04)
- THEN state: RUNNING → RETRYING → RUNNING(第 2 次)
- AND 每次 transition 写 checkpoint
- AND `runtime.subtask.state_transition_total{from="running",to="retrying"}` +1
- AND 仍失败 → RETRYING → RUNNING(第 3 次) → 超过 maxAttempts → FAILED

**Scenario: 非法迁移被拒**
- GIVEN st-3 已 SUCCESS
- WHEN 异常代码尝试把 state 改回 RUNNING
- THEN StateMachine.transition() 抛 `IllegalStateTransitionError: SUCCESS → RUNNING`
- AND 写 `runtime.subtask.illegal_transition_total{from="success",to="running"}` +1
- AND 状态实际未改变(SUCCESS 仍为 SUCCESS)

**Scenario: Crash 恢复**
- GIVEN subtask st-1 在 RUNNING 状态,最新 checkpoint 已持久化
- WHEN 进程 crash 后重启
- THEN Orchestrator 读取 checkpoint
- AND 校验 checkpoint.state = "running" 合法
- AND 从 RUNNING 状态恢复,重新 spawn Agent
- AND 不需要重新走 PENDING → RUNNING

**Scenario: 用户中途取消**
- GIVEN st-4 RUNNING
- WHEN 用户在飞书卡点 "取消"
- THEN state: RUNNING → CANCELLED (合法)
- AND adapter.send 收到 cancel 信号,触发 SIGTERM
- AND CAP-MAR-03 心跳停止

## CAP-MAR-02 (REVISED) 双保险沙箱执行

> **v0.11.0 修订**: 保留 git stash 方案,增加 pre-flight 校验 + 双路径回滚 (stash pop → git reset --hard 兜底) + SandboxGuarantee 等级标注。事务性快照论文 (Dec 2025): 回滚成功率从 ~95% → 100%。

**Given** adapter 即将 spawn 子进程(claude / codex-minimax / cursor)
**When** 沙箱模式开启(`DEV_BRAIN_SANDBOX_ENABLED=true`)
**Then** SandboxManager 分三阶段执行:

### Pre-flight 校验 (执行前)

1. `git status --porcelain` — 检查 workDir 状态
2. `git stash push -u -m "sandbox-<taskId>"` — 暂存本地修改
3. 验证 stash 成功: `git stash list | grep sandbox-<taskId>`
4. 记录 baseline: `git rev-parse HEAD` → baselineSha
5. 任一失败 → 拒绝派发,任务 FAILED

### 执行中

- 子进程 cwd = workDir,所有文件写入受 git 跟踪
- `git status` 监控 diff 范围

### 双路径回滚 (执行后,失败时)

```
路径 1 (优先): git checkout -- . + git clean -fd + git stash pop
路径 2 (兜底): git reset --hard <baselineSha>
  (当路径 1 的 stash pop 冲突时触发)
```

**And** 执行后 (success): 保留修改,`git stash pop` 恢复执行前的本地修改
**And** 沙箱失败回滚写 `runtime.sandbox.rollback_total` +1
**And** 路径 2 触发时写 `runtime.sandbox.rollback_path{path="fallback"}` +1

### Guarantee 等级

```typescript
type SandboxGuarantee = 'ATOMIC' | 'BEST_EFFORT' | 'NO_ROLLBACK';

interface SandboxConfig {
  guarantee: SandboxGuarantee;
  // ATOMIC: 必须回滚成功,否则 panic (默认,用于代码生成任务)
  // BEST_EFFORT: 尝试回滚,失败记录 metric 但不 panic (用于只读+少量写的混合任务)
  // NO_ROLLBACK: 不回滚 (用于纯只读操作)
}
```

**And** ATOMIC 回滚失败 (路径 1 + 路径 2 均失败) → 写 `runtime.sandbox.guarantee_violation_total` +1,任务 PANIC

**实现要点:**
- `src/runtime/sandbox.ts` — `class SandboxManager { enter(taskId, config): asserts; exit(taskId, success): Promise<void>; rollback(taskId, baselineSha): Promise<void> }`
- 用 `simple-git` 或直接子进程调 `git`(已装)
- 沙箱粒度: per-subtask,每个 subtask 独立 worktree 副本(避免 subtask 间污染)
- 与 checkpoint 联动:沙箱 enter/exit 写 checkpoint,resume 时校验"上次 sandbox 是否完整退出"
- 性能:每次 git stash 约 50ms-200ms,可接受

**Scenario: 成功提交不回滚**
- GIVEN subtask st-1 即将 spawn claude
- WHEN SandboxManager.enter("task-X-st-1")
- THEN `git stash push` 空 stash (workDir clean),记录 baselineSha
- AND claude 改 3 文件 + commit
- WHEN exit(success)
- THEN 保留 3 文件的 commit,stash list 不增加

**Scenario: 失败回滚恢复现场**
- GIVEN st-2 失败,Claude 把 trade.ts 改坏 + 删了 2 个测试
- WHEN SandboxManager.exit(failure, "task-X-st-2")
- THEN 路径 1: `git checkout -- .` 还原 trade.ts + `git clean -fd` 恢复被删测试 + `git stash pop` 还原本地修改
- AND 写 `runtime.sandbox.rollback_total` +1

**Scenario: 路径 1 冲突,路径 2 兜底**
- GIVEN st-3 失败,但 stash pop 因 merge conflict 失败
- WHEN 路径 1 的 `git stash pop` 返回非 0
- THEN 路径 2: `git reset --hard <baselineSha>` 强制回滚
- AND 写 `runtime.sandbox.rollback_path{path="fallback"}` +1
- AND workDir 回到执行前状态 (stash 中的本地修改保留在 stash list 中)

**Scenario: 冲突时拒绝派发**
- GIVEN workDir 有用户未提交的本地修改,且 `git stash push` 失败
- WHEN SandboxManager.enter("task-X-st-3")
- THEN pre-flight 第 2 步失败
- AND 抛 `SandboxEnterError`
- AND 任务标记 FAILED,飞书提示"workDir 有未提交修改,请先 commit 或 stash"

**Scenario: ATOMIC 回滚双路径均失败**
- GIVEN guarantee=ATOMIC,路径 1 和路径 2 均失败 (极端情况)
- WHEN SandboxManager.exit(failure)
- THEN 写 `runtime.sandbox.guarantee_violation_total` +1
- AND 任务 PANIC,日志记录完整 git 状态
- AND 飞书通知用户手动介入

## CAP-MAR-03 (REVISED) 结构化心跳

> **v0.11.0 修订**: 保留 30s 心跳 + 2 次丢失触发 cancel,增加进度元数据解析 + 停滞检测。Wink trajectory observation (Feb 2026): 区分"活着但卡住" vs "活着且在思考"。

**Given** adapter.send() 派发了一个子进程(claude / codex 等)
**When** 子进程每 30s 输出结构化心跳到 stdout (或 stderr)
**Then** HeartbeatWatcher 解析心跳:

```typescript
interface HeartbeatData {
  phase: 'thinking' | 'tool_call' | 'executing' | 'waiting';
  progressPct: number;          // 0-100
  currentTool?: string;         // 当前工具名
  message?: string;             // 可读描述
}
```

**And** 心跳格式:
```
__dev_brain_heartbeat__ <progress phase="execution" pct="60" msg="running tests"/> <tool>vitest</tool>
```

**And** 活性判断:
- 有心跳 + progressPct 有变化 → Agent 正常工作中
- 有心跳 + progressPct 不变 (连续 3 次) → Agent 可能卡住 (stalled),写 `runtime.heartbeat.stalled_total` +1
- 连续 2 个心跳周期未更新(>60s)→ 触发 cancel + 标记 CANCELLED with reason="heartbeat_lost"

**And** 阈值可通过 env `DEV_BRAIN_HEARTBEAT_MISSES` 调整
**And** 写 `runtime.heartbeat.received_total` +1,`runtime.heartbeat.lost_total` +1
**And** 写 `runtime.heartbeat.progress_delta` (gauge) 记录最近进度变化量

**And** 与 communication-layer 联动: HeartbeatData 自动转换为 ProgressEvent 推送飞书卡片 (CAP-COM-01)

**实现要点:**
- `src/runtime/heartbeat.ts` — `class HeartbeatWatcher { start(adapter, ctx); stop(); parseHeartbeat(line): HeartbeatData | null }`
- adapter 包装层 (LocalClaudeCodeAdapter / LocalCodexAdapter) 在 stdout 解析心跳
- 超时 = `heartbeatMisses * heartbeatIntervalMs`,默认 60s
- 停滞检测:连续 3 次相同 progressPct → stalled
- 与 state-machine 联动:心跳丢失 → 状态 CANCELLED,触发 rollback
- 不动 v0.10.0 已有 cancel 逻辑(基于 SIGTERM),只在上层加超时

**Scenario: 正常结构化心跳**
- GIVEN claude 跑一个 5min 的子任务
- WHEN claude 每 30s 输出 `__dev_brain_heartbeat__ <progress phase="execution" pct="60" msg="running tests"/> <tool>vitest</tool>`
- THEN HeartbeatWatcher 解析: phase="execution", progressPct=60, currentTool="vitest"
- AND 自动生成 ProgressEvent 推送飞书卡片,用户看到 "正在执行 vitest (60%)"
- AND 任务正常运行,无 cancel

**Scenario: 停滞检测**
- GIVEN claude 输出心跳但 progressPct 连续 3 次 = 45 (无进展)
- WHEN HeartbeatWatcher 检测停滞
- THEN 写 `runtime.heartbeat.stalled_total` +1
- AND 日志记录 stalled 警告 (不立即 cancel,给 Agent 机会)
- AND 飞书卡片显示 "处理中 (可能卡住...)"

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

## CAP-MAR-04 (REVISED) Self-Correction 闭环 — L1 归因 + Wink 分类 + 分流决策

> **v0.11.0 修订**: 原设计为"失败后自动修复"的单一修复工具。经博弈论审查发现存在囚徒困境 — Agent 的失败成本被外部化,搭便车成为占优策略。修订为 L1 归因 + Wink 双层分类 + 分流决策: 偶发失败走修复路径,系统性失败走进化路径,不可归因的失败进入待观察队列。

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

### Step 1: 双层归因分析 (Attribution)

**And** 归因引擎基于 L1 数据 (不依赖 Agent 自述的 reasoning) 产出 `Attribution`:

```
type Attribution = {
  // Layer 1 — L1 可信源 (判决依据)
  violationType: "missing_test" | "spec_violation" | "timeout" | "lint_error" | "type_error" | "unattributable";
  agentAccountable: boolean;  // 归因到 Agent 决策 vs 系统环境 (timeout/heartbeat_lost 不是 Agent 的错)
  confidence: number;         // 归因本身的置信度
  evidenceRefs: string[];     // 指向 L1 trace 中的具体字段

  // Layer 2 — Wink 分类 (辅助语义, 不参与判决)
  misbehaviorCategory?: "specification_drift" | "reasoning_problem" | "tool_call_failure";
};
```

**And** Layer 1 归因判定规则 (确定性,硬编码):
  - `acceptance.stage="test" AND result="fail"` → violationType="missing_test", agentAccountable=true
  - `acceptance.stage="lint" AND result="fail"` → violationType="lint_error", agentAccountable=true (大概率)
  - `heartbeat.lostBeats > 0` → violationType="timeout", agentAccountable=false (非 Agent 可控)
  - 无法从 L1 数据判定 → violationType="unattributable" (不强行归因,避免 Agent 因恐惧误判而保守)

**And** Layer 2 Wink 分类 (辅助,不参与判决):
  - `specification_drift` — Agent 偏离了 spec 意图 (如少实现一个需求点)
  - `reasoning_problem` — 逻辑错误或死循环 (如无限重试同一个错误)
  - `tool_call_failure` — API/工具使用错误 (如传错参数类型)

**And** 写 `self_correction.attribution_total{violationType, agentAccountable}` +1
**And** 写 `self_correction.misbehavior_total{category}` +1 (Wink 分类计数)

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
  3. 若 Wink 分类可用,追加针对性修复建议:
     - specification_drift → 强化 spec 约束
     - reasoning_problem → 提供反例 + 要求 Agent 写 reasoning before code
     - tool_call_failure → 检查 tool schema + 提供备选工具路径
  4. 重新 spawn,最多 2 次

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

**Scenario: Wink 分类辅助修复**
- GIVEN Agent 失败,归因 violationType="spec_violation"
- WHEN Wink 分类: misbehaviorCategory="specification_drift"
- THEN 修复 prompt 追加 "偏离了 spec 要求,请重新阅读 spec 第 3 条并确保实现覆盖所有需求点"
- AND 强化 spec 约束后重新 spawn

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
- `src/runtime/attribution-engine.ts` — `class AttributionEngine { analyze(trace): Attribution; classifyWink(trace, attribution): MisbehaviorCategory }` (纯函数,确定性规则)
- 复用 v0.10.0 RecallStrategy (CAP-CTX-03 失败重试前节点) 注入相关 context
- 与 state-machine 联动: 
  - 修复路径 → RETRYING → RUNNING
  - 进化路径 → FAILED (等待 Evolution)
  - 升级路径 → FAILED (等待用户)

## CAP-MAR-05 (REVISED) 分层验收金字塔

> **v0.11.0 修订**: 保留 4 阶段验收,改为分层执行: FastGate (fail-fast) → CoreGate → ReviewGate (非阻塞)。Gearset Agentforce Testing: 快速失败节省时间,非阻塞 review 避免瓶颈。

**Given** subtask 成功跑完(adapter.send done)
**When** AcceptancePipeline 介入
**Then** 按分层金字塔执行:

```
FastGate (< 30s, fail-fast)
  ├── lint: pnpm lint <changed-files>
  └── typecheck: pnpm typecheck --noEmit
  ↓ pass (任一失败立即 FAILED)
CoreGate (< 2min)
  └── unit test: pnpm test <changed-package>
  ↓ pass
ReviewGate (non-blocking, advisory)
  └── reviewer agent: spawn codex as reviewer
      (产出 review comments, 不阻塞 SUCCESS)
```

**And** FastGate 任一失败 → 立即 FAILED,不跑 CoreGate (节省时间)
**And** CoreGate 失败 → subtask FAILED with reason=具体阶段
**And** ReviewGate 改为**非阻塞**: 产出 review comments 写 `~/.dev-brain/acceptance-reviews/<taskId>.md`,但 subtask 仍然 SUCCESS
**And** Reviewer agent timeout 从 5min → 2min
**And** 全部通过 (FastGate + CoreGate) → subtask 真正 SUCCESS,触发 TaskDoneCard (CAP-COM-04)
**And** 写 `runtime.acceptance.{stage}_total{result=pass|fail}` counter

**实现要点:**
- `src/runtime/acceptance-pipeline.ts` — `class AcceptancePipeline { run(subtask, artifacts): Promise<AcceptanceResult> }`
- FastGate/CoreGate/ReviewGate 作为独立阶段,支持单独 timeout
- 复用 v0.10.0 HeartbeatWatcher 监控 acceptance 子进程(也会卡)
- Reviewer agent:走 v0.8.0 native backend,prompt 模板 "你是 code reviewer,看这个 diff,给出 ≤ 5 条 review comments"
- 测试失败兜底:`pnpm test` 5min 超时 → FAILED,记 timeout

**Scenario: FastGate 快速失败**
- GIVEN Agent 产出的代码有 lint error
- WHEN FastGate 跑 lint
- THEN < 10s 发现 lint error → 立即 FAILED
- AND 不浪费 2min 跑 CoreGate 测试
- AND Self-Correction 收到精确的 lint_error 归因

**Scenario: 单测通过全链路绿**
- GIVEN subtask 改 trade.ts + 加 test/trade.test.ts
- WHEN AcceptancePipeline.run
- THEN FastGate: lint 0 error + typecheck 0 error → pass
- AND CoreGate: `pnpm test trade.test.ts` → 12/12 pass
- AND ReviewGate: reviewer agent 产出 review comments (非阻塞,subtask 已 SUCCESS)
- AND subtask 升级为 SUCCESS

**Scenario: CoreGate 失败被捕获**
- GIVEN subtask 输出有 bug,3/12 测试 fail
- WHEN AcceptancePipeline.run → FastGate pass → CoreGate
- THEN CoreGate 失败,subtask FAILED with reason="test_failed"
- AND 触发 Self-Correction(CAP-MAR-04),归因 violationType="missing_test"
- AND Self-Correction 后再跑验收

**Scenario: Reviewer agent 提改进建议但通过**
- GIVEN subtask 改完,reviewer agent 产出 3 条建议("变量名可优化","少一个边界 case")
- WHEN AcceptancePipeline.run → ReviewGate
- THEN 视为"有建议但通过",subtask 仍 SUCCESS (ReviewGate 非阻塞)
- AND review comments 写 `~/.dev-brain/acceptance-reviews/<taskId>.md` 供用户翻阅
- AND 不阻塞主任务

---

## 新增 Metric 汇总

```
# Checkpoint (CAP-MAR-01)
runtime.checkpoint.saved_total           — checkpoint 写入次数
runtime.checkpoint.load_total            — checkpoint 恢复次数
runtime.checkpoint.corrupt_total         — checkpoint 损坏次数 (应趋近 0)

# Sandbox (CAP-MAR-02)
runtime.sandbox.rollback_path{primary|fallback} — 回滚路径分布
runtime.sandbox.preflight_failed_total   — pre-flight 校验失败
runtime.sandbox.guarantee_violation_total — ATOMIC 回滚失败 (应=0)

# Heartbeat (CAP-MAR-03)
runtime.heartbeat.stalled_total          — 有心跳但无进展
runtime.heartbeat.progress_delta         — 进度变化量 (gauge)

# Self-Correction (CAP-MAR-04)
runtime.self_correction.misbehavior_total{category} — Wink 分类计数
```
