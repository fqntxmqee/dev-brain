import { CcConnectClient } from "../adapters/cc-connect-client.js";
import type { DevBrainConfig } from "../config/env.js";
import { checkHeadlessConfig } from "./migrate-headless.js";

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly nextStep?: string;
}

const NEXT_STEPS: Readonly<Record<string, string>> = {
  cc_connect_socket:
    "先启动 cc-connect daemon；或 DEV_BRAIN_ADAPTER_MODE=stub 走 stub 模式",
  cc_connect_headless:
    "运行 `pnpm cli -- migrate-headless --check` 看详情，`--apply` 切换",
  feishu_credentials: "复制 .env.example → .env 填入 Brain 飞书应用凭证",
  cursor_api_key: "设置 CURSOR_API_KEY 或忽略（cursor 走 cc-connect fallback）",
  sender_unauthorized:
    "设置 DEV_BRAIN_ALLOW_FROM=<你的 open_id>（测试期可设 *=*）",
};

export async function runDoctorChecks(
  config: DevBrainConfig,
): Promise<ReadonlyArray<DoctorCheck>> {
  const checks: DoctorCheck[] = [];

  checks.push({
    name: "adapter_mode",
    ok: true,
    detail: config.adapterMode,
  });

  checks.push({
    name: "cc_connect_socket",
    ok:
      config.adapterMode === "stub"
        ? true
        : await CcConnectClient.fromConfig(config).ping(),
    detail: config.ccConnectSocket,
    nextStep: NEXT_STEPS.cc_connect_socket,
  });

  checks.push({
    name: "cursor_api_key",
    ok: true,
    detail: config.cursorApiKey
      ? "set (@cursor/sdk)"
      : "missing — live cursor uses cc-connect workspace-cursor",
    nextStep: NEXT_STEPS.cursor_api_key,
  });

  checks.push({
    name: "feishu_credentials",
    ok: Boolean(config.feishuAppId && config.feishuAppSecret),
    detail:
      config.feishuAppId && config.feishuAppSecret
        ? "configured"
        : "missing (required for dev-brain start)",
    nextStep: NEXT_STEPS.feishu_credentials,
  });

  checks.push({
    name: "cc_sync_mode",
    ok: true,
    detail: `${config.ccSyncMode} (relay = sync text via cc-connect relay send)`,
  });

  const headless = await checkHeadlessConfig(config.ccConfigPath);
  checks.push({
    name: "cc_connect_headless",
    ok: headless.ok,
    detail: headless.ok
      ? `${headless.projectCount} projects, no platforms`
      : headless.issues.join("; ") || "check failed",
    nextStep: NEXT_STEPS.cc_connect_headless,
  });

  return checks;
}

export function formatDoctorReport(checks: ReadonlyArray<DoctorCheck>): string {
  const lines = checks.map((c) => {
    const status = c.ok ? "✅" : "❌";
    const step = !c.ok && c.nextStep ? `\n   💡 修复：${c.nextStep}` : "";
    return `${status} ${c.name}: ${c.detail}${step}`;
  });
  return ["🩺 Dev Brain Doctor", ...lines].join("\n");
}
