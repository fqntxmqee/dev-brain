/**
 * 轻量 metrics 计数器（CAP-OBS-01 / T-37）。
 * - 无外部依赖；Map<name, Counter>
 * - 线程安全由 JS 单线程保证
 * - 可选: 通过 getMetricsText() 导出 Prometheus 文本格式
 */
export interface CounterSnapshot {
  readonly name: string;
  readonly value: number;
  readonly help: string;
}

const COUNTER_HELP: Readonly<Record<string, string>> = {
  "brain.tasks.completed": "Total tasks completed (success + failure)",
  "brain.tasks.failed": "Total tasks failed",
  "brain.tasks.overwrite": "Number of pendingByChat overwrites",
  "adapter.sent": "Total adapter.send invocations",
  "adapter.failed": "Total adapter.send failures",
  "adapter.cancelled": "Total adapter.cancel calls",
  "bridge.ws.retry": "Total bridge WebSocket retries",
  "bridge.http.fallback": "Total fallbacks from WS to HTTP",
  "gateway.messages.deduped": "Total duplicate messages suppressed",
  "gateway.messages.rejected_oversize": "Total messages rejected for >4KB",
  "postmortem.written": "Total postmortem.json files written",
  "postmortem.write_failed": "Total postmortem write failures",
};

class Counter {
  private value = 0;
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(by = 1): void {
    this.value += by;
  }
  get(): number {
    return this.value;
  }
}

export class MetricsRegistry {
  private readonly counters = new Map<string, Counter>();

  inc(name: keyof typeof COUNTER_HELP, by = 1): void {
    const c = this.getOrCreate(name as string);
    c.inc(by);
  }

  get(name: string): number {
    return this.counters.get(name)?.get() ?? 0;
  }

  snapshot(): ReadonlyArray<CounterSnapshot> {
    return [...this.counters.values()].map((c) => ({
      name: c.name,
      value: c.get(),
      help: c.help,
    }));
  }

  /** Prometheus 文本格式（无外部依赖） */
  getMetricsText(): string {
    const lines: string[] = [];
    for (const c of this.counters.values()) {
      lines.push(`# HELP ${c.name} ${c.help}`);
      lines.push(`# TYPE ${c.name} counter`);
      lines.push(`${c.name} ${c.get()}`);
    }
    return `${lines.join("\n")}\n`;
  }

  private getOrCreate(name: string): Counter {
    let c = this.counters.get(name);
    if (!c) {
      c = new Counter(name, COUNTER_HELP[name] ?? "");
      this.counters.set(name, c);
    }
    return c;
  }
}

/** 全局单例（CLI 启动时挂载） */
let globalRegistry: MetricsRegistry | undefined;
export function getMetrics(): MetricsRegistry {
  if (!globalRegistry) globalRegistry = new MetricsRegistry();
  return globalRegistry;
}

export function resetMetrics(): void {
  globalRegistry = undefined;
}
