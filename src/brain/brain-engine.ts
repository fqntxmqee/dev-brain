import type { DevBrainConfig } from "../config/env.js";
import { AdapterRegistry, collectAdapterOutput } from "../adapters/index.js";
import type { CcConnectClient } from "../adapters/cc-connect-client.js";
import type {
  BrainStatusSnapshot,
  BrainTaskPlan,
  BrainTaskResult,
  ExecutionProgress,
  FeishuInboundMessage,
  PlannedSubTask,
  SubTaskProgress,
} from "../core/types.js";
import {
  MAX_DESC_LEN,
  MAX_OUTPUT_LEN,
  SHORT_ID_LEN,
} from "../core/constants.js";
import { FileLockManager, LockConflictError } from "../governance/index.js";
import type { FileLock } from "../governance/types.js";
import { computeExecutionTiers } from "../orchestrator/dag-scheduler.js";
import { TaskOrchestrator } from "../orchestrator/index.js";
import {
  buildDefaultSubTasks,
  formatPlanSummary,
  newTaskId,
} from "./task-planner.js";

export interface BrainEngineDeps {
  readonly config: DevBrainConfig;
  readonly adapters: AdapterRegistry;
  readonly orchestrator: TaskOrchestrator;
  readonly fileLocks?: FileLockManager;
}

export type ProgressCallback = (
  progress: ExecutionProgress,
) => void | Promise<void>;

export class BrainEngine {
  private readonly pendingByChat = new Map<string, BrainTaskPlan>();
  private readonly completed: BrainTaskResult[] = [];
  private activeCount = 0;
  private readonly fileLocks: FileLockManager;

  constructor(private readonly deps: BrainEngineDeps) {
    this.fileLocks = deps.fileLocks ?? new FileLockManager();
  }

  createPlan(message: FeishuInboundMessage): BrainTaskPlan {
    const subTasks = buildDefaultSubTasks(message.text);
    const taskId = newTaskId();
    const plan: BrainTaskPlan = {
      taskId,
      chatId: message.chatId,
      description: message.text.trim(),
      subTasks,
      phase: "awaiting_approval",
      createdAt: new Date().toISOString(),
      summary: formatPlanSummary(message.text.trim(), subTasks),
    };
    this.pendingByChat.set(message.chatId, plan);
    return plan;
  }

  /** 注入自定义计划（测试 / 冲突演示） */
  registerPlan(plan: BrainTaskPlan): void {
    this.pendingByChat.set(plan.chatId, plan);
  }

  getPendingPlan(chatId: string): BrainTaskPlan | undefined {
    return this.pendingByChat.get(chatId);
  }

  cancelPlan(chatId: string): boolean {
    const plan = this.pendingByChat.get(chatId);
    if (!plan) return false;
    this.pendingByChat.delete(chatId);
    return true;
  }

  async approveAndExecute(
    chatId: string,
    onProgress?: ProgressCallback,
    expectedTaskId?: string,
  ): Promise<BrainTaskResult> {
    const plan = this.pendingByChat.get(chatId);
    if (!plan) {
      throw new Error("当前会话没有待审批的任务，请先发送需求描述。");
    }
    if (expectedTaskId && plan.taskId !== expectedTaskId) {
      throw new Error("任务 ID 不匹配，请重新创建计划。");
    }

    this.pendingByChat.delete(chatId);
    this.activeCount += 1;

    const task = this.deps.orchestrator.createTask(
      plan.description,
      plan.taskId,
    );
    this.deps.orchestrator.planTask(
      task.id,
      plan.subTasks.map((st) => ({ id: st.id, description: st.description })),
    );
    this.deps.orchestrator.beginExecution(task.id);

    const subTaskOutputs: Array<BrainTaskResult["subTaskOutputs"][number]> = [];
    const progressState = new Map<string, SubTaskProgress>(
      plan.subTasks.map((st) => [
        st.id,
        { id: st.id, runtime: st.runtime, status: "pending" },
      ]),
    );

    const emitProgress = async (): Promise<void> => {
      if (!onProgress) return;
      await onProgress({
        taskId: plan.taskId,
        description: plan.description,
        subTasks: [...progressState.values()],
      });
    };

    await emitProgress();

    try {
      const tiers = computeExecutionTiers(plan.subTasks);

      for (const tier of tiers) {
        const tierResults = await Promise.all(
          tier.map((subTask) =>
            this.executeSubTask(
              plan,
              task.id,
              subTask,
              progressState,
              emitProgress,
            ),
          ),
        );
        subTaskOutputs.push(...tierResults.filter((r) => r !== undefined));
      }

      const hasFailure = [...progressState.values()].some(
        (st) => st.status === "failed" || st.status === "blocked",
      );
      if (hasFailure) {
        this.deps.orchestrator.failTask(task.id);
        const result: BrainTaskResult = {
          taskId: plan.taskId,
          success: false,
          summary: formatExecutionSummary(plan, subTaskOutputs, progressState),
          subTaskOutputs,
        };
        this.completed.push(result);
        return result;
      }

      this.deps.orchestrator.completeTask(task.id);

      const result: BrainTaskResult = {
        taskId: plan.taskId,
        success: true,
        summary: formatExecutionSummary(plan, subTaskOutputs, progressState),
        subTaskOutputs,
      };
      this.completed.push(result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.orchestrator.failTask(task.id);
      const result: BrainTaskResult = {
        taskId: plan.taskId,
        success: false,
        summary: `❌ 任务失败：${message}`,
        subTaskOutputs,
      };
      this.completed.push(result);
      return result;
    } finally {
      this.activeCount = Math.max(0, this.activeCount - 1);
    }
  }

  private async executeSubTask(
    plan: BrainTaskPlan,
    orchestratorTaskId: string,
    subTask: PlannedSubTask,
    progressState: Map<string, SubTaskProgress>,
    emitProgress: () => Promise<void>,
  ): Promise<BrainTaskResult["subTaskOutputs"][number] | undefined> {
    const agentId = `adapter:${subTask.runtime}:${subTask.id}`;
    const acquiredLocks: FileLock[] = [];

    const setStatus = async (
      status: SubTaskProgress["status"],
      detail?: string,
    ): Promise<void> => {
      progressState.set(subTask.id, {
        id: subTask.id,
        runtime: subTask.runtime,
        status,
        ...(detail !== undefined ? { detail } : {}),
      });
      await emitProgress();
    };

    try {
      for (const filePath of subTask.requiredFiles) {
        if (subTask.lockMode === "none") continue;
        acquiredLocks.push(
          this.fileLocks.acquire(agentId, filePath, subTask.lockMode),
        );
      }
    } catch (error) {
      if (error instanceof LockConflictError) {
        await setStatus(
          "blocked",
          `文件锁冲突：${error.filePath} 被 ${error.holderAgentId} 占用`,
        );
        this.deps.orchestrator.updateSubTaskStatus(
          orchestratorTaskId,
          subTask.id,
          "failed",
          {
            assignedAgentId: agentId,
            output: `blocked: ${error.message}`,
          },
        );
        return {
          subTaskId: subTask.id,
          runtime: subTask.runtime,
          output: `⛔ 文件锁冲突，已跳过：${error.filePath}`,
        };
      }
      throw error;
    }

    try {
      await setStatus("assigned");
      this.deps.orchestrator.updateSubTaskStatus(
        orchestratorTaskId,
        subTask.id,
        "assigned",
        {
          assignedAgentId: agentId,
        },
      );

      await setStatus("executing");
      this.deps.orchestrator.updateSubTaskStatus(
        orchestratorTaskId,
        subTask.id,
        "executing",
      );

      const adapter = this.deps.adapters.get(subTask.runtime);
      const output = await collectAdapterOutput(adapter, {
        prompt: subTask.description,
        workDir: this.deps.config.workDir,
        sessionKey: `${plan.taskId}:${subTask.id}`,
      });

      this.deps.orchestrator.updateSubTaskStatus(
        orchestratorTaskId,
        subTask.id,
        "completed",
        { output },
      );
      await setStatus("completed");

      return {
        subTaskId: subTask.id,
        runtime: subTask.runtime,
        output,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.orchestrator.updateSubTaskStatus(
        orchestratorTaskId,
        subTask.id,
        "failed",
        {
          output: message,
        },
      );
      await setStatus("failed", message);
      return {
        subTaskId: subTask.id,
        runtime: subTask.runtime,
        output: `❌ ${message}`,
      };
    } finally {
      for (const lock of acquiredLocks) {
        this.fileLocks.releaseLock(lock);
      }
    }
  }

  getStatus(): BrainStatusSnapshot {
    return {
      pendingApprovals: this.pendingByChat.size,
      activeTasks: this.activeCount,
      completedTasks: this.completed.length,
    };
  }

  formatStatusText(): string {
    const s = this.getStatus();
    const locked = [...this.fileLocks.getLockedFilePaths()];
    return [
      "🧠 Dev Brain 状态",
      `- 待审批：${s.pendingApprovals}`,
      `- 执行中：${s.activeTasks}`,
      `- 已完成：${s.completedTasks}`,
      `- 可用 Runtime：${this.deps.adapters.list().join(", ")}`,
      `- 文件锁：${locked.length ? locked.join(", ") : "(none)"}`,
    ].join("\n");
  }
}

function formatExecutionSummary(
  plan: BrainTaskPlan,
  outputs: BrainTaskResult["subTaskOutputs"],
  progressState: Map<string, SubTaskProgress>,
): string {
  const blocked = [...progressState.values()].filter(
    (st) => st.status === "blocked",
  );
  const lines = outputs.map(
    (o) =>
      `${o.subTaskId} [${o.runtime}]: ${o.output.slice(0, MAX_OUTPUT_LEN)}`,
  );
  const header = blocked.length > 0 ? "⚠️ 任务部分完成" : "✅ 任务完成";
  return [
    `${header} #${plan.taskId.slice(0, SHORT_ID_LEN)}`,
    ``,
    `需求：${plan.description.slice(0, MAX_DESC_LEN)}`,
    ...(blocked.length
      ? [
          "",
          "文件锁阻止：",
          ...blocked.map((b) => `- ${b.id}: ${b.detail ?? "conflict"}`),
        ]
      : []),
    ``,
    ...lines,
  ].join("\n");
}

export function createBrainEngine(
  config: DevBrainConfig,
  client?: CcConnectClient,
): BrainEngine {
  const adapters = new AdapterRegistry(config, client);
  const orchestrator = new TaskOrchestrator();
  return new BrainEngine({ config, adapters, orchestrator });
}
