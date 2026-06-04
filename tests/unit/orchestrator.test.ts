import { describe, expect, it } from 'vitest';
import { TaskOrchestrator } from '../../src/orchestrator/orchestrator.js';

describe('TaskOrchestrator', () => {
  it('should_track_subtask_lifecycle', () => {
    const orch = new TaskOrchestrator();
    const task = orch.createTask('demo', 'session-1');
    orch.planTask(task.id, [{ id: 'st-1', description: 'step one' }]);
    orch.beginExecution(task.id);
    orch.updateSubTaskStatus(task.id, 'st-1', 'executing');
    orch.updateSubTaskStatus(task.id, 'st-1', 'completed', { output: 'ok' });
    const done = orch.completeTask(task.id);

    expect(done.status).toBe('completed');
    expect(done.subTasks[0]?.output).toBe('ok');
  });
});
