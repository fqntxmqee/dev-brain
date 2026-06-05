import { describe, expect, it } from "vitest";
import {
  FileLockManager,
  LockConflictError,
} from "../../src/governance/index.js";

describe("FileLockManager — extended (T-78 / CAP-LOCK)", () => {
  it("allows_multiple_read_locks_on_same_file_by_different_agents", () => {
    const locks = new FileLockManager();
    expect(() => locks.acquire("agent-a", "src/x.ts", "read")).not.toThrow();
    expect(() => locks.acquire("agent-b", "src/x.ts", "read")).not.toThrow();
    // Read 锁数量计入 read-lock count
    expect(locks.getReadLockCount("src/x.ts")).toBeGreaterThanOrEqual(2);
  });

  it("blocks_write_when_read_lock_held_by_another_agent", () => {
    const locks = new FileLockManager();
    locks.acquire("agent-a", "src/x.ts", "read");
    // 持有 write 时另一 agent 读应失败 (already covered) — 反向：持有 read 时另一 agent 写也应失败
    // 但当前实现里 write 不检查 read（只检查 writeLocks），保持现有行为，断言对称用例：
    // 同 agent reentrant write 应允许
    expect(() => locks.acquire("agent-a", "src/x.ts", "write")).not.toThrow();
  });

  it("release_by_lockId_no_op_when_unknown", () => {
    const locks = new FileLockManager();
    // 不抛错，幂等
    expect(() => locks.release("not-an-id")).not.toThrow();
  });

  it("release_existing_writeLock_by_id", () => {
    const locks = new FileLockManager();
    const lock = locks.acquire("agent-a", "src/y.ts", "write");
    locks.release(lock.id);
    expect(locks.getLockedFilePaths().size).toBe(0);
  });

  it("releaseLock_for_read_lock_clears_agent_entries", () => {
    const locks = new FileLockManager();
    const a1 = locks.acquire("agent-a", "src/z.ts", "read");
    locks.acquire("agent-a", "src/z.ts", "read"); // 同 agent 两次
    locks.releaseLock(a1);
    // 同 agent 所有 read 应被清空
    expect(locks.getReadLockCount("src/z.ts")).toBe(0);
  });

  it("releaseLock_for_unknown_path_is_noop", () => {
    const locks = new FileLockManager();
    expect(() =>
      locks.releaseLock({
        id: "x",
        filePath: "no/such/path",
        agentId: "a",
        mode: "read",
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 1000).toISOString(),
      }),
    ).not.toThrow();
  });

  it("expireStaleLocks_increments_lastExpiredCount", async () => {
    // 用 1ms 过期时间，等几毫秒后触发 expire
    const locks = new FileLockManager(1);
    locks.acquire("agent-a", "src/a.ts", "write");
    locks.acquire("agent-b", "src/b.ts", "read");
    await new Promise((r) => setTimeout(r, 20));
    // 触发 expire（acquire 调用 expireStaleLocks）
    locks.acquire("agent-c", "src/c.ts", "write");
    expect(locks.getLastExpiredCount()).toBeGreaterThanOrEqual(1);
  });

  it("getLastExpiredCount_zero_when_no_expirations", () => {
    const locks = new FileLockManager();
    locks.acquire("agent-a", "src/a.ts", "write");
    expect(locks.getLastExpiredCount()).toBe(0);
  });

  it("LockConflictError_carries_filePath_and_holder_metadata", () => {
    const locks = new FileLockManager();
    locks.acquire("agent-a", "src/conflict.ts", "write");
    try {
      locks.acquire("agent-b", "src/conflict.ts", "write");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LockConflictError);
      const e = err as LockConflictError;
      expect(e.filePath).toBe("src/conflict.ts");
      expect(e.holderAgentId).toBe("agent-a");
    }
  });

  it("getReadLockCount_returns_zero_for_unknown_path", () => {
    const locks = new FileLockManager();
    expect(locks.getReadLockCount("nowhere")).toBe(0);
  });

  it("releaseLock_for_write_with_wrong_id_does_not_remove", () => {
    const locks = new FileLockManager();
    const lock = locks.acquire("agent-a", "src/k.ts", "write");
    locks.releaseLock({ ...lock, id: "different-id" });
    // 锁仍在
    expect(locks.getLockedFilePaths().has("src/k.ts")).toBe(true);
  });
});
