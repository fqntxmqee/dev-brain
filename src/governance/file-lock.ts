import { v4 as uuid } from "uuid";
import { LockConflictError } from "./errors.js";
import type { FileLock } from "./types.js";

const DEFAULT_LOCK_TIMEOUT_MS = 300_000;

interface WriteLockRecord {
  readonly lock: FileLock;
}

interface ReadLockRecord {
  readonly locks: Set<string>;
  readonly expiresAt: number;
}

export class FileLockManager {
  private readonly writeLocks = new Map<string, WriteLockRecord>();
  private readonly readLocks = new Map<string, ReadLockRecord>();
  private readonly timeoutMs: number;

  constructor(timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  acquire(agentId: string, filePath: string, mode: "read" | "write"): FileLock {
    this.expireStaleLocks();
    const now = Date.now();
    const expiresAtMs = now + this.timeoutMs;
    const expiresAt = new Date(expiresAtMs).toISOString();

    if (mode === "read") {
      const write = this.writeLocks.get(filePath);
      if (write && write.lock.agentId !== agentId) {
        throw new LockConflictError(filePath, write.lock.agentId, agentId);
      }
      let record = this.readLocks.get(filePath);
      if (!record || record.expiresAt < now) {
        record = { locks: new Set(), expiresAt: expiresAtMs };
        this.readLocks.set(filePath, record);
      }
      record.locks.add(`${agentId}:${uuid()}`);
      return {
        id: uuid(),
        filePath,
        agentId,
        mode: "read",
        acquiredAt: new Date(now).toISOString(),
        expiresAt,
      };
    }

    const existing = this.writeLocks.get(filePath);
    if (existing && existing.lock.agentId !== agentId) {
      throw new LockConflictError(filePath, existing.lock.agentId, agentId);
    }

    const lock: FileLock = {
      id: uuid(),
      filePath,
      agentId,
      mode: "write",
      acquiredAt: new Date(now).toISOString(),
      expiresAt,
    };
    this.writeLocks.set(filePath, { lock });
    return lock;
  }

  release(lockId: string): void {
    for (const [path, record] of this.writeLocks) {
      if (record.lock.id === lockId) {
        this.writeLocks.delete(path);
        return;
      }
    }
  }

  /** Release a lock acquired via acquire() using the returned FileLock object. */
  releaseLock(lock: FileLock): void {
    if (lock.mode === "write") {
      const record = this.writeLocks.get(lock.filePath);
      if (record?.lock.id === lock.id) {
        this.writeLocks.delete(lock.filePath);
      }
      return;
    }

    // Read 模式无法可靠用单 lock id 区分；改为对 filePath 全量清空该 agent 的 read 锁
    const record = this.readLocks.get(lock.filePath);
    if (!record) return;
    for (const id of [...record.locks]) {
      if (id.startsWith(`${lock.agentId}:`)) {
        record.locks.delete(id);
      }
    }
    if (record.locks.size === 0) {
      this.readLocks.delete(lock.filePath);
    }
  }

  getLockedFilePaths(): ReadonlySet<string> {
    this.expireStaleLocks();
    return new Set([...this.writeLocks.keys()]);
  }

  /** 统计所有未过期 read 锁的总数（用于监控） */
  getReadLockCount(filePath: string): number {
    this.expireStaleLocks();
    return this.readLocks.get(filePath)?.locks.size ?? 0;
  }

  private expireStaleLocks(): void {
    const now = Date.now();
    for (const [path, record] of this.writeLocks) {
      if (new Date(record.lock.expiresAt).getTime() < now) {
        this.writeLocks.delete(path);
      }
    }
    for (const [path, record] of this.readLocks) {
      if (record.expiresAt < now) {
        this.readLocks.delete(path);
      }
    }
  }
}
