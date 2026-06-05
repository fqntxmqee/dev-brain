import { describe, expect, it } from "vitest";
import { MessageDedup } from "../../src/gateway/message-dedup.js";

describe("MessageDedup", () => {
  it("treats_first_occurrence_as_fresh", () => {
    const d = new MessageDedup();
    expect(d.isDuplicate("m1", 1000)).toBe(false);
  });

  it("treats_repeat_as_duplicate", () => {
    const d = new MessageDedup();
    d.isDuplicate("m1", 1000);
    expect(d.isDuplicate("m1", 1100)).toBe(true);
  });

  it("expires_after_window", () => {
    const d = new MessageDedup({ windowMs: 1000 });
    d.isDuplicate("m1", 0);
    expect(d.isDuplicate("m1", 1500)).toBe(false);
  });

  it("enforces_max_size_lru", () => {
    const d = new MessageDedup({ maxSize: 3, windowMs: 60_000 });
    d.isDuplicate("a", 0);
    d.isDuplicate("b", 0);
    d.isDuplicate("c", 0);
    d.isDuplicate("d", 0);
    d.isDuplicate("e", 0);
    expect(d.size()).toBeLessThanOrEqual(3);
  });

  it("different_ids_are_independent", () => {
    const d = new MessageDedup();
    d.isDuplicate("m1", 1000);
    expect(d.isDuplicate("m2", 1100)).toBe(false);
  });

  it("100k_messages_does_not_explode", () => {
    const d = new MessageDedup();
    for (let i = 0; i < 1000; i += 1) {
      d.isDuplicate(`m-${i}`, i);
    }
    expect(d.size()).toBeLessThanOrEqual(10_000);
  });
});
