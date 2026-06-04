import { homedir } from 'node:os';
import { join } from 'node:path';

export type AdapterMode = 'stub' | 'live';
export type CcSyncMode = 'send' | 'relay';

export interface DevBrainConfig {
  readonly workDir: string;
  readonly ccConnectSocket: string;
  readonly ccConnectBin: string;
  readonly ccDataDir: string;
  readonly ccSyncMode: CcSyncMode;
  readonly ccRelayTimeoutMs: number;
  readonly ccProjectClaude: string;
  readonly ccProjectCodex: string;
  readonly ccProjectCursor: string;
  readonly allowFrom: ReadonlySet<string>;
  readonly feishuAppId: string;
  readonly feishuAppSecret: string;
  readonly adapterMode: AdapterMode;
  readonly cursorApiKey: string;
  readonly cursorModel: string;
  readonly feishuCards: boolean;
  readonly feishuCardActions: boolean;
  readonly ccConfigPath: string;
  readonly ccBridgeEnabled: boolean;
  readonly ccBridgePollMs: number;
  readonly ccBridgeTimeoutMs: number;
  readonly ccBridgeReplyPath: string;
  readonly ccBridgeSocket: string;
}

function expandHome(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DevBrainConfig {
  const allowRaw = env.DEV_BRAIN_ALLOW_FROM?.trim() ?? '';
  const allowFrom = new Set(
    allowRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  return {
    workDir: env.DEV_BRAIN_WORK_DIR?.trim() || join(homedir(), 'workspace'),
    ccConnectSocket: expandHome(
      env.DEV_BRAIN_CC_CONNECT_SOCKET?.trim() || join(homedir(), '.cc-connect/run/api.sock'),
    ),
    ccConnectBin: env.DEV_BRAIN_CC_CONNECT_BIN?.trim() || 'cc-connect',
    ccDataDir: expandHome(env.DEV_BRAIN_CC_DATA_DIR?.trim() || join(homedir(), '.cc-connect')),
    ccSyncMode: env.DEV_BRAIN_CC_SYNC?.trim() === 'relay' ? 'relay' : 'send',
    ccRelayTimeoutMs: Number.parseInt(env.DEV_BRAIN_CC_RELAY_TIMEOUT_MS?.trim() ?? '300000', 10),
    ccProjectClaude: env.DEV_BRAIN_CC_PROJECT_CLAUDE?.trim() || 'workspace-claude',
    ccProjectCodex: env.DEV_BRAIN_CC_PROJECT_CODEX?.trim() || 'workspace-codex',
    ccProjectCursor: env.DEV_BRAIN_CC_PROJECT_CURSOR?.trim() || 'workspace-cursor',
    allowFrom,
    feishuAppId: env.DEV_BRAIN_FEISHU_APP_ID?.trim() ?? '',
    feishuAppSecret: env.DEV_BRAIN_FEISHU_APP_SECRET?.trim() ?? '',
    adapterMode: env.DEV_BRAIN_ADAPTER_MODE?.trim() === 'live' ? 'live' : 'stub',
    cursorApiKey: env.CURSOR_API_KEY?.trim() ?? '',
    cursorModel: env.DEV_BRAIN_CURSOR_MODEL?.trim() || 'composer-2.5',
    feishuCards: env.DEV_BRAIN_FEISHU_CARDS?.trim() !== '0',
    feishuCardActions: env.DEV_BRAIN_FEISHU_CARD_ACTIONS?.trim() !== '0',
    ccConfigPath: expandHome(
      env.DEV_BRAIN_CC_CONFIG?.trim() || join(homedir(), '.cc-connect/config.toml'),
    ),
    ccBridgeEnabled: env.DEV_BRAIN_CC_BRIDGE?.trim() !== '0',
    ccBridgePollMs: Number.parseInt(env.DEV_BRAIN_CC_BRIDGE_POLL_MS?.trim() ?? '2000', 10),
    ccBridgeTimeoutMs: Number.parseInt(
      env.DEV_BRAIN_CC_BRIDGE_TIMEOUT_MS?.trim() ?? '300000',
      10,
    ),
    ccBridgeReplyPath: env.DEV_BRAIN_CC_BRIDGE_REPLY_PATH?.trim() || '/bridge/reply',
    ccBridgeSocket: expandHome(
      env.DEV_BRAIN_CC_BRIDGE_SOCKET?.trim() ||
        join(homedir(), '.cc-connect/run/bridge.sock'),
    ),
  };
}

export function isSenderAllowed(config: DevBrainConfig, senderOpenId: string): boolean {
  if (config.allowFrom.size === 0) {
    return true;
  }
  return config.allowFrom.has(senderOpenId);
}
