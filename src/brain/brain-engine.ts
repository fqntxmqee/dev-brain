import type { DevBrainConfig } from "../config/env.js";
import { AdapterRegistry, collectAdapterOutput } from "../adapters/index.js";
import type { CcConnectClient } from "../adapters/cc-connect/index.js";
import type {
  BrainStatusSnapshot,
  BrainTaskPlan,
  BrainTaskResult,
  ExecutionProgress,
  FeishuInboundMessage,
  PlannedSubTask,
  SubTaskProgress,
} from "../core/types.js";
import { MAX_DESC_LEN, MAX_OUTPUT_LEN } from "../core/constants.js";
import { FileLockManager, LockConflictError } from "../governance/index.js";
import type { FileLock } from "../governance/types.js";
import { computeExecutionTiers } from "../orchestrator/dag-scheduler.js";
import { TaskOrchestrator } from "../orchestrator/index.js";
import { PostmortemStore } from "./postmortem-store.js";
import { RETRY_MAX } from "../core/constants.js";
import {
  buildDefaultSubTasks,
  buildSessionKey,
  formatPlanSummary,
  newTaskId,
  shortTaskId,
} from "./task-planner.js";

export interface BrainEngineDeps {
  readonly config: DevBrainConfig;
  readonly adapters: AdapterRegistry;
  readonly orchestrator: TaskOrchestrator;
  readonly fileLocks?: FileLockManager;
  /** T-62/T-65: 可选；不传则不落盘（测试/CLI 子命令常用） */
  readonly postmortemStore?: PostmortemStore;
}

export type ProgressCallback = (
  progress: ExecutionProgress,
) => void | Promise<void>;

export class BrainEngine {
  private readonly pendingByChat = new Map<string, BrainTaskPlan>();
  private readonly completed: BrainTaskResult[] = [];
  private activeCount = 0;
  /** 正在执行的任务（T-50）：记录 taskId/chatId/进度便于 /progress 查询 */
  private readonly activeTasks = new Map<
    string,
    {
      taskId: string;
      chatId: string;
      description: string;
      subTasks: ReadonlyArray<SubTaskProgress>;
    }
  >();
  /** T-61: 同一 chat 重复创建 plan 的覆盖次数 */
  private overwriteCount = 0;
  private readonly fileLocks: FileLockManager;
  private readonly postmortemStore: PostmortemStore | undefined;

  constructor(private readonly deps: BrainEngineDeps) {
    this.fileLocks = deps.fileLocks ?? new FileLockManager();
    this.postmortemStore = deps.postmortemStore;
  }

  createPlan(message: FeishuInboundMessage): BrainTaskPlan {
    // T-61: 同一 chat 已有待审批计划时，标注被覆盖的旧 plan（不静默丢失）
    const existing = this.pendingByChat.get(message.chatId);
    if (existing) {
      this.recordOverwriteWarning(message.chatId, existing.taskId);
    }
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

  /** T-61: 覆盖事件计数 + 旧 plan 短 ID 输出到 stderr（运维可见） */
  private recordOverwriteWarning(chatId: string, oldTaskId: string): void {
    this.overwriteCount += 1;
    process.stderr.write(
      `[brain:warn] pending plan overwritten for chat=${chatId} ` +
        `(old=${oldTaskId.slice(0, 12)}, new incoming). ` +
        `如需保留旧计划请先 /approve 或 /cancel。\n`,
    );
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

    const subTaskOutputs: Array<BrainTaskResult["subTaskOutputs"][number]> = [];
    const progressState = new Map<string, SubTaskProgress>(
      plan.subTasks.map((st) => [
        st.id,
        { id: st.id, runtime: st.runtime, status: "pending" },
      ]),
    );

    this.activeTasks.set(plan.taskId, {
      taskId: plan.taskId,
      chatId: plan.chatId,
      description: plan.description,
      subTasks: [...progressState.values()],
    });

    const task = this.deps.orchestrator.createTask(
      plan.description,
      plan.taskId,
    );
    this.deps.orchestrator.planTask(
      task.id,
      plan.subTasks.map((st) => ({ id: st.id, description: st.description })),
    );
    this.deps.orchestrator.beginExecution(task.id);

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
        await this.writePostmortem(result).catch(() => undefined);
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
      await this.writePostmortem(result).catch(() => undefined);
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
      await this.writePostmortem(result).catch(() => undefined);
      return result;
    } finally {
      this.activeCount = Math.max(0, this.activeCount - 1);
      this.activeTasks.delete(plan.taskId);
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
      const entry: SubTaskProgress = {
        id: subTask.id,
        runtime: subTask.runtime,
        status,
        ...(detail !== undefined ? { detail } : {}),
      };
      progressState.set(subTask.id, entry);
      // 同步更新活跃任务快照（T-50：/progress 子命令可查）
      const active = this.activeTasks.get(plan.taskId);
      if (active) {
        this.activeTasks.set(plan.taskId, {
          ...active,
          subTasks: active.subTasks.map((s) =>
            s.id === subTask.id ? entry : s,
          ),
        });
      }
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
        sessionKey: buildSessionKey(plan.taskId, subTask.id),
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

  /** T-61: 暴露覆盖次数给 status 文本 */
  getOverwriteCount(): number {
    return this.overwriteCount;
  }

  /** T-62/T-65: 异步落盘 postmortem.json（错误吞掉避免影响主链路） */
  private async writePostmortem(result: BrainTaskResult): Promise<void> {
    if (!this.postmortemStore) return;
    await this.postmortemStore.write(result);
  }

  /** T-64: 重试已完成任务的指定子任务（最多 RETRY_MAX 次） */
  async retrySubTask(
    taskIdOrShort: string,
    subTaskId: string,
  ): Promise<{
    readonly status: "ok" | "not_found" | "max_retries" | "no_plan";
    readonly output?: string;
    readonly error?: string;
  }> {
    const record = this.completed
      .slice()
      .reverse()
      .find(
        (r) => r.taskId === taskIdOrShort || r.taskId.startsWith(taskIdOrShort),
      );
    if (!record) {
      return { status: "not_found", error: `任务不存在: ${taskIdOrShort}` };
    }
    const existing = record.subTaskOutputs.find(
      (o) => o.subTaskId === subTaskId,
    );
    if (!existing) {
      return {
        status: "not_found",
        error: `子任务不存在: ${subTaskId} (task ${record.taskId.slice(0, 12)})`,
      };
    }
    // 限制最大重试次数（T-64 / 防失控）
    const retryCount = (existing as { _retryCount?: number })._retryCount ?? 0;
    if (retryCount >= RETRY_MAX) {
      return {
        status: "max_retries",
        error: `已达最大重试次数 ${RETRY_MAX}`,
      };
    }
    const plan = this.rebuildPlanFromResult(record);
    if (!plan) {
      return { status: "no_plan", error: "无法重建 plan" };
    }
    const subTask = plan.subTasks.find((s) => s.id === subTaskId);
    if (!subTask) {
      return { status: "not_found", error: `子任务不在 plan 中: ${subTaskId}` };
    }
    const progressState = new Map<string, SubTaskProgress>(
      plan.subTasks.map((st) => [
        st.id,
        { id: st.id, runtime: st.runtime, status: "pending" },
      ]),
    );
    // T-64 fix: 注册 retry 上下文到 orchestrator，避免 updateSubTaskStatus 抛
    // "Task not found"。每次重试创建独立 record，便于事后追溯。
    const retryTask = this.deps.orchestrator.createTask(
      `retry:${plan.taskId}`,
      `retry-${Date.now()}`,
    );
    this.deps.orchestrator.planTask(
      retryTask.id,
      plan.subTasks.map((st) => ({ id: st.id, description: st.description })),
    );
    this.deps.orchestrator.beginExecution(retryTask.id);
    const out = await this.executeSubTask(
      plan,
      retryTask.id,
      subTask,
      progressState,
      async () => undefined,
    );
    return out
      ? { status: "ok", output: out.output }
      : { status: "not_found", error: "executeSubTask 返回空" };
  }

  /** T-64: 从历史 result 重建 plan（仅用于重试上下文） */
  private rebuildPlanFromResult(
    result: BrainTaskResult,
  ): BrainTaskPlan | undefined {
    // 简化：description 从 summary 解析（生产场景可读 postmortem.json 重建）
    return {
      taskId: result.taskId,
      chatId: "(retry)",
      description: result.summary,
      subTasks: result.subTaskOutputs.map((o) => ({
        id: o.subTaskId,
        description: o.output,
        runtime: o.runtime as BrainTaskPlan["subTasks"][number]["runtime"],
        requiredFiles: [],
        lockMode: "none" as const,
        dependsOn: [],
      })),
      phase: "executing",
      createdAt: new Date().toISOString(),
      summary: result.summary,
    };
  }

  /** 列出正在执行的任务进度（T-50：/progress 子命令可查） */
  getActiveProgress(): ReadonlyArray<{
    readonly taskId: string;
    readonly chatId: string;
    readonly description: string;
    readonly subTasks: ReadonlyArray<SubTaskProgress>;
  }> {
    return [...this.activeTasks.values()].map((t) => ({
      taskId: t.taskId,
      chatId: t.chatId,
      description: t.description,
      subTasks: [...t.subTasks],
    }));
  }

  /** 列出最近 N 条已完成任务（CLI list 子命令 / T-67） */
  listRecent(limit: number = 10): ReadonlyArray<BrainTaskResult> {
    return this.completed.slice(-limit).reverse();
  }

  /** 找指定 taskId 的完成记录（CLI show / T-67） */
  findCompleted(taskId: string): BrainTaskResult | undefined {
    return [...this.completed]
      .reverse()
      .find((r) => r.taskId === taskId || r.taskId.startsWith(taskId));
  }

  formatStatusText(): string {
    const s = this.getStatus();
    const locked = [...this.fileLocks.getLockedFilePaths()];
    const lines = [
      "🧠 Dev Brain 状态",
      `- 待审批：${s.pendingApprovals}`,
      `- 执行中：${s.activeTasks}`,
      `- 已完成：${s.completedTasks}`,
      `- 可用 Runtime：${this.deps.adapters.list().join(", ")}`,
      `- 文件锁：${locked.length ? locked.join(", ") : "(none)"}`,
    ];
    const active = this.getActiveProgress();
    if (active.length > 0) {
      lines.push("", "— 正在执行 —");
      for (const t of active) {
        const short = shortTaskId(t.taskId);
        const done = t.subTasks.filter((s) => s.status === "completed").length;
        const total = t.subTasks.length;
        const statusLine = t.subTasks
          .map((s) => `${s.id}:${statusEmoji(s.status)}`)
          .join(" ");
        lines.push(
          `#${short}  (${done}/${total})  ${t.description.slice(0, MAX_DESC_LEN)}`,
          `   ${statusLine}`,
        );
      }
    }
    return lines.join("\n");
  }
}

function statusEmoji(status: SubTaskProgress["status"]): string {
  switch (status) {
    case "pending":
      return "⏳";
    case "assigned":
      return "📨";
    case "executing":
      return "🔧";
    case "completed":
      return "✅";
    case "failed":
      return "❌";
    case "blocked":
      return "⛔";
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
    `${header} #${shortTaskId(plan.taskId)}`,
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
  const adapters = AdapterRegistry.create(config, client);
  const orchestrator = new TaskOrchestrator();
  return new BrainEngine({ config, adapters, orchestrator });
}
