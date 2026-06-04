import { describe, expect, it } from 'vitest';
import { buildDefaultSubTasks, formatPlanSummary } from '../../src/brain/task-planner.js';

describe('task-planner', () => {
  // Covers: L5-BRAIN-02
  it('should_build_three_subtasks_by_default', () => {
    const subTasks = buildDefaultSubTasks('实现用户登录');
    expect(subTasks).toHaveLength(3);
    expect(subTasks.map((s) => s.runtime)).toContain('claude-code');
  });

  it('should_include_approve_hint_in_summary', () => {
    const subTasks = buildDefaultSubTasks('fix bug');
    const summary = formatPlanSummary('fix bug', subTasks);
    expect(summary).toContain('/approve');
  });
});
