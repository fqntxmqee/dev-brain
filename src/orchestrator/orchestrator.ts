import { v4 as uuid } from 'uuid';
import type { SubTaskPlanInput, SubTaskRecord, TaskRecord, TaskStatus } from './types.js';

/** dev-brain 内置轻量编排器，不依赖外部 multi-agent 项目 */
export class TaskOrchestrator {
  private readonly tasks = new Map<string, TaskRecord>();

  createTask(description: string, sessionId: string): TaskRecord {
    const now = new Date().toISOString();
    const task: TaskRecord = {
      id: uuid(),
      sessionId,
      description,
      status: 'pending',
      subTasks: [],
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  planTask(taskId: string, subTasks: ReadonlyArray<SubTaskPlanInput>): TaskRecord {
    const task = this.getTask(taskId);
    const now = new Date().toISOString();
    const planned: TaskRecord = {
      ...task,
      status: 'ready',
      subTasks: subTasks.map((st) => ({
        id: st.id,
        description: st.description,
        status: 'pending',
      })),
      updatedAt: now,
    };
    this.tasks.set(taskId, planned);
    return planned;
  }

  beginExecution(taskId: string): TaskRecord {
    return this.setTaskStatus(taskId, 'executing');
  }

  updateSubTaskStatus(
    taskId: string,
    subTaskId: string,
    status: SubTaskRecord['status'],
    options?: { assignedAgentId?: string; output?: string },
  ): TaskRecord {
    const task = this.getTask(taskId);
    const subTasks = task.subTasks.map((st) => {
      if (st.id !== subTaskId) return st;
      return {
        ...st,
        status,
        ...(options?.assignedAgentId !== undefined ? { assignedAgentId: options.assignedAgentId } : {}),
        ...(options?.output !== undefined ? { output: options.output } : {}),
      };
    });
    const updated: TaskRecord = { ...task, subTasks, updatedAt: new Date().toISOString() };
    this.tasks.set(taskId, updated);
    return updated;
  }

  completeTask(taskId: string): TaskRecord {
    return this.setTaskStatus(taskId, 'completed');
  }

  failTask(taskId: string): TaskRecord {
    return this.setTaskStatus(taskId, 'failed');
  }

  getTask(taskId: string): TaskRecord {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return task;
  }

  private setTaskStatus(taskId: string, status: TaskStatus): TaskRecord {
    const task = this.getTask(taskId);
    const updated: TaskRecord = { ...task, status, updatedAt: new Date().toISOString() };
    this.tasks.set(taskId, updated);
    return updated;
  }
}
