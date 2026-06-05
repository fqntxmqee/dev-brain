import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Smoke test: 启动 cli.js (tsx via tsx loader) 后用 child_process
 * 触发 start --dry-run，断言输出包含 metrics 配置行。
 *
 * 不真正运行 lark-cli（start 完整路径会走 doctor 预检，需要 feishu/cc-connect 套接字）。
 *
 * 注意：MetricsServer 的实时集成测试由 tests/unit/metrics-server.test.ts 覆盖
 * （in-process，无 child spawn，CI 稳定）。本文件仅验证 CLI 端的 dry-run 行为。
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_PATH = join(__dirname, "../../src/cli/cli.ts");

function runDryRun(extraEnv: Record<string, string> = {}): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  return new Promise((resolve) => {
    const child = spawn(
      "node",
      ["--import", "tsx", CLI_PATH, "start", "--dry-run"],
      {
        env: { ...process.env, ...extraEnv },
        cwd: join(__dirname, "../.."),
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}

describe("cli start --dry-run shows metrics config (v0.7.0)", () => {
  it("prints_metrics_line_in_default_mode", async () => {
    const res = await runDryRun();
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("metrics:");
    expect(res.stdout).toContain(":9090");
  });

  it("honors_metrics_port_env", async () => {
    const res = await runDryRun({ DEV_BRAIN_METRICS_PORT: "8765" });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(":8765");
  });

  it("shows_disabled_when_metrics_env_is_0", async () => {
    const res = await runDryRun({ DEV_BRAIN_METRICS_ENABLED: "0" });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("metrics: disabled");
  });
});
