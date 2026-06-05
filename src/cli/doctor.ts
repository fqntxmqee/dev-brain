import { CcConnectClient } from "../adapters/cc-connect-client.js";
import type { DevBrainConfig } from "../config/env.js";
import { isSocketReachable } from "../adapters/cc-connect-http.js";
import { looksLikePlaceholder } from "../config/env.js";
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
  cc_connect_unreachable:
    "cc-connect daemon 未运行或 socket 路径错误；运行 `cc-connect start` 或检查 DEV_BRAIN_CC_CONNECT_SOCKET",
  cc_connect_headless:
    "运行 `pnpm cli -- migrate-headless --check` 看详情，`--apply` 切换",
  feishu_credentials: "复制 .env.example → .env 填入 Brain 飞书应用凭证",
  feishu_placeholder:
    "当前是占位值（如 cli_xxx/your_*），请替换为真实 app_id/secret",
  feishu_expiry:
    "飞书 app_secret 默认 24h 缓存；如飞书 401/230xxx 错误请在开发者后台重置或新增 secret",
  cursor_api_key: "设置 CURSOR_API_KEY 或忽略（cursor 走 cc-connect fallback）",
  cursor_expiry:
    "Cursor API key 默认 60 天有效；过期后请在 https://cursor.com/dashboard 重置",
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

  // T-72: 单独一项不可达告警（live 模式强相关，stub 跳过）
  if (config.adapterMode === "live") {
    const reachable = await isSocketReachable(config.ccConnectSocket, 2_000);
    checks.push({
      name: "cc_connect_unreachable",
      ok: reachable,
      detail: reachable
        ? `reachable at ${config.ccConnectSocket}`
        : `socket not reachable: ${config.ccConnectSocket}`,
      nextStep: NEXT_STEPS.cc_connect_unreachable,
    });
  }

  checks.push({
    name: "cc_connect_socket",
    ok:
      config.adapterMode === "stub"
        ? true
        : await CcConnectClient.fromConfig(config).ping(),
    detail: config.ccConnectSocket,
    nextStep: NEXT_STEPS.cc_connect_socket,
  });

  // T-74: 占位值检测（如果 feishu 凭据是 cli_xxx/your_xxx 也算失败）
  const feishuIdPlaceholder = looksLikePlaceholder(config.feishuAppId);
  const feishuSecretPlaceholder = looksLikePlaceholder(config.feishuAppSecret);
  checks.push({
    name: "feishu_credentials",
    ok: Boolean(
      config.feishuAppId &&
      config.feishuAppSecret &&
      !feishuIdPlaceholder &&
      !feishuSecretPlaceholder,
    ),
    detail:
      config.feishuAppId && config.feishuAppSecret
        ? feishuIdPlaceholder || feishuSecretPlaceholder
          ? "configured BUT looks like placeholder"
          : "configured"
        : "missing (required for dev-brain start)",
    nextStep:
      feishuIdPlaceholder || feishuSecretPlaceholder
        ? NEXT_STEPS.feishu_placeholder
        : NEXT_STEPS.feishu_credentials,
  });

  // T-74: 凭证过期诊断（feishu 凭据弱校验 — 仅给运维提示）
  checks.push({
    name: "feishu_expiry_hint",
    ok: true,
    detail: "no probe (run dev-brain start; 飞书 230xxx/401 → reset secret)",
    nextStep: NEXT_STEPS.feishu_expiry,
  });

  checks.push({
    name: "cursor_api_key",
    ok: true,
    detail: config.cursorApiKey
      ? "set (@cursor/sdk)"
      : "missing — live cursor uses cc-connect workspace-cursor",
    nextStep: NEXT_STEPS.cursor_api_key,
  });

  if (config.cursorApiKey) {
    checks.push({
      name: "cursor_expiry_hint",
      ok: true,
      detail: "no probe (default 60d; 401 → rotate in cursor dashboard)",
      nextStep: NEXT_STEPS.cursor_expiry,
    });
  }

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
