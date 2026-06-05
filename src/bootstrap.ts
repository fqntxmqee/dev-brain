import { loadConfig, type DevBrainConfig } from "./config/env.js";
import { createBrainEngine } from "./brain/brain-engine.js";
import { FeishuGateway } from "./gateway/feishu-gateway.js";
import {
  InMemoryFeishuReporter,
  type FeishuReporter,
} from "./gateway/feishu-reporter.js";
import type { CcConnectClient } from "./adapters/cc-connect/index.js";

export interface DevBrainApp {
  readonly config: DevBrainConfig;
  readonly brain: ReturnType<typeof createBrainEngine>;
  readonly gateway: FeishuGateway;
}

export interface CreateDevBrainAppOptions {
  /** 完整配置覆盖（CAP-CONF-03） */
  readonly config?: DevBrainConfig;
  /** 局部 env 覆盖（仅本次调用生效） */
  readonly envOverrides?: Record<string, string>;
  /** DI 注入 cc-connect client（用于测试） */
  readonly client?: CcConnectClient;
}

export function createDevBrainApp(
  reporter: FeishuReporter = new InMemoryFeishuReporter(),
  opts: CreateDevBrainAppOptions = {},
): DevBrainApp {
  const config =
    opts.config ??
    (opts.envOverrides
      ? loadConfig({ ...process.env, ...opts.envOverrides })
      : loadConfig());
  const brain = createBrainEngine(config, opts.client);
  const gateway = new FeishuGateway({ config, brain, reporter });
  return { config, brain, gateway };
}
