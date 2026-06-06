/**
 * Intent Classifier Orchestrator (CAP-INT-01)
 * 顺序: 1. cache hit → 直接返 2. DeepSeek 失败 → fallback 3. 全部失败 → throw
 */

import { defaultLogger, type Logger } from "../core/logger.js";
import { DeepSeekAdapter, type DeepSeekConfig } from "./deepseek-adapter.js";
import { FallbackClassifier } from "./fallback-classifier.js";
import { IntentCache, type IntentCacheConfig } from "./cache.js";
import {
  IntentClassifyError,
  type Intent,
  type IntentClassifier,
  type IntentContext,
} from "./types.js";

export interface ClassifierConfig {
  readonly deepseek: DeepSeekConfig;
  readonly cache: IntentCacheConfig;
  /** DeepSeek 不可用时是否走 fallback (默认 true) */
  readonly enableFallback: boolean;
  /** 连续 fallback N 次后发 WARN 日志 (默认 5) */
  readonly fallbackWarnThreshold: number;
}

export interface ClassifierDeps {
  readonly logger?: Logger;
  readonly now?: () => Date;
  /** 测试可注入 mock classifier */
  readonly deepseekOverride?: IntentClassifier;
  readonly fallbackOverride?: IntentClassifier;
}

export class ClassifierOrchestrator implements IntentClassifier {
  readonly name = "classifier-orchestrator";
  private readonly logger: Logger;
  private readonly deepseek: IntentClassifier;
  private readonly fallback: IntentClassifier;
  private readonly cache: IntentCache;
  private readonly enableFallback: boolean;
  private readonly fallbackWarnThreshold: number;
  private consecutiveFallbacks = 0;

  constructor(config: ClassifierConfig, deps: ClassifierDeps = {}) {
    this.logger =
      deps.logger ?? defaultLogger.child({ component: "intent-classifier" });
    this.deepseek =
      deps.deepseekOverride ??
      new DeepSeekAdapter(config.deepseek, {
        logger: this.logger,
        now: deps.now,
      });
    this.fallback = deps.fallbackOverride ?? new FallbackClassifier();
    const nowFn = deps.now;
    this.cache = new IntentCache(
      config.cache,
      nowFn ? () => nowFn().getTime() : Date.now,
    );
    this.enableFallback = config.enableFallback;
    this.fallbackWarnThreshold = config.fallbackWarnThreshold;
  }

  async classify(text: string, context: IntentContext): Promise<Intent> {
    const traceId = context.chatId;

    // 1. cache hit
    const cached = this.cache.get(text, context);
    if (cached) {
      this.logger.debug("intent cache hit", { trace_id: traceId });
      return cached;
    }

    // 2. try DeepSeek
    let intent: Intent;
    try {
      intent = await this.deepseek.classify(text, context);
      this.consecutiveFallbacks = 0;
    } catch (err) {
      if (!this.enableFallback) {
        throw err;
      }
      this.consecutiveFallbacks += 1;
      if (this.consecutiveFallbacks >= this.fallbackWarnThreshold) {
        this.logger.warn("deepseek repeatedly failing; using fallback", {
          trace_id: traceId,
          consecutive: this.consecutiveFallbacks,
          err: err instanceof Error ? err.message : String(err),
        });
      } else {
        this.logger.info("deepseek failed; using fallback", {
          trace_id: traceId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        intent = await this.fallback.classify(text, context);
      } catch (fbErr) {
        const message = `both deepseek and fallback failed: ${err instanceof Error ? err.message : String(err)} | ${fbErr instanceof Error ? fbErr.message : String(fbErr)}`;
        throw new IntentClassifyError(message, { retryable: false });
      }
    }

    // 3. cache the result
    this.cache.set(text, context, intent);
    return intent;
  }

  /** 测试/管理用 */
  getCacheSize(): number {
    return this.cache.size();
  }

  clearCache(): void {
    this.cache.clear();
  }
}
