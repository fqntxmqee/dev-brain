import type { PlannedSubTask } from '../core/types.js';

/** 按 dependsOn 拓扑分层，同层子任务可并行执行 */
export function computeExecutionTiers(
  subTasks: ReadonlyArray<PlannedSubTask>,
): ReadonlyArray<ReadonlyArray<PlannedSubTask>> {
  const remaining = new Set(subTasks.map((st) => st.id));
  const completed = new Set<string>();
  const tiers: PlannedSubTask[][] = [];

  while (remaining.size > 0) {
    const tier = subTasks.filter(
      (st) =>
        remaining.has(st.id) && (st.dependsOn ?? []).every((dep) => completed.has(dep)),
    );
    if (tier.length === 0) {
      throw new Error('Sub-task dependency cycle detected');
    }
    tiers.push(tier);
    for (const st of tier) {
      remaining.delete(st.id);
      completed.add(st.id);
    }
  }

  return tiers;
}
