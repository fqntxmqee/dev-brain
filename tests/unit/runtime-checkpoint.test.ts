import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointManager } from "../../src/runtime/checkpoint.js";
import type { CheckpointSnapshot } from "../../src/runtime/types.js";

function newSnap(
  traceId: string,
  overrides: Partial<CheckpointSnapshot> = {},
): CheckpointSnapshot {
  return {
    trace_id: traceId,
    task_id: "task-1",
    started_at: "2026-01-01T00:00:00.000Z",
    last_checkpoint_at: "2026-01-01T00:01:00.000Z",
    current_step: "subtask:st-1:running",
    completed_subtasks: [],
    pending_subtasks: [{ id: "st-1", runtime: "claude-code", prompt: "p" }],
    context_state: { tokens_used: 100 },
    state: "in_progress",
    version: 1,
    ...overrides,
  };
}

describe("CheckpointManager (CAP-RT-01)", () => {
  let dir: string;
  let mgr: CheckpointManager;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "ckpt-test-"));
    mgr = new CheckpointManager({ checkpointDir: dir, maxKeep: 3 });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("writes_and_reads_latest_checkpoint", async () => {
    const snap = newSnap("trace-001");
    await mgr.write(snap);
    const read = await mgr.readLatest("trace-001");
    expect(read).not.toBeNull();
    expect(read!.trace_id).toBe("trace-001");
    expect(read!.current_step).toBe("subtask:st-1:running");
  });

  it("returns_null_when_checkpoint_missing", async () => {
    const read = await mgr.readLatest("nonexistent");
    expect(read).toBeNull();
  });

  it("rotates_keeping_most_recent_N", async () => {
    // 写 5 个版本(maxKeep=3)
    for (let i = 1; i <= 5; i++) {
      await mgr.write(newSnap("trace-rot", { current_step: `step-${i}` }));
    }
    // .0 最新, .1 次新, .2 第三新; .3+ 应该不存在
    const files = await fs.readdir(dir);
    const traceFiles = files.filter((n) => n.startsWith("trace-rot."));
    expect(traceFiles.length).toBeLessThanOrEqual(3);
    const latest = await mgr.readLatest("trace-rot");
    expect(latest!.current_step).toBe("step-5");
  });

  it("lists_only_in_progress_checkpoints", async () => {
    await mgr.write(newSnap("active-1", { state: "in_progress" }));
    await mgr.write(newSnap("active-2", { state: "in_progress" }));
    await mgr.write(newSnap("done-1", { state: "completed" }));
    await mgr.write(newSnap("cancelled-1", { state: "cancelled" }));

    const inProg = await mgr.listInProgress();
    const ids = inProg.map((s) => s.trace_id).sort();
    expect(ids).toEqual(["active-1", "active-2"]);
  });

  it("clears_all_versions_for_trace", async () => {
    await mgr.write(newSnap("trace-x"));
    await mgr.write(newSnap("trace-x"));
    await mgr.write(newSnap("trace-y"));

    await mgr.clear("trace-x");

    const after = await fs.readdir(dir);
    expect(after.filter((n) => n.startsWith("trace-x."))).toHaveLength(0);
    expect(after.filter((n) => n.startsWith("trace-y."))).toHaveLength(1);
  });

  it("handles_unsafe_chars_in_trace_id", async () => {
    const snap = newSnap("trace/with:slashes");
    await mgr.write(snap);
    // 文件名应被消毒
    const files = await fs.readdir(dir);
    expect(files.some((n) => n.includes("/") || n.includes(":"))).toBe(false);
  });

  it("listInProgress_returns_empty_when_dir_missing", async () => {
    const otherDir = join(tmpdir(), `ckpt-empty-${Date.now()}`);
    const m = new CheckpointManager({
      checkpointDir: otherDir,
      maxKeep: 3,
    });
    const inProg = await m.listInProgress();
    expect(inProg).toHaveLength(0);
    // ensureDir 应该创建了目录,清理掉
    await fs.rm(otherDir, { recursive: true, force: true });
  });
});
