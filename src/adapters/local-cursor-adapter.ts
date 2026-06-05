/**
 * v0.8.1: 直接 spawn `cursor-agent` (or `agent`) CLI 替代 cc-connect 中转。
 *
 * Cursor 官方 CLI（cursor-agent / agent）：
 *   cursor-agent -p "..." --api-key sk-xxx --model <model> [--mode plan|ask]
 *
 * 高级用户可通过 DEV_BRAIN_CURSOR_* 环境变量覆盖。
 */
import {
  LocalSpawnAdapter,
  type LocalSpawnConfig,
} from "./local-spawn-adapter.js";

export interface LocalCursorConfig {
  readonly cursorBin: string;
  readonly cursorApiKey: string;
  readonly cursorModel: string;
  /** v0.8.1: 子任务模式（plan = 只读探索，ask = Q&A；空 = 默认有写权限） */
  readonly cursorMode: "plan" | "ask" | "";
  readonly nativeTimeoutMs: number;
  readonly adapterMode: "stub" | "live";
}

export class LocalCursorAdapter extends LocalSpawnAdapter {
  readonly runtime = "cursor" as const;

  constructor(cfg: LocalCursorConfig) {
    super({
      runtime: "cursor",
      config: LocalCursorCodeAdapter_buildConfig(cfg),
    });
  }
}

function LocalCursorCodeAdapter_buildConfig(
  cfg: LocalCursorConfig,
): LocalSpawnConfig {
  const env: Record<string, string> = {
    ...(cfg.cursorApiKey ? { CURSOR_API_KEY: cfg.cursorApiKey } : {}),
  };
  return {
    bin: cfg.cursorBin,
    env,
    buildArgs: (prompt: string) => {
      const args: Array<string> = ["-p", prompt, "--print"];
      if (cfg.cursorApiKey) {
        args.push("--api-key", cfg.cursorApiKey);
      }
      if (cfg.cursorModel) {
        args.push("--model", cfg.cursorModel);
      }
      if (cfg.cursorMode === "plan") {
        args.push("--mode", "plan");
      } else if (cfg.cursorMode === "ask") {
        args.push("--mode", "ask");
      }
      return args;
    },
    timeoutMs: cfg.nativeTimeoutMs,
    adapterMode: cfg.adapterMode,
  };
}
