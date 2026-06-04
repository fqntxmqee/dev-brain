import { v4 as uuid } from 'uuid';
import { LockConflictError } from './errors.js';
import type { FileLock } from './types.js';

const DEFAULT_LOCK_TIMEOUT_MS = 300_000;

interface WriteLockRecord {
  readonly lock: FileLock;
}

export class FileLockManager {
  private readonly writeLocks = new Map<string, WriteLockRecord>();
  private readonly readCounts = new Map<string, Map<string, number>>();
  private readonly timeoutMs: number;

  constructor(timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  acquire(agentId: string, filePath: string, mode: 'read' | 'write'): FileLock {
    this.expireStaleLocks();
    const now = Date.now();
    const expiresAt = new Date(now + this.timeoutMs).toISOString();

    if (mode === 'read') {
      const write = this.writeLocks.get(filePath);
      if (write && write.lock.agentId !== agentId) {
        throw new LockConflictError(filePath, write.lock.agentId, agentId);
      }
      const byAgent = this.readCounts.get(filePath) ?? new Map<string, number>();
      byAgent.set(agentId, (byAgent.get(agentId) ?? 0) + 1);
      this.readCounts.set(filePath, byAgent);
      return {
        id: uuid(),
        filePath,
        agentId,
        mode: 'read',
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
      mode: 'write',
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
    if (lock.mode === 'write') {
      const record = this.writeLocks.get(lock.filePath);
      if (record?.lock.id === lock.id) {
        this.writeLocks.delete(lock.filePath);
      }
      return;
    }

    const byAgent = this.readCounts.get(lock.filePath);
    if (!byAgent) return;
    const count = byAgent.get(lock.agentId) ?? 0;
    if (count <= 1) {
      byAgent.delete(lock.agentId);
    } else {
      byAgent.set(lock.agentId, count - 1);
    }
    if (byAgent.size === 0) {
      this.readCounts.delete(lock.filePath);
    }
  }

  getLockedFilePaths(): ReadonlySet<string> {
    this.expireStaleLocks();
    return new Set([...this.writeLocks.keys()]);
  }

  private expireStaleLocks(): void {
    const now = Date.now();
    for (const [path, record] of this.writeLocks) {
      if (new Date(record.lock.expiresAt).getTime() < now) {
        this.writeLocks.delete(path);
      }
    }
  }
}
