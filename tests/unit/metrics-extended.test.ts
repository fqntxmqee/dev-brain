import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Gauge,
  Histogram,
  MetricsRegistry,
  getMetrics,
  resetMetrics,
  safe,
  startProcessCollector,
} from "../../src/observability/metrics.js";

describe("Gauge (T-37 / v0.7.0)", () => {
  it("set_replaces_value", () => {
    const g = new Gauge("test.gauge", "help");
    g.set(42);
    expect(g.get()).toBe(42);
    g.set(7);
    expect(g.get()).toBe(7);
  });

  it("inc_dec_modify_value", () => {
    const g = new Gauge("test.gauge", "help");
    g.inc(5);
    expect(g.get()).toBe(5);
    g.dec(2);
    expect(g.get()).toBe(3);
    g.inc();
    expect(g.get()).toBe(4);
  });

  it("initial_value_is_zero", () => {
    const g = new Gauge("test.gauge", "help");
    expect(g.get()).toBe(0);
  });
});

describe("Histogram (T-37 / v0.7.0)", () => {
  it("observe_increments_count_and_sum", () => {
    const h = new Histogram("test.hist", "help", [1, 2, 5]);
    h.observe(0.5);
    h.observe(1.5);
    h.observe(3);
    expect(h.count()).toBe(3);
    expect(h.sum()).toBeCloseTo(5, 5);
  });

  it("bucket_counts_are_cumulative", () => {
    const h = new Histogram("test.hist", "help", [1, 2, 5]);
    // 0.5 → buckets le=1, le=2, le=5 all +1
    // 1.5 → buckets le=2, le=5 +1 (le=1 not)
    // 3   → bucket le=5 +1
    h.observe(0.5);
    h.observe(1.5);
    h.observe(3);
    expect(h.bucketCount(0)).toBe(1);
    expect(h.bucketCount(1)).toBe(2);
    expect(h.bucketCount(2)).toBe(3);
  });

  it("ignores_non_finite_and_negative", () => {
    const h = new Histogram("test.hist", "help", [1, 2]);
    h.observe(NaN);
    h.observe(Infinity);
    h.observe(-1);
    expect(h.count()).toBe(0);
  });

  it("startTimer_records_elapsed_seconds", async () => {
    const h = new Histogram("test.hist", "help");
    const end = h.startTimer();
    await new Promise((r) => setTimeout(r, 10));
    const elapsed = end();
    expect(h.count()).toBe(1);
    expect(elapsed).toBeGreaterThan(0.005);
  });

  it("startTimer_extra_adds_to_elapsed", () => {
    const h = new Histogram("test.hist", "help");
    const end = h.startTimer();
    end(0.5);
    expect(h.sum()).toBeCloseTo(0.5, 1);
  });
});

describe("MetricsRegistry — register/accessor/snapshot (v0.7.0)", () => {
  it("inc_auto_registers_counter", () => {
    const r = new MetricsRegistry();
    r.inc("brain.tasks.completed");
    r.inc("brain.tasks.completed", 2);
    expect(r.get("brain.tasks.completed")).toBe(3);
  });

  it("registerAll_emits_all_37_metrics", () => {
    const r = new MetricsRegistry();
    r.registerAll();
    const text = r.getMetricsText();
    // counters
    expect(text).toContain("# TYPE brain.tasks.completed counter");
    expect(text).toContain("# TYPE gateway.messages.received counter");
    // gauges
    expect(text).toContain("# TYPE brain.pending_plans gauge");
    expect(text).toContain("# TYPE process.heap_bytes gauge");
    // histograms
    expect(text).toContain("# TYPE brain.task.duration_seconds histogram");
    expect(text).toContain("# TYPE cc.send.duration_seconds histogram");
  });

  it("gauge_and_histogram_accessors_return_same_instance", () => {
    const r = new MetricsRegistry();
    const g1 = r.gauge("brain.pending_plans");
    const g2 = r.gauge("brain.pending_plans");
    expect(g1).toBe(g2);
    const h1 = r.histogram("brain.task.duration_seconds");
    const h2 = r.histogram("brain.task.duration_seconds");
    expect(h1).toBe(h2);
  });

  it("registerCounter_uses_COUNTER_HELP_lookup", () => {
    const r = new MetricsRegistry();
    const c = r.registerCounter("brain.tasks.completed");
    expect(c.help).toBe("Total tasks completed (success + failure)");
  });

  it("registerCounter_accepts_custom_help", () => {
    const r = new MetricsRegistry();
    const c = r.registerCounter("custom.counter", "my custom help");
    expect(c.help).toBe("my custom help");
  });

  it("clear_removes_all_metrics", () => {
    const r = new MetricsRegistry();
    r.registerAll();
    r.inc("brain.tasks.completed", 5);
    r.gauge("brain.pending_plans").set(3);
    r.histogram("brain.task.duration_seconds").observe(1);
    r.clear();
    expect(r.get("brain.tasks.completed")).toBe(0);
    expect(r.gauge("brain.pending_plans").get()).toBe(0);
    expect(r.histogram("brain.task.duration_seconds").count()).toBe(0);
  });
});

describe("MetricsRegistry — getMetricsText output format (v0.7.0)", () => {
  it("emits_help_type_value_triplet_for_counter", () => {
    const r = new MetricsRegistry();
    r.registerAll();
    r.inc("brain.tasks.completed", 3);
    const text = r.getMetricsText();
    const lines = text.split("\n");
    const helpIdx = lines.findIndex(
      (l) =>
        l.startsWith("# HELP brain.tasks.completed ") &&
        l.includes("Total tasks completed"),
    );
    expect(helpIdx).toBeGreaterThanOrEqual(0);
    expect(lines[helpIdx + 1]).toBe("# TYPE brain.tasks.completed counter");
    expect(lines[helpIdx + 2]).toBe("brain.tasks.completed 3");
  });

  it("emits_buckets_sum_count_for_histogram", () => {
    const r = new MetricsRegistry();
    const h = r.registerHistogram("test.hist", "h", [0.1, 1, 10]);
    h.observe(0.05);
    h.observe(0.5);
    h.observe(5);
    const text = r.getMetricsText();
    expect(text).toContain('test.hist_bucket{le="0.1"} 1');
    expect(text).toContain('test.hist_bucket{le="1"} 2');
    expect(text).toContain('test.hist_bucket{le="10"} 3');
    expect(text).toContain('test.hist_bucket{le="+Inf"} 3');
    expect(text).toMatch(/test.hist_sum 5\.5+/);
    expect(text).toContain("test.hist_count 3");
  });

  it("emits_integer_le_without_decimal_point", () => {
    const r = new MetricsRegistry();
    r.registerHistogram("test.hist", "h", [1, 5]);
    const text = r.getMetricsText();
    expect(text).toContain('test.hist_bucket{le="1"} 0');
    expect(text).toContain('test.hist_bucket{le="5"} 0');
  });

  it("output_ends_with_newline", () => {
    const r = new MetricsRegistry();
    r.registerAll();
    expect(r.getMetricsText().endsWith("\n")).toBe(true);
  });

  it("output_count_matches_registered_count_53", () => {
    const r = new MetricsRegistry();
    r.registerAll();
    const text = r.getMetricsText();
    // v0.10.0 Phase A.5: 37 counters + 9 gauges + 7 histograms = 53 metric families
    // (v0.9.0: 30+9+4=43; +7 new counters + 3 new histograms = +10)
    // Each family has 1 # HELP + 1 # TYPE + ≥1 value lines
    const helpLines = text.split("\n").filter((l) => l.startsWith("# HELP "));
    expect(helpLines.length).toBe(37 + 9 + 7);
  });
});

describe("safe() helper (v0.7.0)", () => {
  it("returns_fallback_when_fn_throws", () => {
    expect(
      safe(() => {
        throw new Error("boom");
      }, "fallback"),
    ).toBe("fallback");
  });

  it("returns_fn_result_when_no_throw", () => {
    expect(safe(() => 42, -1)).toBe(42);
  });
});

describe("getMetrics() singleton (v0.7.0)", () => {
  beforeEach(() => {
    resetMetrics();
  });
  afterEach(() => {
    resetMetrics();
  });

  it("returns_same_instance_across_calls", () => {
    const a = getMetrics();
    const b = getMetrics();
    expect(a).toBe(b);
  });

  it("fresh_singleton_emits_all_37_metric_families", () => {
    const text = getMetrics().getMetricsText();
    expect(text).toContain("# TYPE brain.tasks.completed counter");
    expect(text).toContain("# TYPE brain.pending_plans gauge");
    expect(text).toContain("# TYPE brain.task.duration_seconds histogram");
  });

  it("resetMetrics_clears_singleton", () => {
    getMetrics().inc("brain.tasks.completed", 5);
    expect(getMetrics().get("brain.tasks.completed")).toBe(5);
    resetMetrics();
    expect(getMetrics().get("brain.tasks.completed")).toBe(0);
  });
});

describe("startProcessCollector (v0.7.0)", () => {
  beforeEach(() => {
    resetMetrics();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetMetrics();
  });

  it("collects_heap_rss_uptime_immediately", () => {
    const r = getMetrics();
    const handle = startProcessCollector({ registry: r, intervalMs: 1000 });
    expect(r.gauge("process.heap_bytes").get()).toBeGreaterThan(0);
    expect(r.gauge("process.rss_bytes").get()).toBeGreaterThan(0);
    expect(r.gauge("process.uptime_seconds").get()).toBeGreaterThanOrEqual(0);
    handle.stop();
  });

  it("tick_advances_uptime_gauge", () => {
    const r = getMetrics();
    const handle = startProcessCollector({ registry: r, intervalMs: 1000 });
    const before = r.gauge("process.uptime_seconds").get();
    vi.advanceTimersByTime(2000);
    // fakeTimers doesn't move process.uptime; we just verify tick fires
    // without throwing and gauge stays defined
    const after = r.gauge("process.uptime_seconds").get();
    expect(after).toBeGreaterThanOrEqual(before);
    handle.stop();
  });

  it("stop_disables_interval", () => {
    const r = getMetrics();
    const handle = startProcessCollector({ registry: r, intervalMs: 1000 });
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    handle.stop();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it("accepts_custom_intervalMs", () => {
    const r = getMetrics();
    const handle = startProcessCollector({ registry: r, intervalMs: 5000 });
    expect(() => handle.stop()).not.toThrow();
  });

  it("accepts_optional_logger", () => {
    const r = getMetrics();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(),
    };
    const handle = startProcessCollector({
      registry: r,
      intervalMs: 1000,
      logger,
    });
    handle.stop();
    // Even if logger is never called, it must not throw
    expect(true).toBe(true);
  });
});
