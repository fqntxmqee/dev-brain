/**
 * v0.9.0: 卡片超长降级（CAP-GW-07 / T-95）
 *
 * 飞书单条卡片内容上限约 28KB。
 * degradeCardForSize 触发三档降级,逐步压缩 lark_md 字段长度 + 步骤数。
 *
 * 触发流程:
 *   1. 测 JSON.stringify(card).length
 *   2. ≤ 28KB → 原样返回
 *   3. > 28KB → 切到 tier 1 (10 步 / 180 字符)
 *   4. 还 > 28KB → tier 2 (6 步 / 120 字符)
 *   5. 还 > 28KB → tier 3 (3 步 / 80 字符)
 *   6. 还 > 28KB → 截断到一个 note 提示
 */

import type { FeishuInteractiveCard } from "./feishu-cards.js";

export interface DegradeOptions {
  /** 字节上限;默认 28 * 1024 */
  readonly maxBytes?: number;
}

const TIERS: ReadonlyArray<{ maxSteps: number; maxField: number }> = [
  { maxSteps: 10, maxField: 180 },
  { maxSteps: 6, maxField: 120 },
  { maxSteps: 3, maxField: 80 },
];

export function degradeCardForSize(
  card: FeishuInteractiveCard,
  options: DegradeOptions = {},
): FeishuInteractiveCard {
  const result = degradeCardForSizeWithFlag(card, options);
  return result.card;
}

/**
 * 与 degradeCardForSize 等价,但额外返回是否被降级(便于 metrics 计数)。
 */
export function degradeCardForSizeWithFlag(
  card: FeishuInteractiveCard,
  options: DegradeOptions = {},
): { readonly card: FeishuInteractiveCard; readonly degraded: boolean } {
  const maxBytes = options.maxBytes ?? 28 * 1024;
  if (JSON.stringify(card).length <= maxBytes) {
    return { card, degraded: false };
  }

  for (const tier of TIERS) {
    const reduced = shrinkCard(card, tier.maxSteps, tier.maxField);
    if (JSON.stringify(reduced).length <= maxBytes) {
      return { card: reduced, degraded: true };
    }
  }

  // 极端降级失败:追加 note 提示
  return { card: appendOverflowNote(card), degraded: true };
}

function shrinkCard(
  card: FeishuInteractiveCard,
  maxSteps: number,
  maxField: number,
): FeishuInteractiveCard {
  const newElements = card.elements.map((el) =>
    shrinkElement(el, maxSteps, maxField),
  );
  return { ...card, elements: newElements };
}

function shrinkElement(
  el: Record<string, unknown>,
  maxSteps: number,
  maxField: number,
): Record<string, unknown> {
  // lark_md text div
  if (el.tag === "div" && el.text && typeof el.text === "object") {
    const text = el.text as Record<string, unknown>;
    if (text.tag === "lark_md" && typeof text.content === "string") {
      const reduced = shrinkMarkdown(text.content, maxSteps, maxField);
      if (reduced !== text.content) {
        return { ...el, text: { ...text, content: reduced } };
      }
    }
  }
  return el;
}

/**
 * 缩 markdown 内容:
 *  - 限制步骤行数(以 `1. ` / `- ` 开头算一步)
 *  - 限制单行长度(过长加 "…")
 *  - 截掉多余内容
 */
export function shrinkMarkdown(
  content: string,
  maxSteps: number,
  maxField: number,
): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let steps = 0;
  const stepStart = /^\s*(?:\d+\.\s+|-\s+)/;
  let truncated = false;

  for (const line of lines) {
    if (stepStart.test(line)) {
      if (steps >= maxSteps) {
        truncated = true;
        break;
      }
      steps += 1;
    }
    out.push(truncateLine(line, maxField));
  }

  if (truncated) {
    out.push(`…（剩余内容已省略）`);
  }
  return out.join("\n");
}

function truncateLine(line: string, maxChars: number): string {
  if (line.length <= maxChars) return line;
  return `${line.slice(0, Math.max(0, maxChars - 1))}…`;
}

function appendOverflowNote(
  card: FeishuInteractiveCard,
): FeishuInteractiveCard {
  return {
    ...card,
    elements: [
      ...card.elements,
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content: "⚠️ 卡片内容过长,已被截断。请查看文本摘要。",
          },
        ],
      },
    ],
  };
}
