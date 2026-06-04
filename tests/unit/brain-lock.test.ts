import { describe, expect, it } from 'vitest';
import { buildLockConflictSubTasks } from '../../src/brain/task-planner.js';
import { createBrainEngine } from '../../src/brain/brain-engine.js';
import { loadConfig } from '../../src/config/env.js';

/** Covers: L5-BRAIN-04 */
describe('BrainEngine file lock integration', () => {
  it('should_block_parallel_write_on_same_file_scope', async () => {
    const config = loadConfig({ DEV_BRAIN_ADAPTER_MODE: 'stub' });
    const brain = createBrainEngine(config);
    const chatId = 'lock-test-chat';
    const subTasks = buildLockConflictSubTasks('修改 trade 模块');

    brain.registerPlan({
      taskId: 'task-lock-test',
      chatId,
      description: '修改 trade 模块',
      subTasks,
      phase: 'awaiting_approval',
      createdAt: new Date().toISOString(),
      summary: 'conflict demo',
    });

    const result = await brain.approveAndExecute(chatId);
    const outputs = new Map(result.subTaskOutputs.map((o) => [o.subTaskId, o.output]));

    expect(outputs.get('st-2a')).toBeDefined();
    expect(outputs.get('st-2b')).toContain('文件锁冲突');
    expect(result.success).toBe(false);
  });
});
