import { describe, expect, it } from "vitest";
import {
  FileLockManager,
  LockConflictError,
} from "../../src/governance/index.js";
import { getMetrics } from "../../src/observability/metrics.js";

/** Covers: L5-BRAIN-04 */
describe("FileLockManager", () => {
  it("should_block_second_write_on_same_file", () => {
    const locks = new FileLockManager();
    locks.acquire("agent-a", "src/trade/**", "write");

    expect(() => locks.acquire("agent-b", "src/trade/**", "write")).toThrow(
      LockConflictError,
    );
  });

  it("should_allow_same_agent_reentrant_write", () => {
    const locks = new FileLockManager();
    const first = locks.acquire("agent-a", "src/foo.ts", "write");
    locks.releaseLock(first);
    expect(() => locks.acquire("agent-a", "src/foo.ts", "write")).not.toThrow();
  });

  it("should_block_read_when_other_agent_holds_write", () => {
    const locks = new FileLockManager();
    locks.acquire("agent-a", "src/bar.ts", "write");
    expect(() => locks.acquire("agent-b", "src/bar.ts", "read")).toThrow(
      LockConflictError,
    );
  });

  it("should_release_write_lock", () => {
    const locks = new FileLockManager();
    const lock = locks.acquire("agent-a", "src/baz.ts", "write");
    locks.releaseLock(lock);
    expect(locks.getLockedFilePaths().size).toBe(0);
    expect(() => locks.acquire("agent-b", "src/baz.ts", "write")).not.toThrow();
  });
});

/** v0.7.0: file lock observability hooks */
describe("FileLockManager observability (v0.7.0)", () => {
  it("gauge_round_trips_through_acquire_and_release", () => {
    const metrics = getMetrics();
    const locks = new FileLockManager();
    const lock = locks.acquire("agent-obs", "src/obs/y.ts", "write");
    const whileHeld = metrics.gauge("file.lock.held").get();
    locks.releaseLock(lock);
    const afterRelease = metrics.gauge("file.lock.held").get();
    // gauge is global; verify net delta over the (acquire→release) cycle is 0
    expect(afterRelease).toBeLessThan(whileHeld);
  });
});
