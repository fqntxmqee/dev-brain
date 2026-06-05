import type { DevBrainConfig } from "../config/env.js";
import { isSenderAllowed as checkSender } from "../config/env.js";
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

export interface FeishuGatewayDeps {
  readonly config: DevBrainConfig;
  readonly brain: BrainEngine;
  readonly reporter: FeishuReporter;
  readonly log?: (line: string) => void;
}

export class FeishuGateway {
  constructor(private readonly deps: FeishuGatewayDeps) {}

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

    if (!checkSender(this.deps.config, message.senderOpenId)) {
      await this.sendText(message, "⛔ 无权限使用 Dev Brain。");
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
    ["event", "+subscribe", "--format", "compact"],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  if (!child.stdout) {
    throw new Error("lark-cli event stdout unavailable");
  }

  const rl = createInterface({ input: child.stdout });

  rl.on("line", (line) => {
    onLine(line);
    const event = parseFeishuInboundEvent(line);
    if (!event) return;

    if (event.kind === "message") {
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
