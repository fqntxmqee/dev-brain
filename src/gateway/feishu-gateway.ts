import type { DevBrainConfig } from "../config/env.js";
import { isSenderAllowed as checkSender } from "../config/env.js";
import { MAX_PROMPT_BYTES } from "../core/constants.js";
import { defaultLogger, type Logger } from "../core/logger.js";
import { redactMessage } from "../core/redact.js";
import { getMetrics, safe } from "../observability/metrics.js";
import type { BrainEngine } from "../brain/brain-engine.js";
import type {
  BrainTaskPlan,
  FeishuCardAction,
  FeishuInboundMessage,
} from "../core/types.js";
import {
  buildPlanCard,
  buildProgressCard,
  buildSummaryCard,
} from "./feishu-cards.js";
import {
  parseFeishuInboundEvent,
  parseFeishuMessageEvent,
} from "./feishu-events.js";
import { parseIntent } from "./intent-parser.js";
import { HELP_TEXT } from "./intent-parser.js";
import type { FeishuReporter } from "./feishu-reporter.js";
import { formatInboundLog, supportsCards } from "./feishu-reporter.js";
import { computeExecutionTiers } from "../orchestrator/dag-scheduler.js";

export interface FeishuGatewayDeps {
  readonly config: DevBrainConfig;
  readonly brain: BrainEngine;
  readonly reporter: FeishuReporter;
  readonly log?: (line: string) => void;
  /** v0.7.0: 可选；不传则用 defaultLogger */
  readonly logger?: Logger;
}

export class FeishuGateway {
  private readonly logger: Logger;
  private readonly metrics = getMetrics();

  constructor(private readonly deps: FeishuGatewayDeps) {
    this.logger = deps.logger ?? defaultLogger.child({ component: "gateway" });
  }

  private get useCards(): boolean {
    return this.deps.config.feishuCards && supportsCards(this.deps.reporter);
  }

  private get useCardActions(): boolean {
    return this.useCards && this.deps.config.feishuCardActions;
  }

  async handleCardAction(action: FeishuCardAction): Promise<void> {
    const log = this.deps.log ?? (() => undefined);
    log(
      `[feishu:card] ${action.operatorName}@${action.chatId}: ${action.action}`,
    );
    safe(() => this.metrics.inc("gateway.card.action"), undefined);
    this.logger.info("card action received", {
      action: action.action,
      chat_id: action.chatId,
      task_id: action.taskId,
      operator: redactMessage(action.operatorOpenId).slice(0, 12),
    });

    if (!checkSender(this.deps.config, action.operatorOpenId)) {
      await this.sendTextToChat(action.chatId, "⛔ 无权限使用 Dev Brain。");
      return;
    }

    const pending = this.deps.brain.getPendingPlan(action.chatId);
    if (!pending || pending.taskId !== action.taskId) {
      await this.sendTextToChat(action.chatId, "当前没有匹配的待审批任务。");
      return;
    }

    if (action.action === "cancel") {
      const cancelled = this.deps.brain.cancelPlan(action.chatId);
      await this.sendTextToChat(
        action.chatId,
        cancelled ? "已取消待审批任务。" : "当前没有待审批任务。",
      );
      return;
    }

    const result = await this.deps.brain.approveAndExecute(
      action.chatId,
      async (progress) => {
        if (!this.useCards) return;
        await this.sendCard(action.chatId, buildProgressCard(progress));
      },
      action.taskId,
    );

    if (this.useCards) {
      await this.sendCard(
        action.chatId,
        buildSummaryCard(result, pending.description),
      );
    }
    await this.sendTextToChat(action.chatId, result.summary);
  }

  async handleMessage(message: FeishuInboundMessage): Promise<void> {
    const log = this.deps.log ?? (() => undefined);
    log(formatInboundLog(message));
    safe(() => this.metrics.inc("gateway.messages.received"), undefined);
    const endTimer = safe(
      () =>
        this.metrics.histogram("gateway.message.duration_seconds").startTimer(),
      () => 0,
    );
    const reqLog = this.logger.child({
      request_id: message.messageId,
      chat_id: message.chatId,
      sender: redactMessage(message.senderOpenId).slice(0, 12),
    });
    reqLog.info("message received", {
      prompt: redactMessage(message.text ?? "").slice(0, 120),
    });

    try {
      if (!checkSender(this.deps.config, message.senderOpenId)) {
        await this.sendText(message, "⛔ 无权限使用 Dev Brain。");
        return;
      }

      // T-66: prompt 4KB 上限（UTF-8 字节）
      const promptBytes = Buffer.byteLength(message.text ?? "", "utf8");
      if (promptBytes > MAX_PROMPT_BYTES) {
        safe(
          () => this.metrics.inc("gateway.messages.rejected_oversize"),
          undefined,
        );
        await this.sendText(
          message,
          `⛔ 消息超过 ${MAX_PROMPT_BYTES} 字节上限（当前 ${promptBytes}）。请精简后重发。`,
        );
        return;
      }

      const intent = parseIntent(message.text);
      let replyText: string;
      let planForCard: BrainTaskPlan | undefined;

      switch (intent.type) {
        case "help":
          replyText = HELP_TEXT;
          break;
        case "status":
          replyText = this.deps.brain.formatStatusText();
          break;
        case "cancel": {
          const cancelled = this.deps.brain.cancelPlan(message.chatId);
          replyText = cancelled ? "已取消待审批任务。" : "当前没有待审批任务。";
          break;
        }
        case "show":
          replyText = `📋 任务详情：暂未实现（taskId=${intent.arg ?? "(未指定)"}）`;
          break;
        case "retry":
          replyText = `🔁 重试任务：暂未实现（taskId=${intent.arg ?? "(未指定)"}）`;
          break;
        case "list":
          replyText = "📜 任务列表：暂未实现";
          break;
        case "unknown":
          replyText = `未知指令：/${intent.unknownCommand ?? "?"}。回复 /help 查看支持指令`;
          break;
        case "approve": {
          const pending = this.deps.brain.getPendingPlan(message.chatId);
          const description = pending?.description ?? "";

          const result = await this.deps.brain.approveAndExecute(
            message.chatId,
            async (progress) => {
              if (!this.useCards) return;
              await this.sendCard(
                message.chatId,
                buildProgressCard(progress),
                message.messageId,
              );
            },
          );

          replyText = result.summary;
          if (this.useCards) {
            await this.sendCard(
              message.chatId,
              buildSummaryCard(result, description),
              message.messageId,
            );
          }
          break;
        }
        case "create_task": {
          const plan = this.deps.brain.createPlan(message);
          replyText = plan.summary;
          planForCard = plan;
          // T-69: card 渲染时附带 DAG 视图（tier 分层）— 后续可注入 buildPlanCard
          void computeExecutionTiers(plan.subTasks);
          break;
        }
      }

      if (planForCard && this.useCards) {
        await this.sendCard(
          message.chatId,
          buildPlanCard(planForCard, { withActions: this.useCardActions }),
          message.messageId,
        );
      }

      await this.sendText(message, replyText);
    } catch (err) {
      reqLog.error("message failed", {
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      endTimer();
    }
  }

  private async sendText(
    message: FeishuInboundMessage,
    text: string,
  ): Promise<void> {
    await this.deps.reporter.sendText({
      chatId: message.chatId,
      text,
      replyToMessageId: message.messageId,
    });
  }

  private async sendTextToChat(chatId: string, text: string): Promise<void> {
    await this.deps.reporter.sendText({ chatId, text });
  }

  private async sendCard(
    chatId: string,
    card: ReturnType<typeof buildPlanCard>,
    replyToMessageId?: string,
  ): Promise<void> {
    if (!supportsCards(this.deps.reporter)) return;
    await this.deps.reporter.sendCard({ chatId, card, replyToMessageId });
  }
}

export {
  parseFeishuInboundEvent,
  parseFeishuMessageEvent,
  parseFeishuCardActionEvent,
} from "./feishu-events.js";

/** @deprecated use parseFeishuMessageEvent */
export function parseFeishuEventLine(line: string) {
  return parseFeishuMessageEvent(line);
}

/** Phase 2+: 订阅 lark-cli event NDJSON 流（消息 + 卡片回调） */
export async function runFeishuEventLoop(
  gateway: FeishuGateway,
  onLine: (line: string) => void = () => undefined,
): Promise<never> {
  const { spawn } = await import("node:child_process");
  const { createInterface } = await import("node:readline");

  const child = spawn(
    "lark-cli",
    ["event", "+subscribe", "--compact", "--profile", "dev-brain"],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  if (!child.stdout) {
    throw new Error("lark-cli event stdout unavailable");
  }

  // lark-cli 启动错误 / 立即 exit 必须捕获，否则 daemon 静默挂掉
  child.on("error", (err) => {
    process.stderr.write(`lark-cli spawn error: ${err.message}\n`);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`lark-cli stderr: ${chunk.toString("utf8")}\n`);
  });
  child.on("close", (code) => {
    process.stderr.write(`lark-cli exited with code ${code}\n`);
  });

  const rl = createInterface({ input: child.stdout });

  rl.on("line", (line) => {
    onLine(line);
    const event = parseFeishuInboundEvent(line);
    if (!event) {
      // 调试: 解析失败的原始行（打印完整结构便于诊断 format 不匹配）
      process.stderr.write(`gateway: unparsed line (full): ${line}\n`);
      return;
    }

    if (event.kind === "message") {
      process.stderr.write(
        `gateway: message from ${event.message.senderOpenId}: ${event.message.text.slice(0, 80)}\n`,
      );
      void gateway.handleMessage(event.message).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`gateway error: ${msg}\n`);
      });
      return;
    }

    void gateway.handleCardAction(event.action).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`gateway card error: ${msg}\n`);
    });
  });

  return new Promise<never>(() => {
    // long-running
  });
}
