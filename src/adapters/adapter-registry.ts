import type { DevBrainConfig } from "../config/env.js";
import type { AgentRuntime } from "../core/types.js";
import { defaultLogger, type Logger } from "../core/logger.js";
import { LocalClaudeCodeAdapter } from "./local-claude-code-adapter.js";
import { LocalCodexAdapter } from "./local-codex-adapter.js";
import { LocalCursorAdapter } from "./local-cursor-adapter.js";
import type { AgentAdapter } from "./types.js";

/** v0.8.0+: factory 签名 — native factory 忽略 client,cc-connect factory 必用 client */
export interface AdapterFactory {
  readonly runtime: AgentRuntime;
  create(config: DevBrainConfig, client?: unknown): AgentAdapter;
}

/** v0.8.0: native backend — 直接 spawn 本地 CLI(无需 cc-connect 实时可达) */
const NATIVE_FACTORIES: ReadonlyArray<AdapterFactory> = [
  {
    runtime: "claude-code",
    create: (c) =>
      new LocalClaudeCodeAdapter({
        claudeBin: c.claudeBin,
        claudeApiKey: c.claudeApiKey,
        claudeBaseUrl: c.claudeBaseUrl,
        claudeModel: c.claudeModel,
        claudePermissionMode: c.claudePermissionMode,
        claudeExtraArgs: c.claudeExtraArgs,
        nativeTimeoutMs: c.nativeTimeoutMs,
        adapterMode: c.adapterMode,
      }),
  },
  {
    runtime: "codex",
    create: (c) =>
      new LocalCodexAdapter({
        codexBin: c.codexBin,
        codexApiKey: c.codexApiKey,
        codexBaseUrl: c.codexBaseUrl,
        codexModel: c.codexModel,
        codexProfile: c.codexProfile,
        nativeTimeoutMs: c.nativeTimeoutMs,
        adapterMode: c.adapterMode,
      }),
  },
  {
    runtime: "cursor",
    create: (c) =>
      new LocalCursorAdapter({
        cursorBin: c.cursorBin,
        cursorApiKey: c.cursorApiKey,
        cursorModel: c.cursorModel,
        cursorMode: c.cursorMode,
        nativeTimeoutMs: c.nativeTimeoutMs,
        adapterMode: c.adapterMode,
      }),
  },
];

export class AdapterRegistry {
  private readonly adapters: ReadonlyMap<AgentRuntime, AgentAdapter>;

  private constructor(adapters: ReadonlyMap<AgentRuntime, AgentAdapter>) {
    this.adapters = adapters;
  }

  private static log = defaultLogger.child({
    component: "adapter-registry",
  });

  /**
   * 默认创建 native adapter registry(v0.9.0+: 唯一生产路径)。
   * 旧的 `cc-connect` UDS 派发路径已迁到 `./cc-connect/legacy.ts`,通过 `factories` 参数显式注入。
   *
   * 用法对比:
   *   - 生产:`AdapterRegistry.create(config)`  → native,无 cc-connect 依赖
   *   - legacy:`AdapterRegistry.create(config, undefined, CC_CONNECT_FACTORIES)` → v0.7.0 行为
   */
  static create(
    config: DevBrainConfig,
    _client?: unknown,
    factories?: ReadonlyArray<AdapterFactory>,
  ): AdapterRegistry {
    const selected = factories ?? NATIVE_FACTORIES;
    if (config.agentBackend === "cc-connect" && !factories) {
      AdapterRegistry.log.warn(
        "agentBackend=cc-connect deprecated; v0.9.0+ only ships native path. " +
          "For legacy behavior, import CC_CONNECT_FACTORIES from ./cc-connect/legacy.js",
      );
    }
    const entries: Array<[AgentRuntime, AgentAdapter]> = [];
    for (const factory of selected) {
      entries.push([factory.runtime, factory.create(config, undefined)]);
    }
    return new AdapterRegistry(new Map(entries));
  }

  /** T-60: 注入完整适配器 map(测试 / 单 adapter 场景) */
  static fromAdapters(
    adapters: ReadonlyMap<AgentRuntime, AgentAdapter>,
  ): AdapterRegistry {
    return new AdapterRegistry(adapters);
  }

  get(runtime: AgentRuntime): AgentAdapter {
    const adapter = this.adapters.get(runtime);
    if (!adapter) {
      throw new Error(`No adapter registered for runtime: ${runtime}`);
    }
    return adapter;
  }

  list(): ReadonlyArray<AgentRuntime> {
    return [...this.adapters.keys()];
  }
}

/** v0.9.0+: legacy logger type re-export,避免内部 import 旧路径 */
export type { Logger };
