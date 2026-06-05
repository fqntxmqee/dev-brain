/**
 * 简易 LRU Map：超过 maxSize 时淘汰最久未访问。
 * 用于限制 pendingByChat 等 Map 无限增长。
 */
export class LruMap<K, V> extends Map<K, V> {
  constructor(private readonly maxSize: number) {
    super();
    if (maxSize < 1) throw new Error("maxSize must be >= 1");
  }

  override get(key: K): V | undefined {
    const value = super.get(key);
    if (value === undefined) return undefined;
    // hit → 移到末尾（最近使用）
    super.delete(key);
    super.set(key, value);
    return value;
  }

  override set(key: K, value: V): this {
    if (super.has(key)) {
      super.delete(key);
    } else if (super.size >= this.maxSize) {
      const firstKey = super.keys().next().value;
      if (firstKey !== undefined) super.delete(firstKey);
    }
    super.set(key, value);
    return this;
  }
}
