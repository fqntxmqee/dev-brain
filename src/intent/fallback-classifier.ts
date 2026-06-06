/**
 * 兜底分类器 (CAP-INT-01) — DeepSeek 不可用时降级
 *
 * 当前实现: 简单的关键词 + 正则匹配,无需外部 LLM。
 * 后续可替换为 MiniMax haiku 调用。
 */

import type {
  Intent,
  IntentClassifier,
  IntentContext,
  IntentType,
  IntentUrgency,
} from "./types.js";

const TYPE_PATTERNS: ReadonlyArray<{
  type: IntentType;
  patterns: ReadonlyArray<RegExp>;
}> = [
  {
    type: "bug",
    patterns: [/不[工正正常]|失败|报错|错误|异常|crash|挂了|崩了|bug|fix/i],
  },
  {
    type: "refactor",
    patterns: [/重构|优化|清理|拆分|合并|rename|重命名|抽象|统一/i],
  },
  {
    type: "query",
    patterns: [
      /\?$|^怎么|如何|为什么|多少|几个|哪里|哪个|what|how|why/i,
      /^(查|看|列|列出|显示|打印)/,
    ],
  },
  {
    type: "config",
    patterns: [/配置|env|环境变量|权限|deploy|部署|开关/i],
  },
  {
    type: "feature",
    patterns: [
      /加|新增|添加|实现|做一个|做一个|开发|新接口|新页面|新功能|create|add|implement/i,
    ],
  },
];

const URGENCY_PATTERNS: ReadonlyArray<{
  urgency: IntentUrgency;
  patterns: ReadonlyArray<RegExp>;
}> = [
  {
    urgency: "critical",
    patterns: [/紧急|立刻|马上|生产|线上|critical|urgent/i],
  },
  { urgency: "high", patterns: [/尽快|今天|明天|asap|soon/i] },
];

const MODULE_HINT_RE =
  /(trade|user|order|product|auth|payment|cart|admin|api|web|app)\b/gi;

export interface FallbackClassifierDeps {
  readonly now?: () => Date;
}

/** 简单的关键词分类器 — 兜底用 */
export class FallbackClassifier implements IntentClassifier {
  readonly name = "fallback-haiku";

  classify(text: string, context: IntentContext): Promise<Intent> {
    const lower = text.toLowerCase();
    let type: IntentType = "feature"; // 默认 feature
    for (const { type: candidate, patterns } of TYPE_PATTERNS) {
      if (patterns.some((re) => re.test(lower))) {
        type = candidate;
        break;
      }
    }

    let urgency: IntentUrgency = "normal";
    for (const { urgency: candidate, patterns } of URGENCY_PATTERNS) {
      if (patterns.some((re) => re.test(lower))) {
        urgency = candidate;
        break;
      }
    }

    const entities = this.extractEntities(text);
    const affected_modules = this.guessModules(text, entities);

    return Promise.resolve({
      type,
      entities,
      affected_modules,
      urgency,
      intent_score: 0.5, // 兜底固定 0.5
      trace_id: context.chatId,
      source: "fallback-haiku",
    });
  }

  private extractEntities(text: string): string[] {
    const matches = text.matchAll(MODULE_HINT_RE);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of matches) {
      const v = m[0].toLowerCase();
      if (!seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
    // 抓"加 XX / 实现 XX" 这种
    const addRe = /加\s*([a-z_][a-z0-9_]{1,20})/gi;
    for (const m of text.matchAll(addRe)) {
      const v = m[1]?.toLowerCase();
      if (v && !seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
    return out.slice(0, 8);
  }

  private guessModules(_text: string, entities: string[]): string[] {
    const mods: string[] = [];
    for (const e of entities) {
      if (
        [
          "trade",
          "user",
          "order",
          "product",
          "auth",
          "payment",
          "cart",
          "admin",
        ].includes(e)
      ) {
        mods.push(`${e}/**`);
      }
    }
    return mods;
  }
}
