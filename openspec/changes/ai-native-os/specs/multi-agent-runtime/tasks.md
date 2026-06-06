---
demand-id: DM-20260606-003
change: ai-native-os
module: multi-agent-runtime
status: developing
---

# Multi-Agent Runtime — Tasks

> **v0.11.0 修订**: 经行业调研 (LangGraph 1.0 checkpointing / 事务性快照论文 / Wink 自干预 / 分层验收), 原始设计增强为: CheckpointStore 持久化 + 双保险沙箱回滚 + 结构化心跳 + Wink 双层分类 + 分层验收金字塔。详见 `design.md`。

## 1. 类型骨架

- [ ] `src/runtime/types.ts` — 定义 `SubtaskState` / `CheckpointContext` / `CheckpointData` / `HeartbeatData` / `SandboxConfig` / `SandboxGuarantee` / `Attribution` / `MisbehaviorCategory` / `AcceptanceStage` / `AcceptanceResult` / `L1FailureTrace`
- [ ] `src/observability/metrics.ts` 注册 runtime 新增 metric: checkpoint 系列 (3 个) / sandbox 系列 (3 个) / heartbeat 系列 (2 个) / self-correction 系列 (2 个)

## 2. StateMachine + CheckpointStore (CAP-MAR-01)

### 2.a StateMachine

- [ ] `src/runtime/state-machine.ts` — `class SubtaskStateMachine { transition(from, to, ctx): asserts valid; canTransition(from, to): boolean; ALLOWED: Map<State, Set<State>> }`
- [ ] 6 状态 discriminated union: `type State = "pending" | "running" | "retrying" | "success" | "failed" | "cancelled"`
- [ ] 6 个迁移边: PENDING→RUNNING / RUNNING→SUCCESS / RUNNING→RETRYING / RETRYING→RUNNING / RUNNING→FAILED / RUNNING→CANCELLED
- [ ] 非法迁移抛 `IllegalStateTransitionError`,写 `runtime.subtask.illegal_transition_total{from,to}` +1
- [ ] 合法迁移写 `runtime.subtask.state_transition_total{from,to}` +1
- [ ] 替换 v0.10.0 orchestrator.ts 里散落的 `if (status === "running") ...`
- [ ] 单测 `tests/unit/runtime/state-machine.test.ts`: 5 场景 (正常 SUCCESS/重试循环/非法迁移被拒/用户取消/CANCELLED 后不可迁移)

### 2.b CheckpointStore

- [ ] `src/runtime/checkpoint-store.ts` — `class CheckpointStore { save(state, ctx): Promise<void>; load(taskId): Promise<SubtaskState | null>; validate(stored, expected): boolean }`
- [ ] 每次合法 transition 后异步写 checkpoint (不阻塞状态迁移)
- [ ] 持久化内容: `{ taskId, subtaskId, state, transitionHistory[], agentName, sandboxBaselineSha, attemptNumber, savedAt }`
- [ ] 存储路径: `~/.dev-brain/checkpoints/<taskId>/subtask-<n>.json`
- [ ] resume 时读取 checkpoint,校验状态合法性后继续执行
- [ ] checkpoint 损坏时写 `runtime.checkpoint.corrupt_total` +1,任务标记 FAILED
- [ ] 写 metric: `runtime.checkpoint.saved_total` / `runtime.checkpoint.load_total` / `runtime.checkpoint.corrupt_total`
- [ ] 单测 `tests/unit/runtime/checkpoint-store.test.ts`: 4 场景 (正常写入+加载/crash 恢复/校验不一致/损坏文件)

## 3. SandboxManager — 双保险沙箱 (CAP-MAR-02)

- [ ] `src/runtime/sandbox.ts` — `class SandboxManager { enter(taskId, config): asserts; exit(taskId, success): Promise<void>; rollback(taskId, baselineSha): Promise<void> }`

### 3.a Pre-flight 校验

- [ ] `enter()`: 5 步 pre-flight 校验
  1. `git status --porcelain` 检查 workDir
  2. `git stash push -u -m "sandbox-<taskId>"` 暂存本地修改
  3. 验证 stash 成功: `git stash list | grep sandbox-<taskId>`
  4. 记录 baseline: `git rev-parse HEAD` → baselineSha
  5. 任一失败 → 抛 `SandboxEnterError`,任务 FAILED,飞书提示
- [ ] 写 `runtime.sandbox.preflight_failed_total` +1 (pre-flight 失败时)

### 3.b 双路径回滚

- [ ] `exit(success=false)`: 双路径回滚
  - 路径 1 (优先): `git checkout -- .` + `git clean -fd` + `git stash pop`
  - 路径 2 (兜底): `git reset --hard <baselineSha>` (路径 1 的 stash pop 冲突时触发)
- [ ] `exit(success=true)`: 保留修改,仅 `git stash pop` 恢复执行前本地修改
- [ ] 写 `runtime.sandbox.rollback_total` +1
- [ ] 路径 2 触发时写 `runtime.sandbox.rollback_path{path="fallback"}` +1

### 3.c Guarantee 等级

- [ ] `SandboxGuarantee` 类型: `'ATOMIC' | 'BEST_EFFORT' | 'NO_ROLLBACK'`
- [ ] ATOMIC (默认): 双路径均失败 → 写 `runtime.sandbox.guarantee_violation_total` +1,任务 PANIC
- [ ] BEST_EFFORT: 双路径均失败 → 写 metric 但不 panic
- [ ] NO_ROLLBACK: 不回滚 (只读操作)

### 3.d 与 checkpoint 联动

- [ ] sandbox enter/exit 写 checkpoint,resume 时校验"上次 sandbox 是否完整退出"
- [ ] 沙箱粒度: per-subtask,每个 subtask 独立 worktree 副本

### 3.e 测试

- [ ] 单测 `tests/unit/runtime/sandbox.test.ts`: 5 场景 (成功提交/失败回滚路径1/路径1冲突路径2兜底/冲突拒绝/ATOMIC 双路径失败)

## 4. HeartbeatWatcher — 结构化心跳 (CAP-MAR-03)

- [ ] `src/runtime/heartbeat.ts` — `class HeartbeatWatcher { start(adapter, ctx); stop(); parseHeartbeat(line): HeartbeatData | null }`

### 4.a 结构化心跳解析

- [ ] 心跳格式: `__dev_brain_heartbeat__ <progress phase="execution" pct="60" msg="running tests"/> <tool>vitest</tool>`
- [ ] 解析产出 `HeartbeatData { phase, progressPct, currentTool?, message? }`
- [ ] adapter 包装层 (LocalClaudeCodeAdapter / LocalCodexAdapter) 在 stdout 解析心跳

### 4.b 三级活性判断

- [ ] 有心跳 + progressPct 有变化 → Agent 正常 (更新 last_heartbeat_at)
- [ ] 有心跳 + progressPct 不变 (连续 3 次) → stalled,写 `runtime.heartbeat.stalled_total` +1,日志警告
- [ ] 连续 2 个心跳周期无更新 (>60s by default) → 触发 cancel + CANCELLED
- [ ] 阈值 env `DEV_BRAIN_HEARTBEAT_MISSES` 可调
- [ ] 写 `runtime.heartbeat.received_total` / `runtime.heartbeat.lost_total` / `runtime.heartbeat.progress_delta` (gauge)

### 4.c 与 communication-layer 联动

- [ ] HeartbeatData 自动转换为 ProgressEvent 推送飞书卡片 (CAP-COM-01)
- [ ] 用户可看到 "正在执行 vitest (60%)" 而非仅 "思考中..."

### 4.d 测试

- [ ] 单测 `tests/unit/runtime/heartbeat.test.ts`: 5 场景 (正常结构化心跳/停滞检测/心跳丢失/自定义阈值/无 token 旧格式兼容)

## 5. SelfCorrector + AttributionEngine + Wink 分类 (CAP-MAR-04)

### 5.a AttributionEngine (L1 归因 + Wink 分类)

- [ ] `src/runtime/attribution-engine.ts` — `class AttributionEngine { analyze(trace: L1FailureTrace): Attribution; classifyWink(trace, attribution): MisbehaviorCategory }`
- [ ] L1 可信源 5 字段: specRef / gitDiff / acceptance / heartbeat / sandbox
- [ ] 归因规则 (确定性,硬编码):
  - `acceptance.test=fail` → missing_test, agentAccountable=true
  - `acceptance.lint=fail` → lint_error, agentAccountable=true
  - `acceptance.typecheck=fail` → type_error, agentAccountable=true
  - `heartbeat.lostBeats>0` → timeout, agentAccountable=false
  - 无法判定 → unattributable
- [ ] Wink 3 类分类 (辅助,不参与判决): specification_drift / reasoning_problem / tool_call_failure
- [ ] 写 `self_correction.attribution_total{violationType, agentAccountable}` +1
- [ ] 写 `self_correction.misbehavior_total{category}` +1
- [ ] 单测 `tests/unit/runtime/attribution-engine.test.ts`: 5 场景 (missing_test/spec_violation/timeout/unattributable/Wink 分类)

### 5.b SelfCorrector (分流 + 修复)

- [ ] `src/runtime/self-correction.ts` — `class SelfCorrector { attribute(failure): Attribution; triage(attribution): Path; correct(ctx, attribution): Promise<CorrectedPrompt> }`
- [ ] 3 步流程: Step 1 归因 (attribution-engine) → Step 2 分流 (修复/进化/升级) → Step 3 修复执行 (仅修复路径)
- [ ] 分流逻辑:
  - 修复路径: hf < 5% AND violationType ≠ "unattributable" → 重写 prompt + 重试 (最多 2 次)
  - 进化路径: hf ≥ 5% OR 同模式 7 天 ≥ 3 次 → 产出 Insight 进 Evolution Pipeline
  - 升级路径: 不可恢复 (401) / 能力边界 → 升级用户
- [ ] 修复执行: 重读 spec → 附加归因报告 → Wink 分类建议 (可选) → 重新 spawn
- [ ] unattributable → 待观察队列, ≥ 5 条同 pattern 重新归因
- [ ] 与 CAP-EVO-01 联动: attribution 数据作为 insight-engine 的输入
- [ ] 写 `self_correction.triage_total{path}` / `self_correction.unattributable_queue_size` (gauge)
- [ ] 写 `runtime.self_correction.triggered_total` / `runtime.self_correction.repair_success_total`
- [ ] 一次 self-correction 成功率目标 ≥ 40%
- [ ] env `DEV_BRAIN_SELF_CORRECTION_MAX_ATTEMPTS=2` 可调
- [ ] 单测 `tests/unit/runtime/self-correction.test.ts`: 6 场景 (修复路径成功/进化路径/升级路径/unattributable 待观察/Wink 分类修复/N 次上限升级)

## 6. AcceptancePipeline — 分层验收金字塔 (CAP-MAR-05)

- [ ] `src/runtime/acceptance-pipeline.ts` — `class AcceptancePipeline { run(subtask, artifacts): Promise<AcceptanceResult> }`

### 6.a FastGate (< 30s, fail-fast)

- [ ] `lint`: `pnpm lint <changed-files>`
- [ ] `typecheck`: `pnpm typecheck --noEmit`
- [ ] 任一失败 → 立即 FAILED,不跑 CoreGate
- [ ] 写 `runtime.acceptance.lint_total{result}` / `runtime.acceptance.typecheck_total{result}`

### 6.b CoreGate (< 2min)

- [ ] `unit test`: `pnpm test <changed-package>` (或全量,env 配)
- [ ] 失败 → subtask FAILED with reason="test_failed"
- [ ] 5min timeout 兜底
- [ ] 写 `runtime.acceptance.test_total{result}`

### 6.c ReviewGate (non-blocking, advisory)

- [ ] Reviewer agent: spawn codex as reviewer, prompt "你是 code reviewer,看这个 diff,给出 ≤ 5 条 review comments"
- [ ] 非阻塞: 产出 review comments 写 `~/.dev-brain/acceptance-reviews/<taskId>.md`
- [ ] Timeout 2min
- [ ] subtask 仍 SUCCESS (不因 review 建议而阻塞)
- [ ] env `DEV_BRAIN_REVIEWER_ENABLED` 控制开关

### 6.d 测试

- [ ] 单测 `tests/unit/runtime/acceptance-pipeline.test.ts`: 5 场景 (FastGate 快速失败/CoreGate 失败/全链路通过/ReviewGate 建议但通过/timeout)

## 集成

### 与 orchestrator 集成

- [ ] `src/runtime/orchestrator.ts` — 替换 ad-hoc retry 为 state-machine (F.3 2.a) + self-correction (F.3 5.b)
- [ ] 派发前走 SandboxManager.enter(),完成后走 exit(),失败走 rollback()
- [ ] 派发后启动 HeartbeatWatcher,心跳丢失 → cancel + rollback
- [ ] 完成后走 AcceptancePipeline,分层验收

### 与 brain-engine 集成

- [ ] `src/brain/brain-engine.ts` — 接入 acceptance-pipeline (F.3 6),subtask 完成后自动触发验收
- [ ] 接入 self-correction,失败 subtask 自动进入归因+分流流程

### 与 evolution 集成

- [ ] Self-Correction 进化路径 → 产出 Insight → Evolution Pipeline (CAP-EVO-01)
- [ ] attribution 数据作为 insight-engine 的第四类输入 (failure trace)

### 与 communication-layer 集成

- [ ] HeartbeatData → ProgressEvent 推送飞书卡片 (CAP-COM-01)
- [ ] 验收结果 → TaskDoneCard (CAP-COM-04)
- [ ] 沙箱 PANIC → 飞书通知用户手动介入

## 验证

- [ ] `pnpm typecheck` 绿
- [ ] `pnpm test` 绿 (runtime 模块新增 ~25 测试场景)
- [ ] `pnpm test:coverage` 维持 85%/74%
- [ ] Self-correction 一次成功率 ≥ 40% (在 eval suite 测)
- [ ] 心跳误杀率 < 1% (1000 任务统计)
- [ ] 沙箱回滚成功率 100% (路径 1 + 路径 2 兜底)
- [ ] CheckpointStore: crash → resume 路径验证
