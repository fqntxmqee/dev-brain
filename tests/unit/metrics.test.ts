import { describe, expect, it, beforeEach } from "vitest";
import {
  MetricsRegistry,
  resetMetrics,
  getMetrics,
} from "../../src/observability/metrics.js";

describe("MetricsRegistry (T-37)", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("inc/get snapshots counters", () => {
    const m = new MetricsRegistry();
    m.inc("brain.tasks.completed");
    m.inc("brain.tasks.completed", 4);
    m.inc("brain.tasks.failed");
    expect(m.get("brain.tasks.completed")).toBe(5);
    expect(m.get("brain.tasks.failed")).toBe(1);
    expect(m.get("nonexistent")).toBe(0);
  });

  it("getMetricsText emits prometheus text format", () => {
    const m = new MetricsRegistry();
    m.inc("adapter.sent", 7);
    const text = m.getMetricsText();
    expect(text).toContain("# HELP adapter.sent");
    expect(text).toContain("# TYPE adapter.sent counter");
    expect(text).toContain("adapter.sent 7");
  });

  it("global getMetrics returns a singleton", () => {
    const a = getMetrics();
    const b = getMetrics();
    expect(a).toBe(b);
    a.inc("brain.tasks.completed");
    expect(b.get("brain.tasks.completed")).toBe(1);
  });

  it("snapshot returns array of {name,value,help}", () => {
    const m = new MetricsRegistry();
    m.inc("postmortem.written", 3);
    const snap = m.snapshot();
    const entry = snap.find((s) => s.name === "postmortem.written");
    expect(entry).toBeDefined();
    expect(entry?.value).toBe(3);
  });
});
