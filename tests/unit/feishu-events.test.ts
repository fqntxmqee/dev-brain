import { describe, expect, it } from 'vitest';
import { parseFeishuCardActionEvent, parseFeishuInboundEvent } from '../../src/gateway/feishu-events.js';

/** Covers: L5-BRAIN-06 (card button approve) */
describe('Feishu card action events', () => {
  it('should_parse_card_action_approve', () => {
    const line = JSON.stringify({
      event_type: 'card.action.trigger',
      operator: { open_id: 'ou_operator', name: 'boss' },
      action: {
        value: {
          action: 'approve',
          task_id: 'task-abc',
          chat_id: 'oc_chat_1',
        },
      },
      context: { open_chat_id: 'oc_chat_1' },
    });

    const action = parseFeishuCardActionEvent(line);
    expect(action?.action).toBe('approve');
    expect(action?.taskId).toBe('task-abc');
    expect(action?.chatId).toBe('oc_chat_1');
  });

  it('should_route_inbound_event_union', () => {
    const line = JSON.stringify({
      event_type: 'card.action.trigger',
      operator: { open_id: 'ou_operator' },
      action: {
        value: { action: 'cancel', task_id: 't1', chat_id: 'oc1' },
      },
    });
    const event = parseFeishuInboundEvent(line);
    expect(event?.kind).toBe('card_action');
  });
});
