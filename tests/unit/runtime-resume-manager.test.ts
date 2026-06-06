import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckpointManager } from "../../src/runtime/checkpoint.js";
import { ResumeManager } from "../../src/runtime/resume-manager.js";
import type { CheckpointSnapshot } from "../../src/runtime/types.js";

const mkSnap = (
  traceId: string,
  overrides: Partial<CheckpointSnapshot> = {},
): CheckpointSnapshot => ({
  trace_id: traceId,
  task_id: `task-${traceId}`,
  started_at: "2026-01-01T00:00:00.000Z",
  last_checkpoint_at: "2026-01-01T00:05:00.000Z",
  current_step: "subtask:st-2:running",
  completed_subtasks: [
    {
      id: "st-1",
      runtime: "claude-code",
      status: "success",
      durationMs: 1000,
    },
  ],
  pending_subtasks: [
    { id: "st-2", runtime: "codex", prompt: "p2" },
    { id: "st-3", runtime: "cursor", prompt: "p3" },
  ],
  context_state: { tokens_used: 100 },
  state: "in_progress",
  version: 1,
  ...overrides,
});

describe("ResumeManager (CAP-RT-07)", () => {
  let dir: string;
  let ckpt: CheckpointManager;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "resume-test-"));
    ckpt = new CheckpointManager({ checkpointDir: dir, maxKeep: 3 });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns_empty_when_no_checkpoints", async () => {
    const rm = new ResumeManager({ checkpointManager: ckpt });
    const plans = await rm.scan();
    expect(plans).toHaveLength(0);
  });

  it("returns_plans_for_in_progress_checkpoints", async () => {
    await ckpt.write(mkSnap("trace-A"));
    await ckpt.write(mkSnap("trace-B"));
    // 这个不该返回:已 completed
    await ckpt.write(mkSnap("trace-C", { state: "completed" }));
    const rm = new ResumeManager({
      checkpointManager: ckpt,
      now: () => new Date("2026-01-01T00:06:00.000Z"),
    });
    const plans = await rm.scan();
    const ids = plans.map((p) => p.trace_id).sort();
    expect(ids).toEqual(["trace-A", "trace-B"]);
    expect(plans[0]?.remaining_subtasks).toHaveLength(2);
    expect(plans[0]?.completedCount).toBe(1);
  });

  it("skips_checkpoints_older_than_maxAge", async () => {
    // checkpoint age = 8 天前
    await ckpt.write(
      mkSnap("trace-old", {
        last_checkpoint_at: "2025-12-20T00:00:00.000Z",
      }),
    );
    const rm = new ResumeManager({
      checkpointManager: ckpt,
      maxAgeSec: 7 * 24 * 3600,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const plans = await rm.scan();
    expect(plans).toHaveLength(0);
  });

  it("respects_auditValidator_rejection_and_clears_checkpoint", async () => {
    await ckpt.write(mkSnap("trace-bad"));
    const auditValidator = {
      isValid: vi.fn(async () => false),
    };
    const rm = new ResumeManager({
      checkpointManager: ckpt,
      auditValidator,
      now: () => new Date("2026-01-01T00:06:00.000Z"),
    });
    const plans = await rm.scan();
    expect(plans).toHaveLength(0);
    expect(auditValidator.isValid).toHaveBeenCalledWith("trace-bad");
    // checkpoint 应被清理
    const after = await ckpt.readLatest("trace-bad");
    expect(after).toBeNull();
  });

  it("passes_through_when_auditValidator_approves", async () => {
    await ckpt.write(mkSnap("trace-ok"));
    const rm = new ResumeManager({
      checkpointManager: ckpt,
      auditValidator: { isValid: async () => true },
      now: () => new Date("2026-01-01T00:06:00.000Z"),
    });
    const plans = await rm.scan();
    expect(plans.map((p) => p.trace_id)).toEqual(["trace-ok"]);
  });

  it("plan_includes_completed_count_and_pending_subtasks", async () => {
    await ckpt.write(mkSnap("trace-detail"));
    const rm = new ResumeManager({
      checkpointManager: ckpt,
      now: () => new Date("2026-01-01T00:06:00.000Z"),
    });
    const [plan] = await rm.scan();
    expect(plan?.completedCount).toBe(1);
    expect(plan?.remaining_subtasks.map((s) => s.id)).toEqual(["st-2", "st-3"]);
    expect(plan?.current_step).toBe("subtask:st-2:running");
  });
});
