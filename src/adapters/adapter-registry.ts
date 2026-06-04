import type { DevBrainConfig } from '../config/env.js';
import type { AgentRuntime } from '../core/types.js';
import { CcConnectClient } from './cc-connect-client.js';
import { ClaudeCodeAdapter, CodexAdapter } from './claude-code-adapter.js';
import { CursorAdapter } from './cursor-adapter.js';
import type { AgentAdapter } from './types.js';

export class AdapterRegistry {
  private readonly adapters: ReadonlyMap<AgentRuntime, AgentAdapter>;

  constructor(config: DevBrainConfig) {
    const client = CcConnectClient.fromConfig(config);
    const entries: ReadonlyArray<[AgentRuntime, AgentAdapter]> = [
      ['claude-code', new ClaudeCodeAdapter(config, client)],
      ['codex', new CodexAdapter(config, client)],
      ['cursor', new CursorAdapter(config, client)],
    ];
    this.adapters = new Map(entries);
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
