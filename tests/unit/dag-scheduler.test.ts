import { describe, expect, it } from 'vitest';
import { buildDefaultSubTasks } from '../../src/brain/task-planner.js';
import { computeExecutionTiers } from '../../src/orchestrator/dag-scheduler.js';

describe('DAG scheduler', () => {
  it('should_parallelize_st2_and_st3_after_st1', () => {
    const subTasks = buildDefaultSubTasks('给 trade 模块加日期筛选');
    const tiers = computeExecutionTiers(subTasks);

    expect(tiers).toHaveLength(2);
    expect(tiers[0]?.map((st) => st.id)).toEqual(['st-1']);
    expect(tiers[1]?.map((st) => st.id).sort()).toEqual(['st-2', 'st-3']);
  });
});
