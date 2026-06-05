import { loadConfig } from "./config/env.js";
import { createBrainEngine } from "./brain/brain-engine.js";
import { FeishuGateway } from "./gateway/feishu-gateway.js";
import {
  InMemoryFeishuReporter,
  type FeishuReporter,
} from "./gateway/feishu-reporter.js";

export interface DevBrainApp {
  readonly config: ReturnType<typeof loadConfig>;
  readonly brain: ReturnType<typeof createBrainEngine>;
  readonly gateway: FeishuGateway;
}

export function createDevBrainApp(
  reporter: FeishuReporter = new InMemoryFeishuReporter(),
): DevBrainApp {
  const config = loadConfig();
  const brain = createBrainEngine(config);
  const gateway = new FeishuGateway({ config, brain, reporter });
  return { config, brain, gateway };
}
