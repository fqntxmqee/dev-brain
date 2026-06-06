import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ProgressReporter,
  computeEta,
  computeProgressPct,
} from "../../src/runtime/progress-reporter.js";
import type { ProgressSnapshot } from "../../src/runtime/types.js";

const newProgress = (
  traceId: string,
  overrides: Partial<ProgressSnapshot> = {},
): ProgressSnapshot => ({
  trace_id: traceId,
  task_id: "task-1",
  progress_pct: 50,
  elapsed_sec: 600,
  eta_sec: 600,
  tokens_used: 50000,
  checkpoints_written: 10,
  current_step: "subtask:st-2:running",
  updated_at: "2026-01-01T00:10:00.000Z",
  ...overrides,
});

describe("ProgressReporter (CAP-RT-06)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "progress-test-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("writes_and_reads_progress", async () => {
    const reporter = new ProgressReporter({
      progressDir: dir,
      intervalSec: 30,
    });
    const ok = await reporter.update(newProgress("trace-1"), true);
    expect(ok).toBe(true);
    const read = await reporter.read("trace-1");
    expect(read).not.toBeNull();
    expect(read!.progress_pct).toBe(50);
  });

  it("throttles_writes_within_interval", async () => {
    let nowMs = 1_000_000;
    const reporter = new ProgressReporter({
      progressDir: dir,
      intervalSec: 30,
      now: () => new Date(nowMs),
    });
    const first = await reporter.update(newProgress("trace-2"));
    expect(first).toBe(true);
    nowMs += 5000; // 仅 5 秒
    const second = await reporter.update(newProgress("trace-2"));
    expect(second).toBe(false);
    nowMs += 30_000; // 再 30 秒
    const third = await reporter.update(newProgress("trace-2"));
    expect(third).toBe(true);
  });

  it("force_bypasses_throttle", async () => {
    const reporter = new ProgressReporter({
      progressDir: dir,
      intervalSec: 30,
    });
    await reporter.update(newProgress("trace-3"), true);
    const second = await reporter.update(newProgress("trace-3"), true);
    expect(second).toBe(true);
  });

  it("returns_null_when_no_progress_file", async () => {
    const reporter = new ProgressReporter({
      progressDir: dir,
      intervalSec: 30,
    });
    expect(await reporter.read("ghost")).toBeNull();
  });

  it("lists_all_progress_files", async () => {
    const reporter = new ProgressReporter({
      progressDir: dir,
      intervalSec: 30,
    });
    await reporter.update(newProgress("a"), true);
    await reporter.update(newProgress("b"), true);
    await reporter.update(newProgress("c"), true);
    const all = await reporter.listAll();
    const ids = all.map((p) => p.trace_id).sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("clears_progress_file", async () => {
    const reporter = new ProgressReporter({
      progressDir: dir,
      intervalSec: 30,
    });
    await reporter.update(newProgress("z"), true);
    expect(await reporter.read("z")).not.toBeNull();
    await reporter.clear("z");
    expect(await reporter.read("z")).toBeNull();
  });

  it("handles_unsafe_chars_in_trace_id", async () => {
    const reporter = new ProgressReporter({
      progressDir: dir,
      intervalSec: 30,
    });
    await reporter.update(newProgress("trace/with:bad"), true);
    const files = await fs.readdir(dir);
    expect(files.some((n) => n.includes("/") || n.includes(":"))).toBe(false);
  });
});

describe("computeEta", () => {
  it("returns_zero_when_no_completed", () => {
    expect(computeEta(100, 0, 5)).toBe(0);
  });

  it("returns_linear_extrapolation", () => {
    // 已耗 100s 完成 5 个 → avg=20s/个;还剩 3 个 → 60s
    expect(computeEta(100, 5, 3)).toBe(60);
  });
});

describe("computeProgressPct", () => {
  it("computes_percentage", () => {
    expect(computeProgressPct(3, 4)).toBe(75);
  });

  it("returns_100_when_total_zero", () => {
    expect(computeProgressPct(0, 0)).toBe(100);
  });
});
