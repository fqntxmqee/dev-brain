/**
 * ContextBudget — CAP-RT-02
 *
 * 监控 LLM token 累计;超阈值时触发 summariser。
 * Summariser 是注入的(因为它内部要调 haiku),便于测试。
 *
 * 用法:
 *   const budget = new ContextBudget({ maxTokens: 150000, summariser });
 *   budget.add(usage);  // 每次 LLM 调用后报告 usage
 *   if (budget.shouldSummarise()) await budget.summarise(rounds);
 */

import { defaultLogger, type Logger } from "../core/logger.js";
import { getMetrics, safe } from "../observability/metrics.js";
import { ContextSummariseError } from "./types.js";

export interface TokenUsage {
  readonly prompt: number;
  readonly completion: number;
}

export interface ConversationRound {
  readonly id: string;
  readonly tokens: number;
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
}

export interface SummariseOutput {
  readonly summary: string;
  readonly compressedTokens: number;
  readonly droppedRounds: ReadonlyArray<string>;
}

export interface Summariser {
  /** 把早期 N-recentRounds 压缩为摘要,保留最近 recentRounds */
  summarise(
    rounds: ReadonlyArray<ConversationRound>,
    recentRounds: number,
  ): Promise<SummariseOutput>;
}

export interface ContextBudgetDeps {
  readonly maxTokens: number;
  readonly summariseRecentRounds: number;
  readonly summariser: Summariser;
  readonly logger?: Logger;
  readonly now?: () => Date;
}

export interface BudgetState {
  readonly tokensUsed: number;
  readonly lastSummariseAt?: string;
  readonly summariseCount: number;
}

export class ContextBudget {
  private readonly maxTokens: number;
  private readonly recentRounds: number;
  private readonly summariser: Summariser;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly metrics = getMetrics();
  private tokensUsed = 0;
  private lastSummariseAt: string | undefined;
  private summariseCount = 0;

  constructor(deps: ContextBudgetDeps) {
    this.maxTokens = Math.max(1, deps.maxTokens);
    this.recentRounds = Math.max(1, deps.summariseRecentRounds);
    this.summariser = deps.summariser;
    this.logger =
      deps.logger ?? defaultLogger.child({ component: "context-budget" });
    this.now = deps.now ?? (() => new Date());
  }

  /** 报告一次 LLM 调用的 token usage */
  add(usage: TokenUsage): void {
    this.tokensUsed +=
      Math.max(0, usage.prompt) + Math.max(0, usage.completion);
  }

  /** 重置(每次 summarise 完成后调用) */
  reset(retainedTokens: number): void {
    this.tokensUsed = Math.max(0, retainedTokens);
  }

  shouldSummarise(): boolean {
    return this.tokensUsed > this.maxTokens;
  }

  getState(): BudgetState {
    return {
      tokensUsed: this.tokensUsed,
      lastSummariseAt: this.lastSummariseAt,
      summariseCount: this.summariseCount,
    };
  }

  /**
   * 触发摘要。
   * 入参 rounds 应为完整对话历史(按时间序)。
   * 返回 SummariseOutput;调用方负责把 summary + recentRounds 拼成新 context。
   */
  async summarise(
    rounds: ReadonlyArray<ConversationRound>,
  ): Promise<SummariseOutput> {
    if (rounds.length <= this.recentRounds) {
      // 不够压缩,直接返回空摘要
      const retained = rounds.reduce((s, r) => s + r.tokens, 0);
      this.reset(retained);
      return { summary: "", compressedTokens: 0, droppedRounds: [] };
    }
    try {
      this.logger.info("summarise triggered", {
        rounds_total: rounds.length,
        tokens_used: this.tokensUsed,
        max_tokens: this.maxTokens,
        recent_kept: this.recentRounds,
      });
      const out = await this.summariser.summarise(rounds, this.recentRounds);
      this.summariseCount += 1;
      this.lastSummariseAt = this.now().toISOString();
      safe(
        () => this.metrics.inc("runtime.context_budget_triggers"),
        undefined,
      );
      // 新 budget = 摘要 + 最近 N 轮
      const recentTokens = rounds
        .slice(-this.recentRounds)
        .reduce((s, r) => s + r.tokens, 0);
      this.reset(out.compressedTokens + recentTokens);
      this.logger.info("summarise done", {
        compressed_tokens: out.compressedTokens,
        dropped_rounds: out.droppedRounds.length,
        new_tokens_used: this.tokensUsed,
      });
      return out;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error("summarise failed", { err: msg });
      throw new ContextSummariseError(`summariser failed: ${msg}`);
    }
  }
}
