/**
 * RetryPolicy — CAP-RT-03
 *
 * 指数退避: baseMs * 2^attempt (attempt 从 0 起)
 * 例: baseMs=1000 → 1s / 2s / 4s / 8s / 16s
 *
 * 用法:
 *   const policy = new RetryPolicy({ maxAttempts: 5, baseMs: 1000 });
 *   const result = await policy.execute(
 *     async (attempt) => doWork(),
 *     { subtaskId: "st-1" }
 *   );
 *
 * 返回 RetryOutcome 包含 attempts 列表和最终值/错误,不直接 throw。
 * 持续失败 → 返回 status:"failed"
 *
 * 不重试条件:
 *  - 错误带 `retryable: false`
 *  - 错误是 AbortError (用户取消)
 *  - 达到 maxAttempts
 */

import { defaultLogger, type Logger } from "../core/logger.js";
import { toErrorMessage } from "../core/error-utils.js";
import type { RetryAttempt } from "./types.js";
import { SubTaskFailedError } from "./types.js";

export interface RetryPolicyDeps {
  readonly maxAttempts: number;
  readonly baseMs: number;
  readonly logger?: Logger;
  /** 测试用: 跳过真实 sleep */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface RetryContext {
  readonly subtaskId: string;
  /** 每次重试前回调(用于写 checkpoint) */
  readonly onRetry?: (attempt: number, wait: number) => void | Promise<void>;
  /** AbortSignal: 用户取消 */
  readonly signal?: AbortSignal;
}

export interface RetryOutcome<T> {
  readonly status: "success" | "failed";
  readonly value?: T;
  readonly attempts: ReadonlyArray<RetryAttempt>;
  readonly error?: Error;
}

export class RetryPolicy {
  private readonly maxAttempts: number;
  private readonly baseMs: number;
  private readonly logger: Logger;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: RetryPolicyDeps) {
    this.maxAttempts = Math.max(1, deps.maxAttempts);
    this.baseMs = Math.max(0, deps.baseMs);
    this.logger = deps.logger ?? defaultLogger.child({ component: "retry" });
    this.sleep =
      deps.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  async execute<T>(
    fn: (attempt: number) => Promise<T>,
    ctx: RetryContext,
  ): Promise<RetryOutcome<T>> {
    const attempts: RetryAttempt[] = [];
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (ctx.signal?.aborted) {
        return {
          status: "failed",
          attempts,
          error: new Error("Aborted by user"),
        };
      }

      const wait = attempt === 1 ? 0 : this.computeBackoff(attempt - 1);
      if (wait > 0) {
        if (ctx.onRetry) await ctx.onRetry(attempt, wait);
        this.logger.info("retry waiting", {
          subtask_id: ctx.subtaskId,
          attempt,
          wait_ms: wait,
        });
        await this.sleep(wait);
      }

      try {
        const value = await fn(attempt);
        attempts.push({ attempt, waitedMs: wait, status: "success" });
        return { status: "success", value, attempts };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const errorMessage = toErrorMessage(error);
        attempts.push({
          attempt,
          waitedMs: wait,
          status: "failed",
          errorMessage,
        });
        lastError = error;

        if (this.isNonRetryable(error)) {
          this.logger.warn("non-retryable error; aborting", {
            subtask_id: ctx.subtaskId,
            attempt,
            err: errorMessage,
          });
          return { status: "failed", attempts, error };
        }
        this.logger.warn("attempt failed", {
          subtask_id: ctx.subtaskId,
          attempt,
          err: errorMessage,
        });
      }
    }

    return {
      status: "failed",
      attempts,
      error: lastError ?? new Error("Max retries reached"),
    };
  }

  /** 包装: 失败 outcome → throw SubTaskFailedError (供调用方简化) */
  async executeOrThrow<T>(
    fn: (attempt: number) => Promise<T>,
    ctx: RetryContext,
  ): Promise<T> {
    const outcome = await this.execute(fn, ctx);
    if (outcome.status === "success" && outcome.value !== undefined) {
      return outcome.value;
    }
    throw new SubTaskFailedError(ctx.subtaskId, outcome.attempts);
  }

  private computeBackoff(retryIndex: number): number {
    // retryIndex 1 → baseMs, 2 → baseMs*2, 3 → baseMs*4, ...
    // 但用户期望 1s, 2s, 4s, 8s, 16s,所以 retryIndex 起算 1
    return this.baseMs * 2 ** (retryIndex - 1);
  }

  private isNonRetryable(err: Error): boolean {
    if (err.name === "AbortError") return true;
    const flagged = (err as Error & { retryable?: boolean }).retryable;
    if (flagged === false) return true;
    return false;
  }
}
