/**
 * v0.9.0 legacy shim: 收口所有 cc-connect UDS 派发路径的 adapter。
 *
 * 历史:
 *  - v0.7.0 全部 adapter 走 cc-connect UDS(`ClaudeCodeAdapter` / `CodexAdapter` / `CursorAdapter`)
 *  - v0.8.0 引入 `agentBackend=native` 切到直接 spawn,cc-connect 退为可选 backend
 *  - v0.9.0 native 成为唯一生产路径;此文件保留仅为 v0.7.0 兼容,默认不 import
 *
 * 用法(legacy 用户):
 *   import { CC_CONNECT_FACTORIES } from "./adapters/cc-connect/legacy.js";
 *   AdapterRegistry.create(config, undefined, CC_CONNECT_FACTORIES);
 *
 * 默认 `AdapterRegistry.create()` 不 import 此文件,生产 bundle 通过 tree-shaking
 * 把 `src/adapters/cc-connect/` 全部模块排除,实现零 cc-connect 依赖。
 */

import type { DevBrainConfig } from "../../config/env.js";
import type { AgentAdapter } from "../types.js";
import type { CcConnectClient } from "./index.js";
import { ClaudeCodeAdapter, CodexAdapter } from "../claude-code-adapter.js";
import { CursorAdapter } from "../cursor-adapter.js";
import type { AgentRuntime } from "../../core/types.js";

export interface LegacyAdapterFactory {
  readonly runtime: AgentRuntime;
  create(config: DevBrainConfig, client: CcConnectClient): AgentAdapter;
}

/** v0.7.0 cc-connect backend — 老 UDS 派发路径(保持 v0.7.0 行为) */
export const CC_CONNECT_FACTORIES: ReadonlyArray<LegacyAdapterFactory> = [
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

/** re-export 老 adapter,便于直接使用 */
export { ClaudeCodeAdapter, CodexAdapter, CursorAdapter };
