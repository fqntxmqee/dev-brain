/**
 * v0.8.0: 本地直接 spawn agent CLI 的 adapter 基类（无 cc-connect 中转）
 *
 * 设计：
 * - 子类提供 `runtime` 字面量 + `buildArgs` + `buildEnv`
 * - 基类负责 spawn / stdout-stderr 捕获 / 超时 / 取消 / 指标 / 日志
 * - 不引入新依赖（用 node:child_process.spawn）
 *
 * 当前子类：
 * - LocalClaudeCodeAdapter → spawn("claude -p ...")
 * - LocalCodexAdapter     → spawn("codex-minimax exec ...")
 */
import { spawn, type ChildProcess } from "node:child_process";
import { getMetrics, safe } from "../observability/metrics.js";
import { defaultLogger, type Logger } from "../core/logger.js";
import type {
  AdapterEvent,
  AdapterRequest,
  AdapterSessionStatus,
  AgentAdapter,
} from "./types.js";
import type { AgentRuntime } from "../core/types.js";
import { redactMessage } from "../core/redact.js";

/** 子类注入的 spawn 配置 */
export interface LocalSpawnConfig {
  readonly bin: string;
  readonly env: Readonly<Record<string, string>>;
  readonly buildArgs: (prompt: string) => ReadonlyArray<string>;
  readonly timeoutMs: number;
  /** v0.8.0: stub 模式短路（yield stub done event，跳过 spawn） */
  readonly adapterMode?: "stub" | "live";
}

export interface LocalSpawnOptions {
  readonly runtime: AgentRuntime;
  readonly config: LocalSpawnConfig;
}

/** 共用进度文本（子类可覆盖） */
function defaultProgressMessage(runtime: string): string {
  return `dispatching to ${runtime} (native)`;
}

export abstract class LocalSpawnAdapter implements AgentAdapter {
  abstract readonly runtime: AgentRuntime;
  protected readonly logger: Logger;
  protected readonly metrics = getMetrics();
  /** sessionKey → child pid（用于 cancel 触发 SIGTERM） */
  private readonly liveProcs = new Map<string, number>();

  constructor(protected readonly options: LocalSpawnOptions) {
    this.logger = defaultLogger.child({
      component: "adapter",
      runtime: this.options.runtime,
    });
  }

  protected get config(): LocalSpawnConfig {
    return this.options.config;
  }

  protected progressMessage(): string {
    return defaultProgressMessage(this.options.runtime);
  }

  async *send(request: AdapterRequest): AsyncIterable<AdapterEvent> {
    const sessionKey = request.sessionKey ?? "(no-session)";

    // v0.8.0: stub 模式短路 — 与 v0.7.0 cc-connect 行为保持一致
    if (this.config.adapterMode === "stub") {
      const now = new Date().toISOString();
      yield {
        type: "progress",
        content: this.progressMessage(),
        timestamp: now,
      };
      safe(() => this.metrics.inc("adapter.sent"), undefined);
      yield {
        type: "done",
        content: `[${this.options.runtime} native stub] workDir=${request.workDir} prompt=${request.prompt.slice(0, 80)}…`,
        timestamp: new Date().toISOString(),
      };
      return;
    }

    const now = new Date().toISOString();
    yield { type: "progress", content: this.progressMessage(), timestamp: now };

    const args = this.config.buildArgs(request.prompt);
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.config.env };
    this.logger.info("spawning agent", {
      bin: this.config.bin,
      args,
      workdir: request.workDir,
      env_keys: Object.keys(this.config.env),
    });

    const endTimer = safe(
      () => this.metrics.histogram("cc.send.duration_seconds").startTimer(),
      () => 0,
    );
    let stdout = "";
    let stderr = "";
    let child: ChildProcess | undefined;
    try {
      child = spawn(this.config.bin, [...args], {
        cwd: request.workDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (child.pid !== undefined) this.liveProcs.set(sessionKey, child.pid);

      const exitCode = await new Promise<number>((resolve, reject) => {
        const killTimer = setTimeout(() => {
          try {
            child?.kill("SIGTERM");
          } catch {
            /* may already be dead */
          }
          reject(
            new Error(
              `${this.options.runtime} timed out after ${this.config.timeoutMs}ms`,
            ),
          );
        }, this.config.timeoutMs);

        child?.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child?.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child?.on("error", (err) => {
          clearTimeout(killTimer);
          reject(err);
        });
        child?.on("close", (code) => {
          clearTimeout(killTimer);
          resolve(code ?? -1);
        });
      });

      this.liveProcs.delete(sessionKey);
      if (exitCode !== 0) {
        safe(() => this.metrics.inc("adapter.failed"), undefined);
        this.logger.warn("agent non-zero exit", {
          exitCode,
          stderr: redactMessage(stderr).slice(0, 500),
        });
        yield {
          type: "error",
          content:
            redactMessage(stderr).trim() ||
            `${this.options.runtime} exited ${exitCode}`,
          timestamp: new Date().toISOString(),
        };
        return;
      }

      safe(() => this.metrics.inc("adapter.sent"), undefined);
      this.logger.info("agent ok", { output_len: stdout.length });
      yield {
        type: "done",
        content: stdout.trim() || "(empty)",
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      safe(() => this.metrics.inc("adapter.failed"), undefined);
      this.logger.error("agent failed", {
        err: err instanceof Error ? err.message : String(err),
        stderr: redactMessage(stderr).slice(0, 500),
      });
      yield {
        type: "error",
        content: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      };
    } finally {
      endTimer();
    }
  }

  async cancel(sessionKey: string, _reason?: string): Promise<void> {
    const pid = this.liveProcs.get(sessionKey);
    if (pid && pid > 0) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* may already be dead */
      }
      this.liveProcs.delete(sessionKey);
    }
    safe(() => this.metrics.inc("adapter.cancelled"), undefined);
  }

  async status(sessionKey: string): Promise<AdapterSessionStatus> {
    const live = this.liveProcs.has(sessionKey);
    return {
      sessionKey,
      state: live ? "running" : "idle",
      lastActivityAt: new Date().toISOString(),
    };
  }
}
