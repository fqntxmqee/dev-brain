import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/** 严格正整数（1ms-1h 区间，防御畸形配置） */
const TimeoutMsSchema = z
  .string()
  .regex(/^\d+$/, "must be non-negative integer string")
  .transform((s) => Number.parseInt(s, 10))
  .refine((n) => n >= 0 && n <= 3_600_000, "must be in [0, 3_600_000]ms");

const PollMsSchema = z
  .string()
  .regex(/^\d+$/)
  .transform((s) => Number.parseInt(s, 10))
  .refine((n) => n >= 50 && n <= 60_000, "must be in [50, 60_000]ms");

function safeInt(
  raw: string | undefined,
  fallback: number,
  schema: z.ZodType<number>,
): number {
  const result = schema.safeParse(raw ?? String(fallback));
  if (result.success) return result.data;
  return fallback;
}

export type AdapterMode = "stub" | "live";
export type CcSyncMode = "send" | "relay";

export interface DevBrainConfig {
  readonly workDir: string;
  readonly ccConnectSocket: string;
  readonly ccConnectBin: string;
  readonly ccDataDir: string;
  readonly ccSyncMode: CcSyncMode;
  readonly ccRelayTimeoutMs: number;
  readonly ccProjectClaude: string;
  readonly ccProjectCodex: string;
  readonly ccProjectCursor: string;
  readonly allowFrom: ReadonlySet<string>;
  readonly feishuAppId: string;
  readonly feishuAppSecret: string;
  readonly adapterMode: AdapterMode;
  readonly cursorApiKey: string;
  readonly cursorModel: string;
  readonly feishuCards: boolean;
  readonly feishuCardActions: boolean;
  readonly ccConfigPath: string;
  readonly ccBridgeEnabled: boolean;
  readonly ccBridgePollMs: number;
  readonly ccBridgeTimeoutMs: number;
  readonly ccBridgeReplyPath: string;
  readonly ccBridgeSocket: string;
  /** DEBUG 模式开关（T-41 收敛 process.env 直读） */
  readonly debug: boolean;
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): DevBrainConfig {
  const allowRaw = env.DEV_BRAIN_ALLOW_FROM?.trim() ?? "";
  const allowFrom = new Set(
    allowRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  return {
    workDir: env.DEV_BRAIN_WORK_DIR?.trim() || join(homedir(), "workspace"),
    ccConnectSocket: expandHome(
      env.DEV_BRAIN_CC_CONNECT_SOCKET?.trim() ||
        join(homedir(), ".cc-connect/run/api.sock"),
    ),
    ccConnectBin: env.DEV_BRAIN_CC_CONNECT_BIN?.trim() || "cc-connect",
    ccDataDir: expandHome(
      env.DEV_BRAIN_CC_DATA_DIR?.trim() || join(homedir(), ".cc-connect"),
    ),
    ccSyncMode: env.DEV_BRAIN_CC_SYNC?.trim() === "relay" ? "relay" : "send",
    ccRelayTimeoutMs: safeInt(
      env.DEV_BRAIN_CC_RELAY_TIMEOUT_MS?.trim(),
      300000,
      TimeoutMsSchema,
    ),
    ccProjectClaude:
      env.DEV_BRAIN_CC_PROJECT_CLAUDE?.trim() || "workspace-claude",
    ccProjectCodex: env.DEV_BRAIN_CC_PROJECT_CODEX?.trim() || "workspace-codex",
    ccProjectCursor:
      env.DEV_BRAIN_CC_PROJECT_CURSOR?.trim() || "workspace-cursor",
    allowFrom,
    feishuAppId: env.DEV_BRAIN_FEISHU_APP_ID?.trim() ?? "",
    feishuAppSecret: env.DEV_BRAIN_FEISHU_APP_SECRET?.trim() ?? "",
    adapterMode:
      env.DEV_BRAIN_ADAPTER_MODE?.trim() === "live" ? "live" : "stub",
    cursorApiKey: env.CURSOR_API_KEY?.trim() ?? "",
    cursorModel: env.DEV_BRAIN_CURSOR_MODEL?.trim() || "composer-2.5",
    feishuCards: env.DEV_BRAIN_FEISHU_CARDS?.trim() !== "0",
    feishuCardActions: env.DEV_BRAIN_FEISHU_CARD_ACTIONS?.trim() !== "0",
    ccConfigPath: expandHome(
      env.DEV_BRAIN_CC_CONFIG?.trim() ||
        join(homedir(), ".cc-connect/config.toml"),
    ),
    ccBridgeEnabled: env.DEV_BRAIN_CC_BRIDGE?.trim() !== "0",
    ccBridgePollMs: safeInt(
      env.DEV_BRAIN_CC_BRIDGE_POLL_MS?.trim(),
      2000,
      PollMsSchema,
    ),
    ccBridgeTimeoutMs: safeInt(
      env.DEV_BRAIN_CC_BRIDGE_TIMEOUT_MS?.trim(),
      300000,
      TimeoutMsSchema,
    ),
    ccBridgeReplyPath:
      env.DEV_BRAIN_CC_BRIDGE_REPLY_PATH?.trim() || "/bridge/reply",
    ccBridgeSocket: expandHome(
      env.DEV_BRAIN_CC_BRIDGE_SOCKET?.trim() ||
        join(homedir(), ".cc-connect/run/bridge.sock"),
    ),
    debug: env.DEV_BRAIN_DEBUG?.trim() === "1",
  };
}

export function isSenderAllowed(
  config: DevBrainConfig,
  senderOpenId: string,
): boolean {
  if (config.allowFrom.size === 0) {
    return false;
  }
  if (config.allowFrom.has("*")) {
    return true;
  }
  return config.allowFrom.has(senderOpenId);
}

/**
 * 占位值检测（CAP-CONF-02 / T-71）。
 * 命中 `cli_xxx` / `xxx` / `your_*` / `replace_me` 等典型占位 pattern 时返 true。
 * 仅 stderr WARN，启动不阻断（保留 stub 模式调试）。
 */
const PLACEHOLDER_PATTERNS: ReadonlyArray<RegExp> = [
  /^cli_x{3,}/i,
  /^(your|placeholder|replace[_-]?me|todo|fixme)[_-].*$/i,
  /^x{3,}$/i,
  /^(change|fill)[_-]?me$/i,
  /^example[-_]?(key|secret|token)/i,
];

export function looksLikePlaceholder(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (v.length < 3) return false;
  return PLACEHOLDER_PATTERNS.some((re) => re.test(v));
}

/** 启动期占位检查，返所有命中的字段名（不阻断） */
export function detectPlaceholders(
  config: DevBrainConfig,
): ReadonlyArray<string> {
  const hits: string[] = [];
  if (config.feishuAppId && looksLikePlaceholder(config.feishuAppId))
    hits.push("DEV_BRAIN_FEISHU_APP_ID");
  if (config.feishuAppSecret && looksLikePlaceholder(config.feishuAppSecret))
    hits.push("DEV_BRAIN_FEISHU_APP_SECRET");
  if (config.cursorApiKey && looksLikePlaceholder(config.cursorApiKey))
    hits.push("CURSOR_API_KEY");
  return hits;
}
