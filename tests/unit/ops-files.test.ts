import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = join(__dirname, "../..");

describe("ops/grafana/dev-brain-dashboard.json (v0.7.0)", () => {
  const path = join(REPO, "ops/grafana/dev-brain-dashboard.json");
  const raw = readFileSync(path, "utf8");
  const dash = JSON.parse(raw) as {
    title: string;
    panels: ReadonlyArray<{ id: number; title: string; type: string }>;
    refresh: string;
    tags: ReadonlyArray<string>;
  };

  it("exists and is valid JSON", () => {
    expect(existsSync(path)).toBe(true);
    expect(typeof raw).toBe("string");
  });

  it("has v0.7.0 title and tags", () => {
    expect(dash.title).toContain("v0.7.0");
    expect(dash.tags).toContain("dev-brain");
  });

  it("has 12 panels covering all key metrics", () => {
    expect(dash.panels).toHaveLength(12);
    const titles = dash.panels.map((p) => p.title);
    expect(titles).toContain("Brain Tasks Throughput");
    expect(titles).toContain("Brain Task Failure Rate (5m)");
    expect(titles).toContain("Brain Task Duration (p50/p95/p99)");
    expect(titles).toContain("Brain Subtask p95 Duration");
    expect(titles).toContain("cc-connect Send p95");
    expect(titles).toContain("Adapter sent vs failed (5m)");
    expect(titles).toContain("File Lock Held & Conflicts");
    expect(titles).toContain("cc-connect Socket Reachable");
    expect(titles).toContain("Process Memory (heap / rss)");
    expect(titles).toContain("Event Loop Lag (p99)");
    expect(titles).toContain("HTTP Request Rate by Endpoint");
    expect(titles).toContain("Brain Pending / Active");
  });
});

describe("ops/alerts/dev-brain-rules.yml (v0.7.0)", () => {
  const path = join(REPO, "ops/alerts/dev-brain-rules.yml");
  const raw = readFileSync(path, "utf8");

  it("exists and contains the 7 alert names from the runbook", () => {
    expect(existsSync(path)).toBe(true);
    const expected = [
      "BrainHighFailureRate",
      "BrainStuckTask",
      "CcConnectSocketDown",
      "FileLockContention",
      "ProcessOomRisk",
      "EventLoopLag",
      "AdapterAllFailed",
    ];
    for (const name of expected) {
      expect(raw).toContain(`alert: ${name}`);
    }
  });

  it("declares severity labels for paging/warning rules", () => {
    expect(raw).toContain("severity: page");
    expect(raw).toContain("severity: warn");
  });
});
