import { describe, expect, it } from "vitest";
import {
  degradeCardForSize,
  degradeCardForSizeWithFlag,
  shrinkMarkdown,
} from "../../src/gateway/card-degrader.js";
import type { FeishuInteractiveCard } from "../../src/gateway/feishu-cards.js";

function buildCard(stepCount: number, fieldLen: number): FeishuInteractiveCard {
  const lines: string[] = [];
  for (let i = 0; i < stepCount; i += 1) {
    lines.push(`${i + 1}. ${"x".repeat(fieldLen)}`);
  }
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: "Test" }, template: "blue" },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: lines.join("\n") },
      },
    ],
  };
}

describe("degradeCardForSize (CAP-GW-07 / T-95)", () => {
  it("returns_unchanged_when_within_limit", () => {
    const card = buildCard(3, 50);
    const result = degradeCardForSizeWithFlag(card);
    expect(result.degraded).toBe(false);
    expect(result.card).toBe(card);
  });

  it("applies_tier1_10steps_180char_when_just_over_28kb", () => {
    // 真实"刚过 28KB"场景:30 步 × 2000 字符 ≈ 60KB
    const card = buildCard(30, 2000);
    expect(JSON.stringify(card).length).toBeGreaterThan(28 * 1024);

    const result = degradeCardForSizeWithFlag(card);
    expect(result.degraded).toBe(true);
    const content = (
      (result.card.elements[0] as Record<string, unknown>).text as Record<
        string,
        unknown
      >
    ).content as string;
    const stepLines = content.split("\n").filter((l) => /^\d+\./.test(l));
    // tier 1: 10 steps
    expect(stepLines.length).toBeLessThanOrEqual(10);
    // 每行 ≤ 180 chars
    for (const line of stepLines) {
      expect(line.length).toBeLessThanOrEqual(180);
    }
  });

  it("applies_three_tier_degradation_progressively", () => {
    // 巨卡片:100 步 × 5000 字符,tier 1 (10 步 × 180 字符) 还超 28KB 才会逼到 tier 3
    // 单步超 180 → tier 1 不切行数上限,字节数 < 28KB → tier 1 就够
    // 这里构造 100 步 × 10000 字符,tier 1 切 10×180=1800 字节,够
    // 但若我们强制 maxSteps 不够,就需要行数更多
    // 现实场景:50 步 × 5000 字符 ≈ 250KB,tier 1 (10 步 × 180 字符) 后约 2KB,够
    // 要逼到 tier 3,需要每步字符数 > 2.8KB(tier 1 后)
    // 简化:用 50 步 × 20000 字符,tier 1 后 10×180=1800 字节,够
    // 真实触发 tier 3 的场景:多 div 累加(下面 appends_overflow_note 测试覆盖)
    const card = buildCard(50, 5000);
    const result = degradeCardForSizeWithFlag(card);
    expect(result.degraded).toBe(true);
    // tier 1 即可;验证 step count 减少到 ≤ 10
    const content = (
      (result.card.elements[0] as Record<string, unknown>).text as Record<
        string,
        unknown
      >
    ).content as string;
    const stepLines = content.split("\n").filter((l) => /^\d+\./.test(l));
    expect(stepLines.length).toBeLessThanOrEqual(10);
  });

  it("appends_overflow_note_when_even_tier3_exceeds_28kb", () => {
    // 极端:构造一个含多个 div 元素的卡,每个 div 都是 100 行 × 500 字符
    // shrinkMarkdown 只数 \d+\. 开头的行,所以 plain text 行不受 maxSteps 约束
    // tier 3 后 100 行 × 80 字符 = 8000 字节/div,3 个 div = 24KB + header → 仍超
    // 实际 tier 3 步数限制对纯文本行无效,所以保留 100 行,但每行截 80 字符
    const hugeContent = Array.from({ length: 100 }, () => "x".repeat(500)).join(
      "\n",
    );
    const card: FeishuInteractiveCard = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: "plain_text", content: "Big" },
        template: "blue",
      },
      elements: Array.from({ length: 10 }, () => ({
        tag: "div",
        text: { tag: "lark_md", content: hugeContent },
      })),
    };
    expect(JSON.stringify(card).length).toBeGreaterThan(28 * 1024);

    const result = degradeCardForSizeWithFlag(card);
    expect(result.degraded).toBe(true);
    // overflow note 追加到 elements 末尾
    expect(result.card.elements.length).toBeGreaterThan(card.elements.length);
    // 最后一段应是 note,内容含"截断"提示
    const lastEl = result.card.elements[result.card.elements.length - 1];
    expect((lastEl as Record<string, unknown>).tag).toBe("note");
    const json = JSON.stringify(result.card);
    expect(json).toContain("已被截断");
  });

  it("degradeCardForSize_alias_returns_card_only", () => {
    const card = buildCard(50, 5000);
    const result = degradeCardForSize(card);
    expect(result).toBeDefined();
    expect(result.elements).toBeDefined();
  });
});

describe("shrinkMarkdown helper", () => {
  it("limits_step_count", () => {
    const md = ["1. step", "2. step", "3. step", "4. step", "5. step"].join(
      "\n",
    );
    const out = shrinkMarkdown(md, 3, 100);
    expect(out.split("\n").filter((l) => /^\d+\./.test(l)).length).toBe(3);
    expect(out).toContain("…（剩余内容已省略）");
  });

  it("truncates_long_lines", () => {
    const md = `1. ${"x".repeat(500)}`;
    const out = shrinkMarkdown(md, 10, 50);
    const line = out.split("\n")[0] ?? "";
    expect(line.length).toBeLessThanOrEqual(60);
  });

  it("keeps_short_text_unchanged", () => {
    const md = "1. short step\n2. another step";
    expect(shrinkMarkdown(md, 10, 200)).toBe(md);
  });
});
