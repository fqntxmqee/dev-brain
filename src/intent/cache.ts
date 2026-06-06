/**
 * 意图分类缓存 (CAP-INT-03)
 * 内存 LRU + TTL,key = sha256(chatId + text)
 */

import { createHash } from "node:crypto";
import type { Intent, IntentContext } from "./types.js";

interface CacheEntry {
  readonly intent: Intent;
  readonly expiresAt: number;
}

export interface IntentCacheConfig {
  readonly ttlMs: number;
  readonly maxEntries: number;
}

export class IntentCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly config: IntentCacheConfig,
    private readonly now: () => number = Date.now,
  ) {}

  get(text: string, context: IntentContext): Intent | undefined {
    const key = this.keyOf(text, context);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return { ...entry.intent, source: "cache" };
  }

  set(text: string, context: IntentContext, intent: Intent): void {
    const key = this.keyOf(text, context);
    if (this.entries.size >= this.config.maxEntries) {
      // LRU 淘汰:删除最久未访问的(此处简单 FIFO)
      const firstKey = this.entries.keys().next().value;
      if (firstKey !== undefined) this.entries.delete(firstKey);
    }
    this.entries.set(key, {
      intent,
      expiresAt: this.now() + this.config.ttlMs,
    });
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }

  private keyOf(text: string, context: IntentContext): string {
    return createHash("sha256")
      .update(`${context.chatId}:${text}`)
      .digest("hex");
  }
}
