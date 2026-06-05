import { describe, expect, it } from "vitest";
import { LruMap } from "../../src/core/lru.js";

describe("LruMap", () => {
  it("evicts_least_recently_used_on_overflow", () => {
    const m = new LruMap<string, number>(3);
    m.set("a", 1);
    m.set("b", 2);
    m.set("c", 3);
    m.set("d", 4);
    expect(m.has("a")).toBe(false);
    expect(m.has("d")).toBe(true);
    expect(m.size).toBe(3);
  });

  it("get_promotes_to_most_recently_used", () => {
    const m = new LruMap<string, number>(3);
    m.set("a", 1);
    m.set("b", 2);
    m.set("c", 3);
    m.get("a"); // promote
    m.set("d", 4); // should evict b, not a
    expect(m.has("a")).toBe(true);
    expect(m.has("b")).toBe(false);
  });

  it("updating_existing_key_keeps_size", () => {
    const m = new LruMap<string, number>(2);
    m.set("a", 1);
    m.set("a", 2);
    expect(m.size).toBe(1);
    expect(m.get("a")).toBe(2);
  });

  it("rejects_invalid_maxSize", () => {
    expect(() => new LruMap<string, number>(0)).toThrow();
    expect(() => new LruMap<string, number>(-1)).toThrow();
  });
});
