import { CcConnectClient } from '../adapters/cc-connect-client.js';
import type { DevBrainConfig } from '../config/env.js';
import { checkHeadlessConfig } from './migrate-headless.js';

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export async function runDoctorChecks(config: DevBrainConfig): Promise<ReadonlyArray<DoctorCheck>> {
  const checks: DoctorCheck[] = [];

  checks.push({
    name: 'adapter_mode',
    ok: true,
    detail: config.adapterMode,
  });

  checks.push({
    name: 'cc_connect_socket',
    ok: config.adapterMode === 'stub' ? true : await CcConnectClient.fromConfig(config).ping(),
    detail: config.ccConnectSocket,
  });

  checks.push({
    name: 'cursor_api_key',
    ok: true,
    detail: config.cursorApiKey
      ? 'set (@cursor/sdk)'
      : 'missing — live cursor uses cc-connect workspace-cursor',
  });

  checks.push({
    name: 'feishu_credentials',
    ok: Boolean(config.feishuAppId && config.feishuAppSecret),
    detail:
      config.feishuAppId && config.feishuAppSecret
        ? 'configured'
        : 'missing (required for dev-brain start)',
  });

  checks.push({
    name: 'cc_sync_mode',
    ok: true,
    detail: `${config.ccSyncMode} (relay = sync text via cc-connect relay send)`,
  });

  const headless = await checkHeadlessConfig(config.ccConfigPath);
  checks.push({
    name: 'cc_connect_headless',
    ok: headless.ok,
    detail: headless.ok
      ? `${headless.projectCount} projects, no platforms`
      : headless.issues.join('; ') || 'check failed',
  });

  return checks;
}

export function formatDoctorReport(checks: ReadonlyArray<DoctorCheck>): string {
  const lines = checks.map((c) => `${c.ok ? '✅' : '❌'} ${c.name}: ${c.detail}`);
  return ['🩺 Dev Brain Doctor', ...lines].join('\n');
}
