/**
 * 优雅关闭：监听 SIGTERM / SIGINT，给各模块留出清理窗口。
 *
 * 使用：
 *   const shutdown = new GracefulShutdown({ timeoutMs: 10_000 });
 *   shutdown.register('gateway', async () => { ... });
 *   shutdown.onSignal();
 */

export type CleanupTask = () => void | Promise<void>;

export interface ShutdownOptions {
  readonly timeoutMs: number;
  readonly logger?: (msg: string) => void;
}

export class GracefulShutdown {
  private readonly tasks = new Map<string, CleanupTask>();
  private shuttingDown = false;

  constructor(private readonly options: ShutdownOptions) {}

  register(name: string, task: CleanupTask): void {
    this.tasks.set(name, task);
  }

  onSignal(): void {
    const handler = (sig: NodeJS.Signals): void => {
      void this.run(sig);
    };
    process.once("SIGTERM", handler);
    process.once("SIGINT", handler);
  }

  async run(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.log(`received ${signal}, running ${this.tasks.size} cleanup tasks`);

    const timer = setTimeout(() => {
      this.log(
        `cleanup timeout after ${this.options.timeoutMs}ms, forcing exit`,
      );
      process.exit(1);
    }, this.options.timeoutMs);
    timer.unref();

    for (const [name, task] of this.tasks) {
      try {
        await task();
        this.log(`  ✓ ${name}`);
      } catch (err) {
        this.log(
          `  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    clearTimeout(timer);
    this.log("graceful shutdown complete");
    process.exit(0);
  }

  private log(msg: string): void {
    if (this.options.logger) {
      this.options.logger(`[shutdown] ${msg}`);
    }
  }
}
