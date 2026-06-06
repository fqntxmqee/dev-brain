import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointManager } from "../../src/runtime/checkpoint.js";
import { ContextBudget } from "../../src/runtime/context-budget.js";
import { ProgressReporter } from "../../src/runtime/progress-reporter.js";
import { ResumeManager } from "../../src/runtime/resume-manager.js";
import { RetryPolicy } from "../../src/runtime/retry-policy.js";
import type { CheckpointSnapshot } from "../../src/runtime/types.js";
import { getMetrics, resetMetrics } from "../../src/observability/metrics.js";

/**
 * E2E: 长程任务全链路
 * 覆盖: checkpoint.write → progress.update → context-budget 触发 summarise
 *       → retry.exhausted → resume.scan
 * 模拟一个 2-8 小时长任务的最小生命周期。
 */

const fixedNow = () => new Date("2026-06-06T10:00:00.000Z");

const mkSnap = (
  traceId: string,
  overrides: Partial<CheckpointSnapshot> = {},
): CheckpointSnapshot => ({
  trace_id: traceId,
  task_id: `task-${traceId}`,
  started_at: "2026-06-06T09:00:00.000Z",
  last_checkpoint_at: "2026-06-06T09:55:00.000Z",
  current_step: "subtask:st-3:running",
  completed_subtasks: [
    { id: "st-1", runtime: "claude-code", status: "success", durationMs: 1200 },
    { id: "st-2", runtime: "codex", status: "success", durationMs: 800 },
  ],
  pending_subtasks: [
    { id: "st-3", runtime: "cursor", prompt: "p3" },
    { id: "st-4", runtime: "claude-code", prompt: "p4" },
  ],
  context_state: { tokens_used: 80_000 },
  state: "in_progress",
  version: 1,
  ...overrides,
});

describe("long-running task end-to-end", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "long-running-"));
    resetMetrics();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("executes_lifecycle_write_progress_summarise_retry_resume", async () => {
    // 1. 启动 2 个任务 → checkpoint 写盘
    const ckpt = new CheckpointManager({ checkpointDir: dir, maxKeep: 3 });
    await ckpt.write(mkSnap("trace-alpha"));
    await ckpt.write(mkSnap("trace-beta"));

    // 2. progress reporter 30s 节流,2 次成功
    const prog = new ProgressReporter({
      progressDir: join(dir, "progress"),
      intervalSec: 30,
      now: fixedNow,
    });
    const ok1 = await prog.update(
      {
        trace_id: "trace-alpha",
        task_id: "task-alpha",
        progress_pct: 50,
        elapsed_sec: 3600,
        eta_sec: 3600,
        tokens_used: 80_000,
        checkpoints_written: 1,
        current_step: "subtask:st-3:running",
        updated_at: "2026-06-06T10:00:00.000Z",
      },
      true,
    );
    expect(ok1).toBe(true);

    // 3. context budget 触发 summarise
    const summariser = {
      summarise: async (
        _rounds: ReadonlyArray<{
          id: string;
          tokens: number;
          role: "user" | "assistant" | "system";
          content: string;
        }>,
        _recent: number,
      ) => ({
        summary: "compressed",
        compressedTokens: 5_000,
        droppedRounds: ["r1", "r2"],
      }),
    };
    const budget = new ContextBudget({
      maxTokens: 100_000,
      summariseRecentRounds: 2,
      summariser,
    });
    const rounds = [
      { id: "r1", tokens: 20_000, role: "user" as const, content: "a" },
      { id: "r2", tokens: 30_000, role: "assistant" as const, content: "b" },
      { id: "r3", tokens: 30_000, role: "user" as const, content: "c" },
      { id: "r4", tokens: 30_000, role: "assistant" as const, content: "d" },
    ];
    const compressed = await budget.summarise(rounds);
    expect(compressed.compressedTokens).toBe(5_000);

    // 4. retry policy: 2 次失败 → 1 次成功
    const policy = new RetryPolicy({
      maxAttempts: 3,
      baseMs: 1,
    });
    let attempts = 0;
    const outcome = await policy.execute(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("transient");
        return "ok";
      },
      { subtaskId: "st-1" },
    );
    expect(attempts).toBe(3);
    expect(outcome.status).toBe("success");
    expect(outcome.value).toBe("ok");

    // 5. retry 全部失败 → 抛错
    const failPolicy = new RetryPolicy({ maxAttempts: 2, baseMs: 1 });
    const failOutcome = await failPolicy.execute(
      async () => {
        throw new Error("permanent");
      },
      { subtaskId: "st-fail" },
    );
    expect(failOutcome.status).toBe("failed");
    expect(failOutcome.error?.message).toBe("permanent");

    // 6. resume manager 扫到 in_progress → 至少 2 个 plan
    const rm = new ResumeManager({
      checkpointManager: ckpt,
      now: () => new Date("2026-06-06T10:00:00.000Z"),
    });
    const plans = await rm.scan();
    expect(plans).toHaveLength(2);
    expect(plans.map((p) => p.trace_id).sort()).toEqual([
      "trace-alpha",
      "trace-beta",
    ]);
    expect(plans[0]?.remaining_subtasks).toHaveLength(2);
  });

  it("increments_runtime_metrics_throughout_lifecycle", async () => {
    const ckpt = new CheckpointManager({ checkpointDir: dir, maxKeep: 3 });
    await ckpt.write(mkSnap("trace-m"));
    await ckpt.write(mkSnap("trace-n"));

    const m = getMetrics();
    const startCkpWrites = m.get("runtime.checkpoint_writes");
    const startResume = m.get("runtime.resume_total");

    // 再写一次
    await ckpt.write(mkSnap("trace-o"));
    expect(m.get("runtime.checkpoint_writes")).toBe(startCkpWrites + 1);

    // retry
    const policy = new RetryPolicy({ maxAttempts: 2, baseMs: 1 });
    const retryStart = m.get("runtime.retry_total");
    await policy.execute(
      async () => {
        throw new Error("x");
      },
      { subtaskId: "st-metric" },
    );
    expect(m.get("runtime.retry_total")).toBeGreaterThanOrEqual(retryStart + 1);

    // resume
    const rm = new ResumeManager({
      checkpointManager: ckpt,
      now: () => new Date("2026-06-06T10:00:00.000Z"),
    });
    await rm.scan();
    expect(m.get("runtime.resume_total")).toBeGreaterThanOrEqual(
      startResume + 3,
    );
  });
});
