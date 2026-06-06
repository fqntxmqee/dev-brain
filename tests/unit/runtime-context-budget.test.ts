import { describe, expect, it, vi } from "vitest";
import {
  ContextBudget,
  type ConversationRound,
  type Summariser,
} from "../../src/runtime/context-budget.js";
import { ContextSummariseError } from "../../src/runtime/types.js";

const mkRounds = (count: number, tokens = 1000): ConversationRound[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `r-${i}`,
    tokens,
    role: i % 2 === 0 ? "user" : "assistant",
    content: `msg-${i}`,
  }));

const fakeSummariser = (
  output: Partial<{
    summary: string;
    compressedTokens: number;
    droppedRounds: string[];
  }> = {},
): Summariser => ({
  summarise: vi.fn(async () => ({
    summary: output.summary ?? "summary",
    compressedTokens: output.compressedTokens ?? 5000,
    droppedRounds: output.droppedRounds ?? [],
  })),
});

describe("ContextBudget (CAP-RT-02)", () => {
  it("accumulates_tokens_correctly", () => {
    const budget = new ContextBudget({
      maxTokens: 100000,
      summariseRecentRounds: 2,
      summariser: fakeSummariser(),
    });
    budget.add({ prompt: 1000, completion: 500 });
    budget.add({ prompt: 800, completion: 400 });
    expect(budget.getState().tokensUsed).toBe(2700);
  });

  it("shouldSummarise_returns_true_when_over_budget", () => {
    const budget = new ContextBudget({
      maxTokens: 1000,
      summariseRecentRounds: 2,
      summariser: fakeSummariser(),
    });
    budget.add({ prompt: 600, completion: 500 });
    expect(budget.shouldSummarise()).toBe(true);
  });

  it("shouldSummarise_returns_false_when_under_budget", () => {
    const budget = new ContextBudget({
      maxTokens: 1000,
      summariseRecentRounds: 2,
      summariser: fakeSummariser(),
    });
    budget.add({ prompt: 100, completion: 100 });
    expect(budget.shouldSummarise()).toBe(false);
  });

  it("summarise_drops_early_rounds_and_keeps_recent", async () => {
    const summariser = fakeSummariser({ compressedTokens: 5000 });
    const budget = new ContextBudget({
      maxTokens: 100,
      summariseRecentRounds: 2,
      summariser,
    });
    budget.add({ prompt: 100000, completion: 50000 });
    const rounds = mkRounds(10, 10000); // 10 轮,每轮 10K tokens
    const out = await budget.summarise(rounds);
    // summariser 被调用,recentRounds 传 2
    expect(summariser.summarise).toHaveBeenCalledWith(rounds, 2);
    expect(out.summary).toBe("summary");
    // 重置后: 5000 + 2*10000 = 25000
    expect(budget.getState().tokensUsed).toBe(25000);
    expect(budget.getState().summariseCount).toBe(1);
    expect(budget.getState().lastSummariseAt).toBeDefined();
  });

  it("summarise_skips_if_not_enough_rounds", async () => {
    const summariser = fakeSummariser();
    const budget = new ContextBudget({
      maxTokens: 100,
      summariseRecentRounds: 5,
      summariser,
    });
    budget.add({ prompt: 5000, completion: 5000 });
    const rounds = mkRounds(3, 1000);
    const out = await budget.summarise(rounds);
    // 3 ≤ 5,不压缩
    expect(summariser.summarise).not.toHaveBeenCalled();
    expect(out.summary).toBe("");
    // 重置为 retained: 3*1000 = 3000
    expect(budget.getState().tokensUsed).toBe(3000);
  });

  it("summarise_failure_throws_ContextSummariseError", async () => {
    const summariser: Summariser = {
      summarise: async () => {
        throw new Error("haiku down");
      },
    };
    const budget = new ContextBudget({
      maxTokens: 100,
      summariseRecentRounds: 2,
      summariser,
    });
    budget.add({ prompt: 50000, completion: 50000 });
    await expect(budget.summarise(mkRounds(10, 10000))).rejects.toBeInstanceOf(
      ContextSummariseError,
    );
  });

  it("multiple_summarises_increment_count", async () => {
    const budget = new ContextBudget({
      maxTokens: 100,
      summariseRecentRounds: 2,
      summariser: fakeSummariser(),
    });
    budget.add({ prompt: 50000, completion: 50000 });
    await budget.summarise(mkRounds(10, 10000));
    budget.add({ prompt: 50000, completion: 50000 });
    await budget.summarise(mkRounds(10, 10000));
    expect(budget.getState().summariseCount).toBe(2);
  });

  it("add_clamps_negative_usage_to_zero", () => {
    const budget = new ContextBudget({
      maxTokens: 100,
      summariseRecentRounds: 2,
      summariser: fakeSummariser(),
    });
    budget.add({ prompt: -100, completion: -200 });
    expect(budget.getState().tokensUsed).toBe(0);
  });
});
