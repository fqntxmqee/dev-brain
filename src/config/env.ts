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

/** v0.7.0: 端口号（1-65535） */
const PortSchema = z
  .string()
  .regex(/^\d+$/)
  .transform((s) => Number.parseInt(s, 10))
  .refine((n) => n >= 1 && n <= 65535, "must be in [1, 65535]");

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
/** v0.8.0: native = spawn local CLIs; cc-connect = UDS dispatch to cc-connect */
export type AgentBackend = "native" | "cc-connect";

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
  /** v0.7.0: observability — metrics server (true=open /metrics endpoint) */
  readonly metricsEnabled: boolean;
  readonly metricsPort: number;
  /** 空字符串表示由 metrics-server 根据 CI/环境自动决定 */
  readonly metricsHost: string;
  /** v0.8.0: native = spawn local CLIs (no cc-connect); cc-connect = old UDS path */
  readonly agentBackend: AgentBackend;
  readonly claudeBin: string;
  readonly claudeApiKey: string;
  readonly claudeBaseUrl: string;
  readonly claudeModel: string;
  readonly claudePermissionMode: string;
  readonly claudeExtraArgs: ReadonlyArray<string>;
  readonly codexBin: string;
  readonly codexProfile: string;
  readonly codexApiKey: string;
  readonly codexBaseUrl: string;
  readonly codexModel: string;
  readonly nativeTimeoutMs: number;
  /** v0.8.1: cursor local CLI (cursor-agent / agent) */
  readonly cursorBin: string;
  readonly cursorMode: "plan" | "ask" | "";
  /** v0.8.0: cursor fallback when local CLI / SDK unavailable */
  readonly cursorFallback: "cc-connect" | "error";
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
    cursorBin: env.DEV_BRAIN_CURSOR_BIN?.trim() || "cursor-agent",
    cursorMode:
      env.DEV_BRAIN_CURSOR_MODE?.trim() === "plan" ||
      env.DEV_BRAIN_CURSOR_MODE?.trim() === "ask"
        ? (env.DEV_BRAIN_CURSOR_MODE.trim() as "plan" | "ask")
        : "",
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
    metricsEnabled: env.DEV_BRAIN_METRICS_ENABLED?.trim() !== "0",
    metricsPort: safeInt(env.DEV_BRAIN_METRICS_PORT?.trim(), 9090, PortSchema),
    metricsHost: env.DEV_BRAIN_METRICS_HOST?.trim() ?? "",
    // v0.8.0: native agent adapters
    agentBackend:
      env.DEV_BRAIN_AGENT_BACKEND?.trim() === "cc-connect"
        ? "cc-connect"
        : "native",
    claudeBin: env.DEV_BRAIN_CLAUDE_BIN?.trim() || "claude",
    claudeApiKey:
      env.DEV_BRAIN_CLAUDE_API_KEY?.trim() ||
      env.MINIMAX_API_KEY?.trim() ||
      env.ANTHROPIC_API_KEY?.trim() ||
      "",
    claudeBaseUrl:
      env.DEV_BRAIN_CLAUDE_BASE_URL?.trim() ||
      "https://api.minimaxi.com/anthropic",
    claudeModel: env.DEV_BRAIN_CLAUDE_MODEL?.trim() || "MiniMax-M3-highspeed",
    claudePermissionMode:
      env.DEV_BRAIN_CLAUDE_PERMISSION_MODE?.trim() || "bypassPermissions",
    claudeExtraArgs: (env.DEV_BRAIN_CLAUDE_EXTRA_ARGS?.trim() ?? "")
      .split(/\s+/)
      .filter(Boolean),
    codexBin: env.DEV_BRAIN_CODEX_BIN?.trim() || "codex-minimax",
    codexProfile: env.DEV_BRAIN_CODEX_PROFILE?.trim() || "m27",
    codexApiKey:
      env.DEV_BRAIN_CODEX_API_KEY?.trim() ||
      env.MINIMAX_API_KEY?.trim() ||
      env.ANTHROPIC_API_KEY?.trim() ||
      "",
    codexBaseUrl:
      env.DEV_BRAIN_CODEX_BASE_URL?.trim() ||
      "https://api.minimaxi.com/anthropic",
    codexModel: env.DEV_BRAIN_CODEX_MODEL?.trim() || "MiniMax-M2.7-highspeed",
    nativeTimeoutMs: safeInt(
      env.DEV_BRAIN_NATIVE_TIMEOUT_MS?.trim(),
      300000,
      TimeoutMsSchema,
    ),
    cursorFallback:
      env.DEV_BRAIN_CURSOR_FALLBACK?.trim() === "error"
        ? "error"
        : "cc-connect",
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
