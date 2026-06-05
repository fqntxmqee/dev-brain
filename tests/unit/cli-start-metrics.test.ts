import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

/**
 * Smoke test: 启动 cli.js (tsx via tsx loader) 后用 child_process
 * 触发 start --dry-run，断言输出包含 metrics 配置行。
 *
 * 不真正运行 lark-cli（start 完整路径会走 doctor 预检，需要 feishu/cc-connect 套接字）。
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

describe("cli start --dry-run shows metrics config", () => {
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

/**
 * Smoke test: 启动 metrics server 单独可访问。
 * 直接构造 MetricsServer（避免 cli 完整启动路径），
 * 验证 start 后的 endpoint 在真实端口上工作。
 */
describe("MetricsServer live integration (v0.7.0)", () => {
  let child: ChildProcess | undefined;

  afterEach(() => {
    if (child) {
      child.kill("SIGTERM");
      child = undefined;
    }
  });

  it("responds_to_healthz_metrics_readyz", { timeout: 30_000 }, async () => {
    const port = 19_000 + Math.floor(Math.random() * 1_000);
    const script = `
      import { MetricsServer } from "/Users/fukai/workspace/dev-brain/src/observability/metrics-server.ts";
      import { getMetrics } from "/Users/fukai/workspace/dev-brain/src/observability/metrics.ts";
      const ms = new MetricsServer({ port: ${port}, host: "127.0.0.1", registry: getMetrics() });
      const h = await ms.start();
      console.log("PORT=" + h.port);
      setTimeout(() => h.close(), 5000);
    `;
    const scriptPath = join(tmpdir(), `metrics-smoke-${Date.now()}.mjs`);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(scriptPath, script, "utf8");

    child = spawn("node", ["--import", "tsx", scriptPath]);
    let stdout = "";
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });

    // wait for PORT= line
    const resolvedPort = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("metrics server boot timeout")),
        15_000,
      );
      const handler = setInterval(() => {
        const m = stdout.match(/PORT=(\d+)/);
        if (m) {
          clearTimeout(t);
          clearInterval(handler);
          resolve(Number(m[1]));
        }
      }, 100);
    });

    const r1 = await fetch(`http://127.0.0.1:${resolvedPort}/healthz`);
    expect(r1.status).toBe(200);
    expect(await r1.text()).toContain("ok");

    const r2 = await fetch(`http://127.0.0.1:${resolvedPort}/readyz`);
    expect(r2.status).toBe(200);

    const r3 = await fetch(`http://127.0.0.1:${resolvedPort}/metrics`);
    expect(r3.status).toBe(200);
    const body = await r3.text();
    expect(body).toContain("adapter.cancelled");
    expect(body.split("\n").length).toBeGreaterThan(50);

    if (existsSync(scriptPath)) unlinkSync(scriptPath);
  });
});
