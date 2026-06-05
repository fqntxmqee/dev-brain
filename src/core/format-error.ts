import { DevBrainError } from "./errors.js";
import { redactMessage } from "./redact.js";

/** 错误文案出口（CAP-ERR-03 / T-54） */
export type ErrorAudience = "feishu" | "cli" | "log";

const ERROR_EMOJI: Record<string, string> = {
  UNAUTHORIZED: "⛔",
  CONFIG_ERROR: "🔑",
  ADAPTER_ERROR: "❌",
  PROTOCOL_ERROR: "🛑",
  GATEWAY_ERROR: "🌐",
  PLAN_ERROR: "📋",
  AUTH_ERROR: "⛔",
  REPLY_TOO_LONG: "📏",
  MESSAGE_TOO_LONG: "📏",
  LOCK_CONFLICT: "🔒",
  TASK_NOT_FOUND: "🔍",
  TASK_QUEUE_FULL: "🚦",
  BRIDGE_TIMEOUT: "⏱",
  BRIDGE_PROTOCOL: "🛑",
  CREDENTIAL_EXPIRED: "🔑",
};

const NEXT_STEP_HINTS: Record<string, string> = {
  UNAUTHORIZED: "设置 DEV_BRAIN_ALLOW_FROM=<你的 open_id>（测试期可设 *=*）",
  CONFIG_ERROR: "运行 `dev-brain doctor` 查看详情",
  ADAPTER_ERROR: "查看 stderr 日志；检查 cc-connect daemon 状态",
  PROTOCOL_ERROR: "升级 cc-connect 客户端；检查网络",
  GATEWAY_ERROR: "重启 `dev-brain start`",
  PLAN_ERROR: "重新 /cancel 再发新需求",
  AUTH_ERROR: "更新 .env 飞书凭证",
  REPLY_TOO_LONG: "拆为多条或缩为 <16KB",
  MESSAGE_TOO_LONG: "拆为多条或缩为 <4KB",
  LOCK_CONFLICT: "等占用方释放，或 /cancel 重排",
  TASK_NOT_FOUND: "确认 taskId；/list 查看最近任务",
  TASK_QUEUE_FULL: "先 /cancel 旧任务再发新需求",
  BRIDGE_TIMEOUT: "检查 cc-connect daemon；/doctor 看 bridge 状态",
  BRIDGE_PROTOCOL: "升级 cc-connect 至最新",
  CREDENTIAL_EXPIRED:
    "登录 https://open.feishu.cn/app 轮换 App Secret 后更新 .env",
};

function codeOf(err: DevBrainError): string {
  return err.code || err.name;
}

function emojiOf(err: DevBrainError): string {
  return ERROR_EMOJI[codeOf(err)] ?? "❌";
}

function nextStepOf(err: DevBrainError): string | undefined {
  return NEXT_STEP_HINTS[codeOf(err)];
}

function safeMsg(err: DevBrainError): string {
  return err.safeMessage || err.message;
}

/**
 * 统一错误文案生成器（CAP-ERR-03 / T-54）。
 * 同一 DevBrainError 子类在三处显示文案一致。
 */
export function formatError(
  err: DevBrainError,
  audience: ErrorAudience,
): string {
  const code = codeOf(err);
  const emoji = emojiOf(err);
  const msg = safeMsg(err);
  const hint = nextStepOf(err);

  switch (audience) {
    case "feishu":
      return `${emoji} [${code}] ${msg}`;
    case "cli":
      return `${emoji} [${code}] ${msg}${hint ? `\n💡 ${hint}` : ""}`;
    case "log": {
      const cause =
        err.cause !== undefined
          ? ` cause=${err.cause instanceof Error ? err.cause.message : String(err.cause)}`
          : "";
      return `event=error code=${code} msg="${redactMessage(msg)}"${cause}`;
    }
  }
}
