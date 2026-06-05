import type { FeishuInboundMessage, InboundMessage } from "../core/types.js";
import { MAX_REPLY_TEXT_BYTES } from "../core/constants.js";
import { getMetrics, safe } from "../observability/metrics.js";
import type { FeishuInteractiveCard } from "./feishu-cards.js";
import { splitTextIntoChunks } from "./text-splitter.js";
import {
  degradeCardForSizeWithFlag,
  degradeCardForSize,
} from "./card-degrader.js";

export interface FeishuReply {
  readonly chatId: string;
  readonly text: string;
  readonly replyToMessageId?: string;
}

export interface FeishuCardReply {
  readonly chatId: string;
  readonly card: FeishuInteractiveCard;
  readonly replyToMessageId?: string;
}

export interface FeishuCardUpdate {
  readonly messageId: string;
  readonly card: FeishuInteractiveCard;
}

export interface FeishuReporter {
  sendText(reply: FeishuReply): Promise<void>;
  /** v0.9.0: 返回新创建卡片的 messageId,Gateway 用此后续 update */
  sendCard?(reply: FeishuCardReply): Promise<string | undefined>;
  /** 进度卡片 update 而非 send（CAP-GW-04 / T-52） */
  updateCard?(update: FeishuCardUpdate): Promise<string | undefined>;
}

/** 飞书单条 text 长度上限（CAP-CLI 16KB / T-43） */
export class ReplyTooLongError extends Error {
  readonly code = "REPLY_TOO_LONG";
  constructor(
    public readonly actualBytes: number,
    public readonly limitBytes: number,
  ) {
    super(`reply text too long: ${actualBytes} > ${limitBytes} bytes`);
  }
}

export function assertReplyTextWithinLimit(
  text: string,
  limitBytes: number = MAX_REPLY_TEXT_BYTES,
): void {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > limitBytes) {
    throw new ReplyTooLongError(bytes, limitBytes);
  }
}

/** CLI / 测试用的内存 Reporter */
export class InMemoryFeishuReporter implements FeishuReporter {
  readonly sent: FeishuReply[] = [];
  readonly cards: FeishuCardReply[] = [];
  readonly updates: FeishuCardUpdate[] = [];
  /** 模拟 messageId 累加器：第 N 次 sendCard 返回 om-1/2/3... */
  private cardSeq = 0;

  async sendText(reply: FeishuReply): Promise<void> {
    const chunks = splitTextIntoChunks(reply.text);
    for (const chunk of chunks) {
      this.sent.push({ ...reply, text: chunk });
    }
  }

  async sendCard(reply: FeishuCardReply): Promise<string | undefined> {
    const degraded = degradeCardForSize(reply.card);
    this.cards.push({ ...reply, card: degraded });
    this.cardSeq += 1;
    return `om-mem-${this.cardSeq}`;
  }

  async updateCard(update: FeishuCardUpdate): Promise<string | undefined> {
    const degraded = degradeCardForSize(update.card);
    this.updates.push({ ...update, card: degraded });
    return update.messageId;
  }
}

async function spawnLarkCli(args: ReadonlyArray<string>): Promise<string> {
  const { spawn } = await import("node:child_process");
  return new Promise<string>((resolve, reject) => {
    const child = spawn("lark-cli", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const tail = stderr.trim().split("\n").slice(-5).join(" | ");
      reject(
        new Error(
          `lark-cli exited with code ${code}: ${tail || "(no stderr)"}`,
        ),
      );
    });
  });
}

/** 从 lark-cli `+messages-send` 返回的 stdout 中提取 message_id。stdout 形如 `{"message_id":"om_xxx",...}` 或 `ok: true` + 字段 */
function parseMessageIdFromStdout(stdout: string): string | undefined {
  if (!stdout) return undefined;
  // 直接 JSON 行
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const mid =
        typeof obj.message_id === "string"
          ? obj.message_id
          : typeof obj.messageId === "string"
            ? obj.messageId
            : undefined;
      if (mid) return mid;
      // 嵌套 data 容器
      const data = obj.data as Record<string, unknown> | undefined;
      if (data) {
        const nested =
          typeof data.message_id === "string"
            ? data.message_id
            : typeof data.messageId === "string"
              ? data.messageId
              : undefined;
        if (nested) return nested;
      }
    } catch {
      // 跳过非 JSON 行
    }
  }
  return undefined;
}

/** Phase 2+: 通过 lark-cli im 发送消息 */
export class LarkCliFeishuReporter implements FeishuReporter {
  constructor(private readonly profile: string = "dev-brain") {}

  /** v0.9.0 (CAP-GW-06): 长文本自动分片,逐条 send */
  async sendText(reply: FeishuReply): Promise<void> {
    const chunks = splitTextIntoChunks(reply.text);
    if (chunks.length > 1) {
      safe(() => this.metrics.inc("gateway.text.chunked"), undefined);
      safe(
        () => this.metrics.inc("gateway.text.chunk_count_total", chunks.length),
        undefined,
      );
    }
    for (const chunk of chunks) {
      await withTransientRetry(() =>
        spawnLarkCli([
          "im",
          "+messages-send",
          "--profile",
          this.profile,
          "--chat-id",
          reply.chatId,
          "--msg-type",
          "text",
          "--content",
          JSON.stringify({ text: chunk }),
        ]),
      );
    }
  }

  /** v0.9.0 (CAP-GW-07): 卡片超长先降级再 send */
  async sendCard(reply: FeishuCardReply): Promise<string | undefined> {
    const { card: degraded, degraded: wasDegraded } =
      degradeCardForSizeWithFlag(reply.card);
    if (wasDegraded) {
      safe(() => this.metrics.inc("gateway.card.degraded"), undefined);
    }
    const stdout = await withTransientRetry(() =>
      spawnLarkCli([
        "im",
        "+messages-send",
        "--profile",
        this.profile,
        "--chat-id",
        reply.chatId,
        "--msg-type",
        "interactive",
        "--content",
        JSON.stringify(degraded),
      ]),
    );
    return parseMessageIdFromStdout(stdout);
  }

  async updateCard(update: FeishuCardUpdate): Promise<string | undefined> {
    // 飞书 update_card 端点（lark-cli 包装）。
    const { card: degraded, degraded: wasDegraded } =
      degradeCardForSizeWithFlag(update.card);
    if (wasDegraded) {
      safe(() => this.metrics.inc("gateway.card.degraded"), undefined);
    }
    await withTransientRetry(() =>
      spawnLarkCli([
        "im",
        "+messages-update",
        "--profile",
        this.profile,
        "--message-id",
        update.messageId,
        "--content",
        JSON.stringify(degraded),
      ]),
    );
    return update.messageId;
  }

  private get metrics() {
    return getMetrics();
  }
}

export function formatInboundLog(
  message: FeishuInboundMessage | InboundMessage,
): string {
  const sender = message.senderName ?? message.senderOpenId;
  return `[feishu] ${sender}@${message.chatId}: ${message.text.slice(0, 80)}`;
}

export function supportsCards(
  reporter: FeishuReporter,
): reporter is Required<Pick<FeishuReporter, "sendCard">> & FeishuReporter {
  return typeof reporter.sendCard === "function";
}

/**
 * v0.9.0: 飞书 API 错误分类（CAP-GW-08 / T-96）。
 * 三类:
 *  - AUTH_EXPIRED: tenant_access_token 过期(99991663)
 *  - RATE_LIMIT: 限流(230020 / 230021)
 *  - OTHER: 其他透传
 */
export type FeishuErrorCode = "AUTH_EXPIRED" | "RATE_LIMIT" | "OTHER";

export class FeishuApiError extends Error {
  readonly code: FeishuErrorCode;
  readonly feishuCode: number | undefined;
  constructor(
    code: FeishuErrorCode,
    message: string,
    feishuCode?: number,
    public readonly stderr?: string,
  ) {
    super(message);
    this.name = "FeishuApiError";
    this.code = code;
    this.feishuCode = feishuCode;
  }
}

/** 已知飞书错误码 → 语义化分类 */
const FEISHU_ERROR_MAP: Readonly<Record<number, FeishuErrorCode>> = {
  99991663: "AUTH_EXPIRED",
  99991661: "AUTH_EXPIRED",
  230020: "RATE_LIMIT",
  230021: "RATE_LIMIT",
  230022: "RATE_LIMIT",
};

/**
 * 解析 lark-cli 错误输出(从 spawnLarkCli 抛出的 Error.message 中提取 code)。
 * 返回 undefined 表示不是已知飞书 API 错误。
 */
export function classifyLarkCliError(err: unknown): FeishuApiError | undefined {
  const msg = err instanceof Error ? err.message : String(err);
  // 匹配 "code": 99991663 或 "code":99991663
  const m = msg.match(/"code"\s*:\s*(\d{6,8})/);
  if (!m) {
    // 也可能是 stderr 直接含的字符串(我们的 spawnLarkCli 把 tail 拼到 message)
    const fallback = msg.match(/\b(\d{6,8})\b/);
    if (!fallback) return undefined;
    const code = Number.parseInt(fallback[1] ?? "", 10);
    if (!FEISHU_ERROR_MAP[code]) return undefined;
    return new FeishuApiError(FEISHU_ERROR_MAP[code], msg, code, msg);
  }
  const code = Number.parseInt(m[1] ?? "", 10);
  const klass = FEISHU_ERROR_MAP[code];
  if (!klass) return undefined;
  return new FeishuApiError(klass, msg, code, msg);
}

/**
 * v0.9.0: 简单指数退避重试（CAP-GW-08 / T-97）。
 * 仅对 RATE_LIMIT 重试;AUTH_EXPIRED / OTHER 直接透传。
 * 参数参考 cc-connect withTransientRetry:baseMs=500, jitter=25%, maxRetries=3。
 */
export interface WithTransientRetryOptions {
  readonly maxRetries?: number;
  readonly baseMs?: number;
  readonly jitterRatio?: number;
}

export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  options: WithTransientRetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseMs = options.baseMs ?? 500;
  const jitterRatio = options.jitterRatio ?? 0.25;
  const metrics = getMetrics();

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const result = await fn();
      if (attempt > 0) {
        safe(() => metrics.inc("gateway.feishu.retry_succeeded"), undefined);
      }
      return result;
    } catch (err) {
      lastErr = err;
      const classified = classifyLarkCliError(err);
      if (!classified) {
        throw err;
      }
      if (classified.code === "AUTH_EXPIRED") {
        safe(() => metrics.inc("gateway.feishu.auth_expired"), undefined);
        throw err;
      }
      if (classified.code === "RATE_LIMIT") {
        safe(() => metrics.inc("gateway.feishu.rate_limited"), undefined);
        if (attempt === maxRetries) break;
        // 退避:500ms → 1000ms → 2000ms (+/- 25% jitter)
        const backoff = baseMs * 2 ** attempt;
        const jitter = backoff * jitterRatio * (Math.random() * 2 - 1);
        const sleepMs = Math.max(0, Math.round(backoff + jitter));
        await new Promise((r) => setTimeout(r, sleepMs));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}
