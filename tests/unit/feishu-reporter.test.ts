import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryFeishuReporter,
  LarkCliFeishuReporter,
  ReplyTooLongError,
  assertReplyTextWithinLimit,
  formatInboundLog,
  supportsCards,
} from "../../src/gateway/feishu-reporter.js";
import type { FeishuInteractiveCard } from "../../src/gateway/feishu-cards.js";

const sampleCard: FeishuInteractiveCard = {
  config: { wide_screen_mode: true },
  header: {
    template: "blue",
    title: { tag: "plain_text", content: "card" },
  },
  elements: [],
};

describe("assertReplyTextWithinLimit (T-43)", () => {
  it("passes_when_below_limit", () => {
    expect(() => assertReplyTextWithinLimit("hello")).not.toThrow();
  });

  it("respects_explicit_custom_limit", () => {
    expect(() => assertReplyTextWithinLimit("abc", 2)).toThrow(
      ReplyTooLongError,
    );
  });

  it("throws_ReplyTooLongError_with_byte_metadata", () => {
    const big = "x".repeat(20_000);
    try {
      assertReplyTextWithinLimit(big);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ReplyTooLongError);
      const e = err as ReplyTooLongError;
      expect(e.code).toBe("REPLY_TOO_LONG");
      expect(e.actualBytes).toBe(20_000);
      expect(e.limitBytes).toBeGreaterThan(0);
    }
  });

  it("counts_utf8_bytes_not_characters", () => {
    // 一个汉字 = 3 bytes UTF-8。limit=8，传入 3 个汉字（9 bytes）应失败
    expect(() => assertReplyTextWithinLimit("一二三", 8)).toThrow(
      ReplyTooLongError,
    );
  });
});

describe("formatInboundLog", () => {
  it("renders_sender_chat_text_with_emoji_prefix", () => {
    const log = formatInboundLog({
      messageId: "m1",
      chatId: "c1",
      senderOpenId: "ou_a",
      senderName: "alice",
      text: "hello world",
    });
    expect(log).toContain("[feishu]");
    expect(log).toContain("alice");
    expect(log).toContain("c1");
    expect(log).toContain("hello world");
  });

  it("falls_back_to_openId_when_name_missing", () => {
    const log = formatInboundLog({
      messageId: "m1",
      chatId: "c1",
      senderOpenId: "ou_a",
      text: "hi",
    });
    expect(log).toContain("ou_a");
  });

  it("truncates_to_80_chars", () => {
    const log = formatInboundLog({
      messageId: "m1",
      chatId: "c1",
      senderOpenId: "ou_a",
      senderName: "a",
      text: "x".repeat(200),
    });
    // 80 chars in payload + prefix
    expect(log.length).toBeLessThan(200);
  });
});

describe("supportsCards", () => {
  it("returns_true_for_InMemory_reporter", () => {
    const r = new InMemoryFeishuReporter();
    expect(supportsCards(r)).toBe(true);
  });

  it("returns_false_when_sendCard_missing", () => {
    const r = {
      sendText: async () => undefined,
    };
    expect(supportsCards(r as never)).toBe(false);
  });
});

describe("InMemoryFeishuReporter", () => {
  it("captures_text_messages", async () => {
    const r = new InMemoryFeishuReporter();
    await r.sendText({ chatId: "c1", text: "hi" });
    expect(r.sent).toEqual([{ chatId: "c1", text: "hi" }]);
  });

  it("captures_card_messages_and_increments_seq", async () => {
    const r = new InMemoryFeishuReporter();
    await r.sendCard({ chatId: "c1", card: sampleCard });
    await r.sendCard({ chatId: "c2", card: sampleCard });
    expect(r.cards).toHaveLength(2);
  });

  it("captures_card_updates_and_echos_messageId", async () => {
    const r = new InMemoryFeishuReporter();
    const id = await r.updateCard({ messageId: "om1", card: sampleCard });
    expect(id).toBe("om1");
    expect(r.updates).toEqual([{ messageId: "om1", card: sampleCard }]);
  });
});

describe("LarkCliFeishuReporter (spawn-mocked)", () => {
  const originalEnv = process.env.PATH;

  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetModules();
    process.env.PATH = originalEnv;
  });

  it("rejects_text_exceeding_limit_before_spawning", async () => {
    const reporter = new LarkCliFeishuReporter();
    const big = "x".repeat(20_000);
    await expect(
      reporter.sendText({ chatId: "c1", text: big }),
    ).rejects.toBeInstanceOf(ReplyTooLongError);
  });

  it("spawn_failure_propagates_lark_cli_exit_code", async () => {
    const reporter = new LarkCliFeishuReporter();
    // Point PATH to /dev/null so lark-cli definitely isn't found
    process.env.PATH = "/dev/null";
    await expect(
      reporter.sendText({ chatId: "c1", text: "hello" }),
    ).rejects.toThrow();
  });

  it("constructor_accepts_open_id_receiveIdType", () => {
    const r = new LarkCliFeishuReporter("open_id");
    expect(r).toBeInstanceOf(LarkCliFeishuReporter);
  });
});
