/**
 * 轻量 metrics 注册表（CAP-OBS-01 / T-37 / T-38 / v0.7.0）。
 *
 * - 无外部依赖；三种 metric 类型：Counter / Gauge / Histogram
 * - 线程安全由 JS 单线程保证
 * - 文本导出（Prometheus 文本格式，无外部依赖）
 * - 通过 getMetricsText() 暴露给 HTTP /metrics endpoint
 *
 * 设计原则：
 * - 后向兼容 v0.6.0：inc/get/snapshot/getMetricsText 接口不变
 * - Fail-soft：通过 safe<T>() 包装调用方永远不会因 metrics 抛错
 * - 预声明：所有已知 metric 在 registry 首次访问时注册（getMetricsText
 *   即使零观测值也会输出全部 27 个 series）
 */

import type { Logger } from "../core/logger.js";

export interface CounterSnapshot {
  readonly name: string;
  readonly value: number;
  readonly help: string;
}

export interface GaugeSnapshot {
  readonly name: string;
  readonly value: number;
  readonly help: string;
}

export interface HistogramSnapshot {
  readonly name: string;
  readonly help: string;
  readonly buckets: ReadonlyArray<{
    readonly le: number;
    readonly count: number;
  }>;
  readonly count: number;
  readonly sum: number;
}

const COUNTER_HELP: Readonly<Record<string, string>> = {
  "brain.tasks.completed": "Total tasks completed (success + failure)",
  "brain.tasks.failed": "Total tasks failed",
  "brain.tasks.overwrite": "Number of pendingByChat overwrites",
  "brain.subtasks.retried": "Total sub-task retries executed",
  "adapter.sent": "Total adapter.send invocations",
  "adapter.failed": "Total adapter.send failures",
  "adapter.cancelled": "Total adapter.cancel calls",
  "bridge.ws.retry": "Total bridge WebSocket retries",
  "bridge.http.fallback": "Total fallbacks from WS to HTTP",
  "gateway.messages.received": "Total Feishu messages received",
  "gateway.messages.deduped": "Total duplicate messages suppressed",
  "gateway.messages.rejected_oversize": "Total messages rejected for >4KB",
  "gateway.card.action": "Total card actions received (approve/cancel)",
  "file.lock.acquired.read": "Total read locks acquired",
  "file.lock.acquired.write": "Total write locks acquired",
  "file.lock.conflicts": "Total LockConflictError thrown",
  "file.lock.released": "Total locks released",
  "file.lock.expired": "Total locks expired by background sweeper",
  "postmortem.written": "Total postmortem.json files written",
  "postmortem.write_failed": "Total postmortem write failures",
  "http.metrics.requests": "Total HTTP /metrics requests",
  "http.healthz.requests": "Total HTTP /healthz requests",
  "http.readyz.requests": "Total HTTP /readyz requests",
  "http.404.requests": "Total HTTP requests to unknown path",
};

const GAUGE_HELP: Readonly<Record<string, string>> = {
  "brain.pending_plans": "Current number of plans awaiting approval",
  "brain.active_tasks": "Current number of tasks actively executing",
  "brain.active_subtasks": "Current number of sub-tasks in executing state",
  "file.lock.held": "Current number of held file locks (read+write)",
  "cc.socket.reachable": "1 if cc-connect socket is reachable, 0 otherwise",
  "process.heap_bytes": "Node.js V8 heap used in bytes",
  "process.rss_bytes": "Node.js resident set size in bytes",
  "process.uptime_seconds": "Process uptime in seconds",
  "process.eventloop_lag_seconds": "Event loop lag p99 in seconds",
};

const HISTOGRAM_HELP: Readonly<Record<string, string>> = {
  "brain.task.duration_seconds":
    "End-to-end task duration (approveAndExecute) in seconds",
  "brain.subtask.duration_seconds":
    "Per sub-task execution duration in seconds",
  "cc.send.duration_seconds":
    "cc-connect send() call duration (live mode) in seconds",
  "gateway.message.duration_seconds":
    "Feishu message handling duration in seconds",
};

const DEFAULT_BUCKETS_SECONDS: readonly number[] = [
  0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300,
];

export class Counter {
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

export class Gauge {
  private value = 0;
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  set(n: number): void {
    this.value = n;
  }
  inc(by = 1): void {
    this.value += by;
  }
  dec(by = 1): void {
    this.value -= by;
  }
  get(): number {
    return this.value;
  }
}

export class Histogram {
  private _count = 0;
  private _sum = 0;
  private readonly _counts: number[];
  readonly buckets: readonly number[];

  constructor(
    readonly name: string,
    readonly help: string,
    buckets: readonly number[] = DEFAULT_BUCKETS_SECONDS,
  ) {
    this.buckets = buckets;
    this._counts = new Array(buckets.length).fill(0);
  }

  observe(v: number): void {
    if (!Number.isFinite(v) || v < 0) return;
    this._count += 1;
    this._sum += v;
    for (let i = 0; i < this.buckets.length; i += 1) {
      const le = this.buckets[i];
      if (le === undefined) continue;
      if (v <= le) {
        const cur = this._counts[i] ?? 0;
        this._counts[i] = cur + 1;
      }
    }
  }

  /** 启动计时器；返回的函数调用时记录从现在起经过的秒数（可加 extra） */
  startTimer(): (extra?: number) => number {
    const start = process.hrtime.bigint();
    return (extra = 0): number => {
      const elapsedNs = process.hrtime.bigint() - start;
      const elapsedSec = Number(elapsedNs) / 1e9 + extra;
      this.observe(elapsedSec);
      return elapsedSec;
    };
  }

  count(): number {
    return this._count;
  }
  sum(): number {
    return this._sum;
  }
  /** 返回第 i 个 bucket 的累计计数 */
  bucketCount(i: number): number {
    return this._counts[i] ?? 0;
  }
}

/** Fail-soft helper: any throw inside fn() is swallowed, fallback returned. */
export function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export class MetricsRegistry {
  private readonly counters = new Map<string, Counter>();
  private readonly gauges = new Map<string, Gauge>();
  private readonly histograms = new Map<string, Histogram>();

  // ----- registration (idempotent) -----

  registerCounter(name: string, help?: string): Counter {
    let c = this.counters.get(name);
    if (!c) {
      c = new Counter(name, help ?? COUNTER_HELP[name] ?? "");
      this.counters.set(name, c);
    }
    return c;
  }

  registerGauge(name: string, help?: string): Gauge {
    let g = this.gauges.get(name);
    if (!g) {
      g = new Gauge(name, help ?? GAUGE_HELP[name] ?? "");
      this.gauges.set(name, g);
    }
    return g;
  }

  registerHistogram(
    name: string,
    help?: string,
    buckets: readonly number[] = DEFAULT_BUCKETS_SECONDS,
  ): Histogram {
    let h = this.histograms.get(name);
    if (!h) {
      h = new Histogram(name, help ?? HISTOGRAM_HELP[name] ?? "", buckets);
      this.histograms.set(name, h);
    }
    return h;
  }

  /** 预声明所有已知 metrics（v0.7.0 起步：27 个 series） */
  registerAll(): void {
    for (const name of Object.keys(COUNTER_HELP)) {
      this.registerCounter(name);
    }
    for (const name of Object.keys(GAUGE_HELP)) {
      this.registerGauge(name);
    }
    for (const name of Object.keys(HISTOGRAM_HELP)) {
      this.registerHistogram(name);
    }
  }

  // ----- accessors (auto-register on first access) -----

  inc(name: string, by = 1): void {
    this.registerCounter(name).inc(by);
  }

  get(name: string): number {
    return this.counters.get(name)?.get() ?? 0;
  }

  gauge(name: string): Gauge {
    return this.registerGauge(name);
  }

  histogram(name: string): Histogram {
    return this.registerHistogram(name);
  }

  // ----- snapshots -----

  snapshot(): ReadonlyArray<CounterSnapshot> {
    return [...this.counters.values()].map((c) => ({
      name: c.name,
      value: c.get(),
      help: c.help,
    }));
  }

  gaugeSnapshot(): ReadonlyArray<GaugeSnapshot> {
    return [...this.gauges.values()].map((g) => ({
      name: g.name,
      value: g.get(),
      help: g.help,
    }));
  }

  histogramSnapshot(): ReadonlyArray<HistogramSnapshot> {
    return [...this.histograms.values()].map((h) => ({
      name: h.name,
      help: h.help,
      buckets: h.buckets.map((le, i) => ({ le, count: h.bucketCount(i) })),
      count: h.count(),
      sum: h.sum(),
    }));
  }

  /** Prometheus 文本格式（无外部依赖） */
  getMetricsText(): string {
    const lines: string[] = [];
    const counterNames = [...this.counters.keys()].sort();
    for (const name of counterNames) {
      const c = this.counters.get(name);
      if (!c) continue;
      lines.push(`# HELP ${c.name} ${c.help}`);
      lines.push(`# TYPE ${c.name} counter`);
      lines.push(`${c.name} ${c.get()}`);
    }
    const gaugeNames = [...this.gauges.keys()].sort();
    for (const name of gaugeNames) {
      const g = this.gauges.get(name);
      if (!g) continue;
      lines.push(`# HELP ${g.name} ${g.help}`);
      lines.push(`# TYPE ${g.name} gauge`);
      lines.push(`${g.name} ${g.get()}`);
    }
    const histNames = [...this.histograms.keys()].sort();
    for (const name of histNames) {
      const h = this.histograms.get(name);
      if (!h) continue;
      lines.push(`# HELP ${h.name} ${h.help}`);
      lines.push(`# TYPE ${h.name} histogram`);
      for (let i = 0; i < h.buckets.length; i += 1) {
        const le = h.buckets[i];
        if (le === undefined) continue;
        lines.push(
          `${h.name}_bucket{le="${formatLe(le)}"} ${h.bucketCount(i)}`,
        );
      }
      lines.push(`${h.name}_bucket{le="+Inf"} ${h.count()}`);
      lines.push(`${h.name}_sum ${h.sum()}`);
      lines.push(`${h.name}_count ${h.count()}`);
    }
    return `${lines.join("\n")}\n`;
  }

  /** 测试/重置用 */
  clear(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }
}

function formatLe(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return String(v);
}

/** 全局单例（CLI 启动时挂载） */
let globalRegistry: MetricsRegistry | undefined;
export function getMetrics(): MetricsRegistry {
  if (!globalRegistry) {
    globalRegistry = new MetricsRegistry();
    globalRegistry.registerAll();
  }
  return globalRegistry;
}

export function resetMetrics(): void {
  globalRegistry = undefined;
}

export interface ProcessCollectorHandle {
  stop(): void;
}

export interface ProcessCollectorOptions {
  readonly registry: MetricsRegistry;
  readonly intervalMs?: number;
  readonly logger?: Logger;
}

/**
 * 启动 process-level 采集器（heap / rss / uptime / event loop lag）。
 * 返回 { stop() } 句柄；间隔默认 15s，timer 已 .unref() 不阻塞退出。
 */
export function startProcessCollector(
  opts: ProcessCollectorOptions,
): ProcessCollectorHandle {
  const { registry, logger } = opts;
  const intervalMs = opts.intervalMs ?? 15_000;
  const heapGauge = registry.gauge("process.heap_bytes");
  const rssGauge = registry.gauge("process.rss_bytes");
  const uptimeGauge = registry.gauge("process.uptime_seconds");
  const lagGauge = registry.gauge("process.eventloop_lag_seconds");

  type Monitor = ReturnType<
    typeof import("node:perf_hooks").monitorEventLoopDelay
  >;
  let monitor: Monitor | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const perfHooks =
      require("node:perf_hooks") as typeof import("node:perf_hooks");
    monitor = perfHooks.monitorEventLoopDelay({ resolution: 20 });
    monitor.enable();
  } catch (err) {
    safe(() => {
      logger?.warn("process_collector: monitorEventLoopDelay unavailable", {
        err: err instanceof Error ? err.message : String(err),
      });
    }, undefined);
  }

  const tick = (): void => {
    safe(() => {
      const mem = process.memoryUsage();
      heapGauge.set(mem.heapUsed);
      rssGauge.set(mem.rss);
      uptimeGauge.set(process.uptime());
      if (monitor) {
        const p99Ns = monitor.percentile(99);
        const p99Sec = Number(p99Ns) / 1e9;
        lagGauge.set(p99Sec);
      }
    }, undefined);
  };

  // 立即采一次，避免 /metrics 启动后前 15s 都是 0
  tick();
  const handle = setInterval(tick, intervalMs);
  if (typeof handle.unref === "function") handle.unref();

  return {
    stop(): void {
      clearInterval(handle);
      if (monitor) {
        try {
          monitor.disable();
          monitor.reset();
        } catch {
          // intentional swallow
        }
        monitor = null;
      }
    },
  };
}
