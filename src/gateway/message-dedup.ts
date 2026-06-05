import {
  MESSAGE_DEDUP_MAX,
  MESSAGE_DEDUP_WINDOW_MS,
} from "../core/constants.js";

/**
 * 飞书 messageId 5 分钟滑动窗口去重（CAP-REL-04 / T-34）。
 * 防止重复投递触发重复 plan / approve。
 * 显式驱逐：插入前先扫一次过期项；超 MAX 删除最旧。
 */
export class MessageDedup {
  private readonly seen = new Map<string, number>();
  private readonly maxSize: number;
  private readonly windowMs: number;

  constructor(options: { maxSize?: number; windowMs?: number } = {}) {
    this.maxSize = options.maxSize ?? MESSAGE_DEDUP_MAX;
    this.windowMs = options.windowMs ?? MESSAGE_DEDUP_WINDOW_MS;
  }

  /**
   * 若 messageId 已见过（或过期但未清）则视为重复。
   * 返回 true 表示重复。
   */
  isDuplicate(messageId: string, now: number = Date.now()): boolean {
    this.evictExpired(now);
    if (this.seen.has(messageId)) {
      this.seen.set(messageId, now);
      return true;
    }
    this.seen.set(messageId, now);
    this.enforceMax();
    return false;
  }

  private evictExpired(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [id, ts] of this.seen) {
      if (ts < cutoff) this.seen.delete(id);
    }
  }

  private enforceMax(): void {
    if (this.seen.size <= this.maxSize) return;
    const overflow = this.seen.size - this.maxSize;
    const iter = this.seen.keys();
    for (let i = 0; i < overflow; i += 1) {
      const k = iter.next().value as string | undefined;
      if (k === undefined) break;
      this.seen.delete(k);
    }
  }

  size(): number {
    return this.seen.size;
  }

  clear(): void {
    this.seen.clear();
  }
}
