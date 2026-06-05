/**
 * v0.8.0: 直接 spawn `claude` CLI，无需 cc-connect 中转。
 *
 * 默认行为对齐用户现有 cc-connect claude-code 配置：
 * - 模型：MiniMax-M3-highspeed
 * - API：https://api.minimaxi.com/anthropic
 * - key：$MINIMAX_API_KEY（从 launchd plist 透传）
 * - 权限：bypassPermissions（对应 cc-connect mode=yolo）
 *
 * 高级用户可通过 DEV_BRAIN_CLAUDE_* 环境变量覆盖。
 */
import {
  LocalSpawnAdapter,
  type LocalSpawnConfig,
} from "./local-spawn-adapter.js";

export interface LocalClaudeConfig {
  readonly claudeBin: string;
  readonly claudeApiKey: string;
  readonly claudeBaseUrl: string;
  readonly claudeModel: string;
  readonly claudePermissionMode: string;
  readonly claudeExtraArgs: ReadonlyArray<string>;
  readonly nativeTimeoutMs: number;
  /** v0.8.0: stub 模式短路 */
  readonly adapterMode: "stub" | "live";
}

export class LocalClaudeCodeAdapter extends LocalSpawnAdapter {
  readonly runtime = "claude-code" as const;

  constructor(cfg: LocalClaudeConfig) {
    super({
      runtime: "claude-code",
      config: LocalClaudeCodeAdapter.buildConfig(cfg),
    });
  }

  private static buildConfig(cfg: LocalClaudeConfig): LocalSpawnConfig {
    const env: Record<string, string> = {
      ANTHROPIC_API_KEY: cfg.claudeApiKey,
      ANTHROPIC_BASE_URL: cfg.claudeBaseUrl,
      ANTHROPIC_MODEL: cfg.claudeModel,
    };
    return {
      bin: cfg.claudeBin,
      env,
      buildArgs: (prompt: string) => [
        "-p",
        prompt,
        "--model",
        cfg.claudeModel,
        "--permission-mode",
        cfg.claudePermissionMode,
        "--output-format",
        "text",
        "--bare",
        ...cfg.claudeExtraArgs,
      ],
      timeoutMs: cfg.nativeTimeoutMs,
      adapterMode: cfg.adapterMode,
    };
  }
}
