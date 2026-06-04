import type { CardActionType, FeishuCardAction, FeishuInboundEvent, FeishuInboundMessage } from '../core/types.js';

const CARD_ACTION_EVENTS = new Set([
  'card.action.trigger',
  'card.action.trigger_v1',
  'card.action.trigger_v2',
]);

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseCardActionValue(raw: unknown): { action?: CardActionType; taskId?: string; chatId?: string } {
  if (typeof raw !== 'object' || raw === null) {
    return {};
  }
  const map = raw as Record<string, unknown>;
  const actionRaw = readString(map.action);
  const action =
    actionRaw === 'approve' || actionRaw === 'cancel' ? actionRaw : undefined;
  return {
    action,
    taskId: readString(map.task_id) ?? readString(map.taskId),
    chatId: readString(map.chat_id) ?? readString(map.chatId),
  };
}

export function parseFeishuCardActionEvent(line: string): FeishuCardAction | undefined {
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
      operatorOpenId: readString(event.operator?.open_id) ?? 'unknown',
      operatorName: readString(event.operator?.name) ?? 'user',
    };
  } catch {
    return undefined;
  }
}

export function parseFeishuMessageEvent(line: string): FeishuInboundMessage | undefined {
  try {
    const event = JSON.parse(line) as {
      event_type?: string;
      message?: {
        message_id?: string;
        chat_id?: string;
        content?: string;
      };
      sender?: {
        sender_id?: { open_id?: string };
        name?: string;
      };
    };

    if (event.event_type !== 'im.message.receive_v1') {
      return undefined;
    }

    const contentRaw = event.message?.content ?? '{}';
    const parsed = JSON.parse(contentRaw) as { text?: string };
    const text = parsed.text?.trim() ?? '';
    if (!text || !event.message?.chat_id || !event.message.message_id) {
      return undefined;
    }

    return {
      messageId: event.message.message_id,
      chatId: event.message.chat_id,
      senderOpenId: event.sender?.sender_id?.open_id ?? 'unknown',
      senderName: event.sender?.name ?? 'user',
      text,
    };
  } catch {
    return undefined;
  }
}

export function parseFeishuInboundEvent(line: string): FeishuInboundEvent | undefined {
  const cardAction = parseFeishuCardActionEvent(line);
  if (cardAction) {
    return { kind: 'card_action', action: cardAction };
  }

  const message = parseFeishuMessageEvent(line);
  if (message) {
    return { kind: 'message', message };
  }

  return undefined;
}

/** @deprecated use parseFeishuMessageEvent */
export function parseFeishuEventLine(line: string): FeishuInboundMessage | undefined {
  return parseFeishuMessageEvent(line);
}
