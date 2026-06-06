import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { DevBrainConfig } from "../config/env.js";
import { looksLikePlaceholder } from "../config/env.js";

const execFile = promisify(execFileCb);

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly nextStep?: string;
}

const NEXT_STEPS: Readonly<Record<string, string>> = {
  feishu_credentials: "复制 .env.example → .env 填入 Brain 飞书应用凭证",
  feishu_placeholder:
    "当前是占位值（如 cli_xxx/your_*），请替换为真实 app_id/secret",
  feishu_expiry:
    "飞书 app_secret 默认 24h 缓存；如飞书 401/230xxx 错误请在开发者后台重置或新增 secret",
  cursor_api_key:
    "设置 CURSOR_API_KEY 可走 @cursor/sdk；留空走本地 cursor-agent CLI（推荐）",
  cursor_expiry:
    "Cursor API key 默认 60 天有效；过期后请在 https://cursor.com/dashboard 重置",
  sender_unauthorized:
    "设置 DEV_BRAIN_ALLOW_FROM=<你的 open_id>（测试期可设 *=*）",
  native_claude_binary:
    "安装 Claude Code CLI（`npm i -g @anthropic-ai/claude-code`）或设置 DEV_BRAIN_CLAUDE_BIN",
  native_codex_binary:
    "安装 codex 或自定义 wrapper 脚本（默认 `codex-minimax`），或设置 DEV_BRAIN_CODEX_BIN",
  native_minimax_key:
    "设置 $MINIMAX_API_KEY 或 $ANTHROPIC_API_KEY，或 DEV_BRAIN_CLAUDE_API_KEY / DEV_BRAIN_CODEX_API_KEY",
  native_cursor_binary:
    "安装 Cursor CLI（`cursor-agent`，新版随 Cursor 编辑器自带）或设置 DEV_BRAIN_CURSOR_BIN",
};

/** v0.8.0: 用 `command -v` 检查 binary 是否在 PATH 中可达 */
async function checkBinary(
  bin: string,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const { stdout } = await execFile("command", ["-v", bin], {
      timeout: 5_000,
    });
    const path = stdout.trim().split("\n")[0] ?? "";
    return { ok: true, detail: path || bin };
  } catch {
    return { ok: false, detail: `not found in PATH: ${bin}` };
  }
}

export async function runDoctorChecks(
  config: DevBrainConfig,
): Promise<ReadonlyArray<DoctorCheck>> {
  const checks: DoctorCheck[] = [];

  checks.push({
    name: "adapter_mode",
    ok: true,
    detail: config.adapterMode,
  });

  // v0.9.0+: native backend 唯一生产路径,doctor 只看本地 CLI / API key
  // 老 cc-connect UDS 路径需要显式传 CC_CONNECT_FACTORIES 才生效,不再做预检
  if (config.agentBackend === "native" && config.adapterMode === "live") {
    const claude = await checkBinary(config.claudeBin);
    checks.push({
      name: "native_claude_binary",
      ok: claude.ok,
      detail: claude.detail,
      nextStep: NEXT_STEPS.native_claude_binary,
    });

    const codex = await checkBinary(config.codexBin);
    checks.push({
      name: "native_codex_binary",
      ok: codex.ok,
      detail: codex.detail,
      nextStep: NEXT_STEPS.native_codex_binary,
    });

    const hasKey = Boolean(config.claudeApiKey || config.codexApiKey);
    checks.push({
      name: "native_minimax_key",
      ok: hasKey,
      detail: hasKey
        ? `set (claude=${config.claudeApiKey ? "y" : "n"}, codex=${config.codexApiKey ? "y" : "n"})`
        : "$MINIMAX_API_KEY / $ANTHROPIC_API_KEY 未设置",
      nextStep: NEXT_STEPS.native_minimax_key,
    });

    // v0.8.1: cursor local CLI
    const cursor = await checkBinary(config.cursorBin);
    checks.push({
      name: "native_cursor_binary",
      ok: cursor.ok,
      detail: cursor.detail,
      nextStep: NEXT_STEPS.native_cursor_binary,
    });
  }

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
      : "missing — live cursor uses local cursor-agent CLI",
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
