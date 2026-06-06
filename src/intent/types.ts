/**
 * 意图识别子系统的 schema。
 * 对应 OpenSpec: openspec/changes/spec-driven-workflow/specs/intent/spec.md
 */

export type IntentType = "feature" | "bug" | "refactor" | "query" | "config";

export type IntentUrgency = "low" | "normal" | "high" | "critical";

/** DeepSeek / fallback LLM 产出的结构化分类结果 */
export interface Intent {
  readonly type: IntentType;
  /** 从文本抽取的命名实体 (e.g. "trade", "date_filter") */
  readonly entities: ReadonlyArray<string>;
  /** 推测影响的代码模块 (glob pattern, e.g. "trade/**") */
  readonly affected_modules: ReadonlyArray<string>;
  readonly urgency: IntentUrgency;
  /** 0-1,LLM 置信度 */
  readonly intent_score: number;
  readonly trace_id: string;
  /** 分类器来源 (deepseek / fallback-haiku) */
  readonly source: "deepseek" | "fallback-haiku" | "cache";
}

export interface IntentContext {
  readonly chatId: string;
  readonly senderOpenId: string;
  /** 最近 5 条历史消息文本(可选,辅助分类) */
  readonly recentMessages?: ReadonlyArray<string>;
}

/** Classifier 接口 — 主 orchestrator + 兜底 + 缓存都实现此接口 */
export interface IntentClassifier {
  readonly name: string;
  classify(text: string, context: IntentContext): Promise<Intent>;
}

export class IntentClassifyError extends Error {
  readonly code = "INTENT_CLASSIFY_ERROR";
  readonly retryable: boolean;
  constructor(message: string, opts: { retryable?: boolean } = {}) {
    super(message);
    this.name = "IntentClassifyError";
    this.retryable = opts.retryable ?? true;
  }
}
