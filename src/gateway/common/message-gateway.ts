/**
 * 平台无关的 Gateway 公共类型（T-32 / CAP-GW-01）。
 * 让 Slack / 钉钉能复用 70% 逻辑：所有平台适配层（feishu/、slack/、dingtalk/）都实现 MessageGateway + OutboundReporter。
 */
import type { InboundMessage } from "../../core/types.js";

/** 平台抽象：接收 + 解析入站事件 */
export interface MessageGateway {
  start(signal: AbortSignal): Promise<void>;
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
}

/** 平台无关出站接口 */
export interface OutboundReporter {
  sendText(
    chatId: string,
    text: string,
    replyToMessageId?: string,
  ): Promise<void>;
  sendCard?(
    chatId: string,
    card: unknown,
    replyToMessageId?: string,
  ): Promise<void>;
  updateCard?(messageId: string, card: unknown): Promise<void>;
}
