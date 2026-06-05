/**
 * v0.8.0: 直接 spawn `codex-minimax` CLI，无需 cc-connect 中转。
 *
 * 默认行为对齐用户现有 cc-connect codex 配置：
 * - 二进制：codex-minimax（用户自己的 wrapper；自动管 bridge）
 * - 模型：MiniMax-M2.7-highspeed
 * - API：https://api.minimaxi.com/anthropic
 * - key：$MINIMAX_API_KEY
 * - profile：m27
 *
 * 高级用户可通过 DEV_BRAIN_CODEX_* 环境变量覆盖。
 */
import {
  LocalSpawnAdapter,
  type LocalSpawnConfig,
} from "./local-spawn-adapter.js";

export interface LocalCodexConfig {
  readonly codexBin: string;
  readonly codexProfile: string;
  readonly codexApiKey: string;
  readonly codexBaseUrl: string;
  readonly codexModel: string;
  readonly nativeTimeoutMs: number;
  /** v0.8.0: stub 模式短路 */
  readonly adapterMode: "stub" | "live";
}

export class LocalCodexAdapter extends LocalSpawnAdapter {
  readonly runtime = "codex" as const;

  constructor(cfg: LocalCodexConfig) {
    super({
      runtime: "codex",
      config: LocalCodexAdapter.buildConfig(cfg),
    });
  }

  private static buildConfig(cfg: LocalCodexConfig): LocalSpawnConfig {
    const env: Record<string, string> = {
      MINIMAX_API_KEY: cfg.codexApiKey,
      ANTHROPIC_AUTH_TOKEN: cfg.codexApiKey,
      ANTHROPIC_BASE_URL: cfg.codexBaseUrl,
      ANTHROPIC_MODEL: cfg.codexModel,
      CODEX_MINIMAX_PROFILE: cfg.codexProfile,
    };
    return {
      bin: cfg.codexBin,
      env,
      buildArgs: (prompt: string) => ["exec", prompt],
      timeoutMs: cfg.nativeTimeoutMs,
      adapterMode: cfg.adapterMode,
    };
  }
}
