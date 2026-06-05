export const HELP_TEXT = [
  "🧠 Dev Brain 指令",
  "",
  "直接发消息 — 创建任务计划（卡片按钮或 /approve 后执行）",
  "计划卡片 — 点击「批准执行」或发送 /approve",
  "/status  — 查看 Brain 状态",
  "/cancel  — 取消待审批任务",
  "/show <taskId> [--subtask <id>]  — 渲染 postmortem",
  "/retry <taskId>  — 重试失败子任务",
  "/list  — 列出最近任务",
  "/help    — 显示本帮助",
].join("\n");

export type IntentType =
  | "help"
  | "status"
  | "approve"
  | "cancel"
  | "create_task"
  | "show"
  | "retry"
  | "list"
  | "unknown";

export interface ParsedIntent {
  readonly type: IntentType;
  readonly rawText: string;
  /** 提取的 taskId 子串（若有） */
  readonly arg?: string;
  /** 提取的子任务 ID（/show --subtask xxx） */
  readonly subTaskArg?: string;
  /** unknown 时携带原文便于回 /help 提示 */
  readonly unknownCommand?: string;
}

const COMMAND_REGEX = /^\/(\w+)(?:\s+(.*))?$/;

function stripMention(text: string): string {
  return text.replace(/^@\S+\s+/, "").trim();
}

function parseArgs(rest: string | undefined): {
  taskArg?: string;
  subTaskArg?: string;
} {
  if (!rest) return {};
  const tokens = rest.trim().split(/\s+/);
  const taskArg = tokens[0];
  const flagIdx = tokens.findIndex((t) => t === "--subtask" || t === "-s");
  const subTaskArg = flagIdx >= 0 ? tokens[flagIdx + 1] : undefined;
  return { taskArg, subTaskArg };
}

export function parseIntent(text: string): ParsedIntent {
  const stripped = stripMention(text);
  if (!stripped) {
    return { type: "unknown", rawText: text };
  }
  const match = stripped.match(COMMAND_REGEX);
  if (!match) {
    return { type: "create_task", rawText: stripped };
  }
  const cmd = (match[1] ?? "").toLowerCase();
  const rest = match[2] ?? "";
  const args = parseArgs(rest);

  switch (cmd) {
    case "help":
      return { type: "help", rawText: stripped };
    case "status":
      return { type: "status", rawText: stripped };
    case "approve":
      return {
        type: "approve",
        rawText: stripped,
        ...(args.taskArg ? { arg: args.taskArg } : {}),
      };
    case "cancel":
      return {
        type: "cancel",
        rawText: stripped,
        ...(args.taskArg ? { arg: args.taskArg } : {}),
      };
    case "show":
      return {
        type: "show",
        rawText: stripped,
        ...(args.taskArg ? { arg: args.taskArg } : {}),
        ...(args.subTaskArg ? { subTaskArg: args.subTaskArg } : {}),
      };
    case "retry":
      return {
        type: "retry",
        rawText: stripped,
        ...(args.taskArg ? { arg: args.taskArg } : {}),
      };
    case "list":
      return { type: "list", rawText: stripped };
    default:
      return { type: "unknown", rawText: stripped, unknownCommand: cmd };
  }
}
