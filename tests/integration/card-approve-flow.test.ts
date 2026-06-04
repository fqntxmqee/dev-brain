import { describe, expect, it } from 'vitest';
import { createDevBrainApp } from '../../src/bootstrap.js';
import { buildPlanCard } from '../../src/gateway/feishu-cards.js';
import { InMemoryFeishuReporter } from '../../src/gateway/feishu-reporter.js';

/** Covers: L5-BRAIN-06 */
describe('Feishu card approve flow', () => {
  it('should_execute_plan_when_card_action_approve', async () => {
    const reporter = new InMemoryFeishuReporter();
    const app = createDevBrainApp(reporter);
    const chatId = 'oc_card_chat';

    await app.gateway.handleMessage({
      messageId: 'm-plan',
      chatId,
      senderOpenId: 'ou_boss',
      senderName: 'boss',
      text: '给 trade 模块加筛选',
    });

    expect(reporter.cards.length).toBeGreaterThan(0);
    const planCard = reporter.cards[0]?.card;
    expect(JSON.stringify(planCard)).toContain('approve');

    const plan = app.brain.getPendingPlan(chatId);
    expect(plan).toBeDefined();

    await app.gateway.handleCardAction({
      action: 'approve',
      chatId,
      taskId: plan!.taskId,
      operatorOpenId: 'ou_boss',
      operatorName: 'boss',
    });

    expect(app.brain.getStatus().completedTasks).toBe(1);
    expect(reporter.sent.at(-1)?.text).toContain('任务');
  });

  it('should_include_action_buttons_when_configured', () => {
    const card = buildPlanCard(
      {
        taskId: 't1',
        chatId: 'oc1',
        description: 'demo',
        subTasks: [],
        phase: 'awaiting_approval',
        createdAt: new Date().toISOString(),
        summary: '',
      },
      { withActions: true },
    );
    expect(JSON.stringify(card)).toContain('批准执行');
    expect(JSON.stringify(card)).toContain('cancel');
  });
});
