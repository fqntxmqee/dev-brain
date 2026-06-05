export const AGENT_RUNTIMES = ["claude-code", "codex", "cursor"] as const;
export type AgentRuntime = (typeof AGENT_RUNTIMES)[number];

export const TASK_PHASES = [
  "draft",
  "awaiting_approval",
  "executing",
  "completed",
  "failed",
  "cancelled",
] as const;
export type TaskPhase = (typeof TASK_PHASES)[number];

export const LOCK_MODES = ["none", "read", "write"] as const;
export type LockMode = (typeof LOCK_MODES)[number];

export interface PlannedSubTask {
  readonly id: string;
  readonly description: string;
  readonly runtime: AgentRuntime;
  readonly requiredFiles: ReadonlyArray<string>;
  readonly dependsOn: ReadonlyArray<string>;
  readonly lockMode: LockMode;
}

export interface SubTaskProgress {
  readonly id: string;
  readonly runtime: AgentRuntime;
  readonly status:
    | "pending"
    | "assigned"
    | "executing"
    | "completed"
    | "failed"
    | "blocked";
  readonly detail?: string;
}

export interface ExecutionProgress {
  readonly taskId: string;
  readonly description: string;
  readonly subTasks: ReadonlyArray<SubTaskProgress>;
}

export interface BrainTaskPlan {
  readonly taskId: string;
  readonly chatId: string;
  readonly description: string;
  readonly subTasks: ReadonlyArray<PlannedSubTask>;
  readonly phase: TaskPhase;
  readonly createdAt: string;
  readonly summary: string;
}

export interface BrainTaskResult {
  readonly taskId: string;
  readonly success: boolean;
  readonly summary: string;
  readonly subTaskOutputs: ReadonlyArray<{
    readonly subTaskId: string;
    readonly runtime: AgentRuntime;
    readonly output: string;
  }>;
}

/**
 * 平台无关的入站消息（T-33 / CAP-GW-01）。
 * 飞书 / Slack / 钉钉的 gateway 适配层都构造此结构交给 BrainEngine。
 */
export interface InboundMessage {
  readonly messageId: string;
  readonly chatId: string;
  readonly senderOpenId: string;
  readonly senderName?: string;
  readonly text: string;
}

/** @deprecated use InboundMessage — 保留别名以兼容旧 import */
export type FeishuInboundMessage = InboundMessage;

export type CardActionType = "approve" | "cancel";

export interface FeishuCardAction {
  readonly action: CardActionType;
  readonly chatId: string;
  readonly taskId: string;
  readonly operatorOpenId: string;
  readonly operatorName: string;
}

export type FeishuInboundEvent =
  | { readonly kind: "message"; readonly message: InboundMessage }
  | { readonly kind: "card_action"; readonly action: FeishuCardAction };

export interface BrainStatusSnapshot {
  readonly pendingApprovals: number;
  readonly activeTasks: number;
  readonly completedTasks: number;
}
