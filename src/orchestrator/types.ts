export const TASK_STATUSES = [
  'pending',
  'planning',
  'ready',
  'executing',
  'reviewing',
  'completed',
  'failed',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const SUB_TASK_STATUSES = [
  'pending',
  'assigned',
  'executing',
  'completed',
  'failed',
] as const;
export type SubTaskStatus = (typeof SUB_TASK_STATUSES)[number];

export interface SubTaskRecord {
  readonly id: string;
  readonly description: string;
  readonly status: SubTaskStatus;
  readonly assignedAgentId?: string;
  readonly output?: string;
}

export interface TaskRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly description: string;
  readonly status: TaskStatus;
  readonly subTasks: ReadonlyArray<SubTaskRecord>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SubTaskPlanInput {
  readonly id: string;
  readonly description: string;
}
