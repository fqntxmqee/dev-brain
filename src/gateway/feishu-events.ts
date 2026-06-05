import { z } from "zod";
import type {
  CardActionType,
  FeishuCardAction,
  FeishuInboundEvent,
  FeishuInboundMessage,
} from "../core/types.js";

/** 飞书 open_id 格式：以 `ou_` 开头的字符串 */
const OpenIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "open_id contains illegal characters")
  .refine((s) => !s.includes("\0"), "open_id must not contain NUL");

/** chat_id 格式：以 `oc_` 开头 */
const ChatIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "chat_id contains illegal characters");

/** message_id 格式：以 `om_` 开头 */
const MessageIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "message_id contains illegal characters");

const CARD_ACTION_EVENTS = new Set([
  "card.action.trigger",
  "card.action.trigger_v1",
  "card.action.trigger_v2",
]);

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseCardActionValue(raw: unknown): {
  action?: CardActionType;
  taskId?: string;
  chatId?: string;
} {
  if (typeof raw !== "object" || raw === null) {
    return {};
  }
  const map = raw as Record<string, unknown>;
  const actionRaw = readString(map.action);
  const action =
    actionRaw === "approve" || actionRaw === "cancel" ? actionRaw : undefined;
  return {
    action,
    taskId: readString(map.task_id) ?? readString(map.taskId),
    chatId: readString(map.chat_id) ?? readString(map.chatId),
  };
}

export function parseFeishuCardActionEvent(
  line: string,
): FeishuCardAction | undefined {
  try {
    const event = JSON.parse(line) as {
      event_type?: string;
      operator?: { open_id?: string; name?: string };
      action?: { value?: unknown };
      context?: { open_chat_id?: string };
      open_chat_id?: string;
    };

    if (!event.event_type || !CARD_ACTION_EVENTS.has(event.event_type)) {
      return undefined;
    }

    const parsed = parseCardActionValue(event.action?.value);
    if (!parsed.action) {
      return undefined;
    }

    const chatId =
      parsed.chatId ??
      readString(event.context?.open_chat_id) ??
      readString(event.open_chat_id);
    if (!chatId || !parsed.taskId) {
      return undefined;
    }

    return {
      action: parsed.action,
      chatId,
      taskId: parsed.taskId,
      operatorOpenId: readString(event.operator?.open_id) ?? "unknown",
      operatorName: readString(event.operator?.name) ?? "user",
    };
  } catch {
    return undefined;
  }
}

export function parseFeishuMessageEvent(
  line: string,
): FeishuInboundMessage | undefined {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;

    // 同时支持两种 schema：
    //   1) lark-cli event +subscribe --compact 扁平格式：
    //      {type, chat_id, message_id, content, sender_id, message_type, ...}
    //   2) 飞书 WebSocket 嵌套格式（v0.7.0 之前用）：
    //      {event_type, message: {message_id, chat_id, content}, sender: {sender_id: {open_id}, name}}
    const eventType = readString(event.type) ?? readString(event.event_type);
    if (eventType !== "im.message.receive_v1") {
      return undefined;
    }

    // 提取 message 容器（嵌套格式）或直接使用顶层（扁平格式）
    const message =
      (event.message as Record<string, unknown> | undefined) ?? event;

    const messageId = readString(message.message_id) ?? readString(message.id);
    const chatId = readString(message.chat_id);

    // content 在两种格式下意义不同：
    //   扁平：纯文本
    //   嵌套：JSON 字符串 e.g. `{"text":"..."}`
    const rawContent = readString(message.content) ?? "";
    let text: string | undefined;
    if (rawContent.startsWith("{")) {
      try {
        const parsed = JSON.parse(rawContent) as { text?: string };
        text = readString(parsed.text);
      } catch {
        // fall through: treat as plain text
        text = rawContent;
      }
    } else {
      text = rawContent;
    }
    text = text?.trim();
    if (!text || !chatId || !messageId) {
      return undefined;
    }

    // sender_id：扁平格式直接是 open_id；嵌套格式是 {open_id, ...}
    const senderField = (event.sender ?? {}) as Record<string, unknown>;
    const senderIdField = (senderField.sender_id ?? event.sender_id) as
      | string
      | Record<string, unknown>
      | undefined;
    let senderOpenId: string | undefined;
    if (typeof senderIdField === "string") {
      senderOpenId = readString(senderIdField);
    } else if (senderIdField && typeof senderIdField === "object") {
      senderOpenId = readString(
        (senderIdField as Record<string, unknown>).open_id,
      );
    }
    if (!senderOpenId) {
      return undefined;
    }

    // 校验关键字段：open_id / chat_id / message_id 拒绝畸形值
    const openIdResult = OpenIdSchema.safeParse(senderOpenId);
    const chatIdResult = ChatIdSchema.safeParse(chatId);
    const msgIdResult = MessageIdSchema.safeParse(messageId);
    if (
      !openIdResult.success ||
      !chatIdResult.success ||
      !msgIdResult.success
    ) {
      return undefined;
    }

    const senderName =
      readString(senderField.name) ??
      (typeof senderIdField === "object" && senderIdField
        ? readString((senderIdField as Record<string, unknown>).name)
        : undefined) ??
      "user";

    return {
      messageId: msgIdResult.data,
      chatId: chatIdResult.data,
      senderOpenId: openIdResult.data,
      senderName,
      text,
    };
  } catch {
    return undefined;
  }
}

export function parseFeishuInboundEvent(
  line: string,
): FeishuInboundEvent | undefined {
  const cardAction = parseFeishuCardActionEvent(line);
  if (cardAction) {
    return { kind: "card_action", action: cardAction };
  }

  const message = parseFeishuMessageEvent(line);
  if (message) {
    return { kind: "message", message };
  }

  return undefined;
}
