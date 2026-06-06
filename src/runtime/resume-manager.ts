/**
 * ResumeManager — CAP-RT-07
 *
 * Daemon 启动时扫 checkpoint 目录,找所有 state="in_progress" 的任务,
 * 自动续跑。
 *
 * 责任:
 *  - 列出待续跑任务 (CheckpointManager.listInProgress)
 *  - 校验任务有效性 (例: trace_id 是否仍在 audit log;此处简化)
 *  - 提供续跑 handler (调用方注入,Resume 只决策不直接执行子任务)
 *
 * 设计: ResumeManager 不直接执行,而是产出 ResumePlan,由 BrainEngine 接管。
 * 这样 ResumeManager 单元可测,无需 mock 整个 engine。
 */

import { defaultLogger, type Logger } from "../core/logger.js";
import { getMetrics, safe } from "../observability/metrics.js";
import { CheckpointManager } from "./checkpoint.js";
import type { CheckpointSnapshot, SubTaskPlan } from "./types.js";

export interface ResumePlan {
  readonly trace_id: string;
  readonly task_id: string;
  readonly current_step: string;
  readonly remaining_subtasks: ReadonlyArray<SubTaskPlan>;
  readonly originalStartedAt: string;
  readonly checkpointAt: string;
  readonly completedCount: number;
}

export interface AuditValidator {
  /** 返回 true 表示 trace 仍合法可恢复;false 表示 stale(用户已 cancel 或 too old) */
  isValid(traceId: string): Promise<boolean>;
}

export interface ResumeManagerDeps {
  readonly checkpointManager: CheckpointManager;
  readonly auditValidator?: AuditValidator;
  readonly logger?: Logger;
  /** 超过此年龄的 checkpoint 直接 skip (默认 7 天) */
  readonly maxAgeSec?: number;
  readonly now?: () => Date;
}

export class ResumeManager {
  private readonly checkpointManager: CheckpointManager;
  private readonly auditValidator?: AuditValidator;
  private readonly logger: Logger;
  private readonly maxAgeSec: number;
  private readonly now: () => Date;
  private readonly metrics = getMetrics();

  constructor(deps: ResumeManagerDeps) {
    this.checkpointManager = deps.checkpointManager;
    this.auditValidator = deps.auditValidator;
    this.logger =
      deps.logger ?? defaultLogger.child({ component: "resume-manager" });
    this.maxAgeSec = deps.maxAgeSec ?? 7 * 24 * 3600;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * 扫所有 in_progress 任务,过滤无效,返回需要续跑的 ResumePlan 列表。
   */
  async scan(): Promise<ReadonlyArray<ResumePlan>> {
    const snapshots = await this.checkpointManager.listInProgress();
    if (snapshots.length === 0) {
      this.logger.debug("no in_progress checkpoints found");
      return [];
    }

    const plans: ResumePlan[] = [];
    const nowMs = this.now().getTime();

    for (const snap of snapshots) {
      if (!this.isFreshEnough(snap, nowMs)) {
        this.logger.warn("checkpoint too old; skipping", {
          trace_id: snap.trace_id,
          age_sec: this.ageSec(snap, nowMs),
        });
        continue;
      }

      if (this.auditValidator) {
        const ok = await this.auditValidator.isValid(snap.trace_id);
        if (!ok) {
          this.logger.warn("checkpoint failed audit; clearing", {
            trace_id: snap.trace_id,
          });
          await this.checkpointManager.clear(snap.trace_id).catch(() => {});
          continue;
        }
      }

      plans.push(this.toResumePlan(snap));
    }

    this.logger.info("resume scan complete", {
      total_in_progress: snapshots.length,
      to_resume: plans.length,
    });
    for (let i = 0; i < plans.length; i += 1) {
      safe(() => this.metrics.inc("runtime.resume_total"), undefined);
    }
    return plans;
  }

  /** 标记某 trace 已成功完成续跑(清理 checkpoint) */
  async markResumed(traceId: string): Promise<void> {
    // 实际清理交给 BrainEngine 在任务真正完成后做,这里仅留 hook
    this.logger.info("resume completed", { trace_id: traceId });
  }

  private toResumePlan(snap: CheckpointSnapshot): ResumePlan {
    return {
      trace_id: snap.trace_id,
      task_id: snap.task_id,
      current_step: snap.current_step,
      remaining_subtasks: snap.pending_subtasks,
      originalStartedAt: snap.started_at,
      checkpointAt: snap.last_checkpoint_at,
      completedCount: snap.completed_subtasks.length,
    };
  }

  private isFreshEnough(snap: CheckpointSnapshot, nowMs: number): boolean {
    return this.ageSec(snap, nowMs) <= this.maxAgeSec;
  }

  private ageSec(snap: CheckpointSnapshot, nowMs: number): number {
    const t = Date.parse(snap.last_checkpoint_at);
    if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
    return Math.max(0, Math.round((nowMs - t) / 1000));
  }
}
