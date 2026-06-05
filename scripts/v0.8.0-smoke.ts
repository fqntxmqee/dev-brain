/**
 * v0.8.0 smoke test: spawn `claude` directly via LocalClaudeCodeAdapter
 * and verify it returns real output.
 *
 * Run: `pnpm tsx scripts/v0.8.0-smoke.ts` (uses .env defaults; live mode)
 */
import { loadConfig } from "../src/config/env.js";
import { LocalClaudeCodeAdapter } from "../src/adapters/local-claude-code-adapter.js";

(async () => {
  const config = loadConfig();
  console.log("[smoke] config:", {
    adapterMode: config.adapterMode,
    agentBackend: config.agentBackend,
    claudeBin: config.claudeBin,
    claudeModel: config.claudeModel,
    hasKey: Boolean(config.claudeApiKey),
  });

  const adapter = new LocalClaudeCodeAdapter({
    claudeBin: config.claudeBin,
    claudeApiKey: config.claudeApiKey,
    claudeBaseUrl: config.claudeBaseUrl,
    claudeModel: config.claudeModel,
    claudePermissionMode: config.claudePermissionMode,
    claudeExtraArgs: config.claudeExtraArgs,
    nativeTimeoutMs: 60_000,
    adapterMode: "live",
  });

  console.log("[smoke] runtime:", adapter.runtime);
  const start = Date.now();
  let progressCount = 0;

  for await (const ev of adapter.send({
    prompt: "用一句话回答：2+2=?",
    workDir: "/tmp",
    sessionKey: "v0.8.0-smoke",
  })) {
    if (ev.type === "progress") progressCount++;
    if (ev.type === "done" || ev.type === "error") {
      console.log(
        `[smoke] event=${ev.type} (${Date.now() - start}ms, progress=${progressCount})`,
      );
      console.log(`[smoke] content: ${ev.content.slice(0, 500)}`);
    }
  }
})();
