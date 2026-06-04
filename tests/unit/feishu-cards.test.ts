import { describe, expect, it } from 'vitest';
import { buildDefaultSubTasks } from '../../src/brain/task-planner.js';
import { buildPlanCard, buildProgressCard, serializeCard } from '../../src/gateway/feishu-cards.js';

describe('Feishu cards', () => {
  it('should_build_plan_card_with_subtasks', () => {
    const subTasks = buildDefaultSubTasks('探索 auth 模块');
    const card = buildPlanCard({
      taskId: 'abc-123',
      chatId: 'oc_test',
      description: '探索 auth 模块',
      subTasks,
      phase: 'awaiting_approval',
      createdAt: new Date().toISOString(),
      summary: '',
    }, { withActions: true });

    const json = serializeCard(card);
    expect(json).toContain('Dev Brain 任务计划');
    expect(json).toContain('claude-code');
    expect(json).toContain('approve');
  });

  it('should_build_progress_card_with_status_icons', () => {
    const card = buildProgressCard({
      taskId: 'abc-123',
      description: 'demo',
      subTasks: [
        { id: 'st-1', runtime: 'claude-code', status: 'completed' },
        { id: 'st-2', runtime: 'codex', status: 'executing' },
      ],
    });

    const json = serializeCard(card);
    expect(json).toContain('执行进度');
    expect(json).toContain('executing');
  });
});
