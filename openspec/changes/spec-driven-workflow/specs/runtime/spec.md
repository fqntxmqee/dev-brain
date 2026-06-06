---
demand-id: DM-20260606-002
change: spec-driven-workflow
status: developing
---

# Long-Running Runtime Spec (Delta — v0.10.0)

"长程" = 任务能跑 2-8 小时不挂,崩溃后能续跑,上下文累积能 summarize 续命。

## CAP-RT-01 (NEW) Checkpoint 持久化

**Given** BrainEngine 启动长任务 (执行时长 > `runtimeLongTaskThresholdSec=300`)
**When** Runtime 执行子任务
**Then** 每 `checkpointIntervalSec=60` 写一次状态到 `~/.dev-brain/checkpoints/{trace_id}.json`
**And** 状态包含:
  - `trace_id: string`
  - `task_id: string`
  - `started_at: ISO8601`
  - `last_checkpoint_at: ISO8601`
  - `current_step: string` (e.g. "subtask:st-3:implementing")
  - `completed_subtasks: SubTaskResult[]`
  - `pending_subtasks: SubTaskPlan[]`
  - `context_state: { tokens_used: number, last_summarise_at?: ISO8601 }`
  - `version: 1`
**And** 写盘用 `writeFile(tmp); rename(tmp, real)` 原子操作
**And** 滚动保留最近 5 个 checkpoint (`{trace_id}.{n}.json`)

**Scenario: 进程崩溃 5min 后恢复**
- GIVEN checkpoint @ T0 写入
- WHEN 进程在 T0+3min OOM 崩溃
- THEN 用户重启 daemon
- AND ResumeManager 扫到 `~/.dev-brain/checkpoints/`,发现 in_progress 状态
- AND 自动从 T0 的 current_step 续跑,跳过已完成的子任务
- AND `runtime.resume_count` counter +1

**Scenario: 磁盘写满**
- GIVEN `~/.dev-brain/checkpoints/` 满 (>10MB 或 inode 满)
- WHEN 写 checkpoint 失败
- THEN 抛 `CheckpointWriteError`,BrainEngine 降级为 in-memory 状态,日志告警
- AND 任务继续跑但下次崩溃无法恢复;metric `runtime.checkpoint.write_failed_total` +1

## CAP-RT-02 (NEW) 上下文预算管理

**Given** Runtime 持续调用 LLM 累计 token
**When** `context_state.tokens_used > contextBudgetMaxTokens=150000` (config)
**Then** 触发 `auto-summarise`:
  - 取最近 2 轮 (config: `summariseRecentRounds=2`) 完整保留 (~20K tokens)
  - 早期对话压缩为摘要 (用 MiniMax haiku 摘要,目标 ≤ 5K tokens)
  - `context_state.last_summarise_at` 更新
  - 写 `runtime.context_budget_triggers` counter +1
**And** Summarise 失败 → 抛 `ContextSummariseError`,BrainEngine 终止当前子任务并准备 resume

**Scenario: 2h 长任务 4 次 summarise**
- GIVEN 长任务跑了 2h,token 累计 600K
- WHEN 每次到 150K 阈值
- THEN 触发 4 次 summarise,每次保留最近 20K + 摘要 5K,总上下文始终 ≤ 25K
- AND 任务从开始到结束未出现 "context_length_exceeded" 错误

**Scenario: summarise 本身失败**
- GIVEN haiku API 5min 不可用
- WHEN 触发 summarise
- THEN 抛 ContextSummariseError
- AND BrainEngine 终止子任务,写 checkpoint 标记 `paused_for_context`
- AND 飞书通知用户"上下文超限已暂停,需手动 resume 或拆任务"

## CAP-RT-03 (NEW) 子任务重试与退避

**Given** 子任务 (LocalClaudeCodeAdapter / LocalCodexAdapter / LocalCursorAdapter.send) 失败
**When** Runtime 捕获非 `retryable: false` 的错误
**Then** 进入指数退避重试:
  - attempt 1 → wait 1s
  - attempt 2 → wait 2s
  - attempt 3 → wait 4s
  - attempt 4 → wait 8s
  - attempt 5 → wait 16s (max attempts=5, config)
**And** 每次重试前更新 checkpoint `current_step` 为 `retrying:subtask-id`
**And** `runtime.retry_total` counter +1,label `status:success|failed`

**Scenario: codex 偶发超时 1 次重试成功**
- GIVEN 子任务 st-2 codex 调用超时
- WHEN Runtime 捕获
- THEN 等 1s 重试
- AND 第 2 次成功,子任务通过
- AND `runtime.retry_total{status="success"}` +1

**Scenario: 持续失败耗尽重试**
- GIVEN 子任务 5 次都失败
- WHEN 第 5 次重试结束
- THEN 抛 SubTaskFailedError
- AND 进入 CAP-RT-04 (回辩论重澄清) 流程

## CAP-RT-04 (NEW) 失败重辩论 (回上游)

**Given** 子任务 5 次重试都失败 (或 hard error)
**When** Runtime 决策
**Then** 不直接判任务失败,而是:
  - 1) 重新调用 ClarifyLoop (复用 CAP-DEB-01/02/03)
  - 2) 携带失败上下文: `failed_subtask_id` + 错误信息 + 5 次重试的 stderr
  - 3) 辩论只重跑 Round 1 (基于失败信息快速收敛)
  - 4) 如果新共识提出"应放弃某子任务"或"修改任务定义",BrainEngine 更新 plan
**And** `runtime.redebate_count` counter +1
**And** maxRedebate=2 (config),超限才判任务失败

**Scenario: codex 持续 5 次失败后重辩论挽救**
- GIVEN codex 在某个环境配置下持续 5 次失败
- WHEN Runtime 触发重辩论
- THEN ClarifyLoop 跑 R1,共识率 0.92
- AND 新共识:"此子任务改用 claude 即可"
- AND BrainEngine 重派 claude,任务继续

**Scenario: 重辩论 2 次仍失败**
- GIVEN 同一子任务重辩论 2 次仍未解决
- WHEN 第 2 次辩论结束
- THEN 判任务失败,写 audit
- AND 飞书通知用户"任务 X 在子任务 st-2 失败,已尝试重辩论 2 次,需人工干预"

## CAP-RT-05 (NEW) 限流感知

**Given** Runtime 调用 LLM (Claude / Codex / DeepSeek)
**When** API 返 429 (rate limited)
**Then** Runtime 进入 `rate_limited` 状态:
  - 1) 把当前子任务挂起,checkpoint 标记 `paused_for_rate_limit`
  - 2) 排队等待 `rateLimitBackoffSec=30`
  - 3) 30s 后重试;若再次 429,backoff 翻倍 (60s, 120s, ...)
  - 4) 持续 429 超过 `rateLimitMaxWaitSec=300` (5min),降级到 MiniMax haiku (如可)
  - 5) 持续 429 超过 `rateLimitMaxWaitSec=600` (10min),抛 RateLimitStuckError,任务暂停

**Scenario: MiniMax 偶发 429**
- GIVEN 跑了 30min 后 MiniMax 返 429
- WHEN Runtime 捕获
- THEN 队列等 30s
- AND 重试成功,子任务继续
- AND `runtime.rate_limit.encountered_total` +1

**Scenario: 持续 429 降级 haiku**
- GIVEN MiniMax 持续 429 超过 5min
- WHEN 降级触发
- THEN 后续调用走 MiniMax haiku
- AND 飞书通知用户"已自动降级到 haiku (慢但稳)"

## CAP-RT-06 (NEW) 长任务进度上报

**Given** 长任务运行中
**When** Runtime tick (每 `progressReportIntervalSec=30`)
**Then** 写进度到 `~/.dev-brain/runtime/{trace_id}.json`:
  - `progress_pct: number` (0-100,基于 completed_subtasks / total_subtasks)
  - `elapsed_sec: number`
  - `eta_sec: number` (基于已完成子任务平均耗时线性外推)
  - `tokens_used: number`
  - `checkpoints_written: number`
  - `current_step: string`
**And** 若飞书 chat 在线,每 5min 推一次进度卡片 (避免刷屏)

**Scenario: 飞书 /status 增强**
- GIVEN 长任务已跑 1h
- WHEN 用户发 /status
- THEN Gateway 读 runtime/{trace_id}.json
- AND 卡片显示:`进度 65% | 已用 60m | 预计还需 32m | tokens 280K/500K | checkpoint @ 1m`

## CAP-RT-07 (NEW) 启动续跑

**Given** Daemon 启动 (冷启动或重启)
**When** ResumeManager 跑
**Then** 扫 `~/.dev-brain/runtime/` 找所有 `state: "in_progress"` 的任务
**And** 对每个:
  - 读最新 checkpoint
  - 验证 trace_id 仍在 audit.log 存在 (防 stale)
  - 自动从 current_step 续跑
  - 写 `runtime.resume_count` counter +1
**And** 续跑时新 trace_id (续跑子段 trace) 但 root_trace_id 保留方便回查

**Scenario: 凌晨崩溃早上恢复**
- GIVEN 长任务昨晚 23:00 开始,2:00 OOM 崩溃
- WHEN 早上 9:00 用户启动 daemon
- THEN ResumeManager 扫到 in_progress,自动续跑
- AND 飞书通知 "任务 X 已自动续跑,从 65% 继续"

**Scenario: 用户手动取消**
- GIVEN 用户在崩溃前已发 /cancel
- WHEN ResumeManager 启动
- THEN 跳过已 cancel 的任务(读 state: "cancelled")
- AND 清理 checkpoint 文件
