import type { DevBrainConfig } from "../config/env.js";
import type { AgentRuntime } from "../core/types.js";
import { CcConnectClient } from "./cc-connect-client.js";
import { ClaudeCodeAdapter, CodexAdapter } from "./claude-code-adapter.js";
import { CursorAdapter } from "./cursor-adapter.js";
import type { AgentAdapter } from "./types.js";

/** T-60: 工厂签名 — DI 测试用 */
export interface AdapterFactory {
  readonly runtime: AgentRuntime;
  create(config: DevBrainConfig, client: CcConnectClient): AgentAdapter;
}

const DEFAULT_FACTORIES: ReadonlyArray<AdapterFactory> = [
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

  /** T-60: 默认 factory + 默认 client — 业务调用入口 */
  static create(
    config: DevBrainConfig,
    client?: CcConnectClient,
    factories: ReadonlyArray<AdapterFactory> = DEFAULT_FACTORIES,
  ): AdapterRegistry {
    const resolved = client ?? CcConnectClient.fromConfig(config);
    const entries: Array<[AgentRuntime, AgentAdapter]> = [];
    for (const factory of factories) {
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
