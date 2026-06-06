/**
 * Runtime 子系统的 schema
 * 对应 OpenSpec: openspec/changes/spec-driven-workflow/specs/runtime/spec.md
 *
 * 核心抽象:
 *   - Checkpoint: 任务执行状态快照(可恢复)
 *   - ContextBudget: token 累计 + 触发摘要
 *   - RetryPolicy: 指数退避
 *   - ProgressSnapshot: 给 /status 用的进度文件
 *   - ResumeManager: 启动续跑
 */

/** 子任务计划(简化版,真实由 BrainEngine 提供) */
export interface SubTaskPlan {
  readonly id: string;
  readonly runtime: string;
  readonly prompt: string;
  readonly workDir?: string;
}

/** 子任务结果 */
export interface SubTaskResult {
  readonly id: string;
  readonly runtime: string;
  readonly status: "success" | "failed" | "cancelled";
  readonly output?: string;
  readonly error?: string;
  readonly durationMs: number;
}

/** CAP-RT-01: Checkpoint 快照 */
export interface CheckpointSnapshot {
  readonly trace_id: string;
  readonly task_id: string;
  readonly started_at: string; // ISO8601
  readonly last_checkpoint_at: string;
  readonly current_step: string;
  readonly completed_subtasks: ReadonlyArray<SubTaskResult>;
  readonly pending_subtasks: ReadonlyArray<SubTaskPlan>;
  readonly context_state: {
    readonly tokens_used: number;
    readonly last_summarise_at?: string;
  };
  readonly state: "in_progress" | "completed" | "failed" | "cancelled";
  readonly version: 1;
}

/** CAP-RT-06: 进度快照(给 /status) */
export interface ProgressSnapshot {
  readonly trace_id: string;
  readonly task_id: string;
  readonly progress_pct: number; // 0-100
  readonly elapsed_sec: number;
  readonly eta_sec: number;
  readonly tokens_used: number;
  readonly checkpoints_written: number;
  readonly current_step: string;
  readonly updated_at: string;
}

/** CAP-RT-03: 单次重试结果 */
export interface RetryAttempt {
  readonly attempt: number;
  readonly waitedMs: number;
  readonly status: "success" | "failed";
  readonly errorMessage?: string;
}

/** 通用 runtime config */
export interface RuntimeConfig {
  readonly checkpointDir: string;
  readonly progressDir: string;
  readonly checkpointIntervalSec: number;
  readonly checkpointMaxKeep: number;
  readonly contextBudgetMaxTokens: number;
  readonly summariseRecentRounds: number;
  readonly retryMaxAttempts: number;
  readonly retryBaseBackoffMs: number;
  readonly progressReportIntervalSec: number;
  readonly longTaskThresholdSec: number;
}

export class CheckpointWriteError extends Error {
  readonly code = "CHECKPOINT_WRITE_ERROR";
  constructor(
    public readonly traceId: string,
    cause: unknown,
  ) {
    super(
      `Failed to write checkpoint for ${traceId}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "CheckpointWriteError";
  }
}

export class ContextSummariseError extends Error {
  readonly code = "CONTEXT_SUMMARISE_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "ContextSummariseError";
  }
}

export class SubTaskFailedError extends Error {
  readonly code = "SUBTASK_FAILED_ERROR";
  readonly attempts: ReadonlyArray<RetryAttempt>;
  readonly subtaskId: string;
  constructor(subtaskId: string, attempts: ReadonlyArray<RetryAttempt>) {
    super(`Subtask ${subtaskId} failed after ${attempts.length} attempts`);
    this.name = "SubTaskFailedError";
    this.attempts = attempts;
    this.subtaskId = subtaskId;
  }
}

export class RateLimitStuckError extends Error {
  readonly code = "RATE_LIMIT_STUCK_ERROR";
  constructor(public readonly waitedSec: number) {
    super(`Rate limit stuck after ${waitedSec}s of backoff`);
    this.name = "RateLimitStuckError";
  }
}
