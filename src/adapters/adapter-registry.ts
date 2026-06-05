import type { DevBrainConfig } from "../config/env.js";
import type { AgentRuntime } from "../core/types.js";
import { CcConnectClient } from "./cc-connect/index.js";
import { ClaudeCodeAdapter, CodexAdapter } from "./claude-code-adapter.js";
import { CursorAdapter } from "./cursor-adapter.js";
import { LocalClaudeCodeAdapter } from "./local-claude-code-adapter.js";
import { LocalCodexAdapter } from "./local-codex-adapter.js";
import { LocalCursorAdapter } from "./local-cursor-adapter.js";
import type { AgentAdapter } from "./types.js";

/** T-60 / v0.8.0: 工厂签名 — native factory 忽略 client；cc-connect factory 必用 client */
export interface AdapterFactory {
  readonly runtime: AgentRuntime;
  create(config: DevBrainConfig, client: CcConnectClient): AgentAdapter;
}

/** v0.8.0: native backend — 直接 spawn 本地 CLI（无需 cc-connect 实时可达） */
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

/** v0.8.0: cc-connect backend — 老 UDS 派发路径（保持 v0.7.0 行为） */
const CC_CONNECT_FACTORIES: ReadonlyArray<AdapterFactory> = [
  {
    runtime: "claude-code",
    create: (c, client) => new ClaudeCodeAdapter(c, client),
  },
  {
    runtime: "codex",
    create: (c, client) => new CodexAdapter(c, client),
  },
  {
    runtime: "cursor",
    create: (c, client) => new CursorAdapter(c, client),
  },
];

export class AdapterRegistry {
  private readonly adapters: ReadonlyMap<AgentRuntime, AgentAdapter>;

  private constructor(adapters: ReadonlyMap<AgentRuntime, AgentAdapter>) {
    this.adapters = adapters;
  }

  /** T-60 / v0.8.0: 默认 factory 取决于 config.agentBackend */
  static create(
    config: DevBrainConfig,
    client?: CcConnectClient,
    factories?: ReadonlyArray<AdapterFactory>,
  ): AdapterRegistry {
    const selected =
      factories ??
      (config.agentBackend === "native"
        ? NATIVE_FACTORIES
        : CC_CONNECT_FACTORIES);
    const resolved = client ?? CcConnectClient.fromConfig(config);
    const entries: Array<[AgentRuntime, AgentAdapter]> = [];
    for (const factory of selected) {
      entries.push([factory.runtime, factory.create(config, resolved)]);
    }
    return new AdapterRegistry(new Map(entries));
  }

  /** T-60: 注入完整适配器 map（测试/单 adapter 场景） */
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
