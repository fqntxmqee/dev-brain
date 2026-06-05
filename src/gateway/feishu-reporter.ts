import type { FeishuInboundMessage } from "../core/types.js";
import { MAX_REPLY_TEXT_BYTES } from "../core/constants.js";
import type { FeishuInteractiveCard } from "./feishu-cards.js";

export interface FeishuReply {
  readonly chatId: string;
  readonly text: string;
  readonly replyToMessageId?: string;
}

export interface FeishuCardReply {
  readonly chatId: string;
  readonly card: FeishuInteractiveCard;
  readonly replyToMessageId?: string;
}

export interface FeishuReporter {
  sendText(reply: FeishuReply): Promise<void>;
  sendCard?(reply: FeishuCardReply): Promise<void>;
}

/** 飞书单条 text 长度上限（CAP-CLI 16KB / T-43） */
export class ReplyTooLongError extends Error {
  readonly code = "REPLY_TOO_LONG";
  constructor(
    public readonly actualBytes: number,
    public readonly limitBytes: number,
  ) {
    super(`reply text too long: ${actualBytes} > ${limitBytes} bytes`);
  }
}

export function assertReplyTextWithinLimit(
  text: string,
  limitBytes: number = MAX_REPLY_TEXT_BYTES,
): void {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > limitBytes) {
    throw new ReplyTooLongError(bytes, limitBytes);
  }
}

/** CLI / 测试用的内存 Reporter */
export class InMemoryFeishuReporter implements FeishuReporter {
  readonly sent: FeishuReply[] = [];
  readonly cards: FeishuCardReply[] = [];

  async sendText(reply: FeishuReply): Promise<void> {
    this.sent.push(reply);
  }

  async sendCard(reply: FeishuCardReply): Promise<void> {
    this.cards.push(reply);
  }
}

async function spawnLarkCli(args: ReadonlyArray<string>): Promise<void> {
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("lark-cli", args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`lark-cli exited with code ${code}`));
    });
  });
}

/** Phase 2+: 通过 lark-cli im 发送消息 */
export class LarkCliFeishuReporter implements FeishuReporter {
  constructor(
    private readonly receiveIdType: "chat_id" | "open_id" = "chat_id",
  ) {}

  async sendText(reply: FeishuReply): Promise<void> {
    assertReplyTextWithinLimit(reply.text);
    await spawnLarkCli([
      "im",
      "+messages-send",
      "--receive-id",
      reply.chatId,
      "--receive-id-type",
      this.receiveIdType,
      "--msg-type",
      "text",
      "--content",
      JSON.stringify({ text: reply.text }),
    ]);
  }

  async sendCard(reply: FeishuCardReply): Promise<void> {
    await spawnLarkCli([
      "im",
      "+messages-send",
      "--receive-id",
      reply.chatId,
      "--receive-id-type",
      this.receiveIdType,
      "--msg-type",
      "interactive",
      "--content",
      JSON.stringify(reply.card),
    ]);
  }
}

export function formatInboundLog(message: FeishuInboundMessage): string {
  return `[feishu] ${message.senderName}@${message.chatId}: ${message.text.slice(0, 80)}`;
}

export function supportsCards(
  reporter: FeishuReporter,
): reporter is Required<Pick<FeishuReporter, "sendCard">> & FeishuReporter {
  return typeof reporter.sendCard === "function";
}
