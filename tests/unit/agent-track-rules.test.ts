import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TrackRules } from "../../src/agent/track-rules.js";
import { getMetrics, resetMetrics } from "../../src/observability/metrics.js";
import type { InjectedRule } from "../../src/agent/inject-rules.js";

/** 构造 InjectedRule fixture */
const fakeRule = (path: string, rel: string, body: string): InjectedRule => ({
  path,
  relPath: rel,
  bytes: Buffer.byteLength(body, "utf-8"),
  estTokens: Math.ceil(body.length / 4),
});

describe("TrackRules (CAP-INS-02 / Phase B.2)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "track-rules-"));
    resetMetrics();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("recordAppliedBatch_writes_one_event_per_rule", async () => {
    const tr = new TrackRules({ auditDir: dir });
    const rules = [
      fakeRule("/a/coding.md", "coding.md", "x"),
      fakeRule("/a/test.md", "test.md", "y"),
    ];
    await tr.recordAppliedBatch({ trace_id: "t1", rules });

    const events = await tr.listEvents();
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.event === "applied")).toBe(true);
    expect(events.every((e) => e.trace_id === "t1")).toBe(true);
  });

  it("recordViolation_writes_event_with_evidence_and_detector", async () => {
    const tr = new TrackRules({ auditDir: dir });
    await tr.recordViolation({
      trace_id: "t1",
      rule_path: "/a/coding.md",
      rule_rel: "coding.md",
      evidence: "agent output contained forbidden text",
      detector: "user_flag",
    });
    const events = await tr.listEvents({ event: "violated" });
    expect(events).toHaveLength(1);
    expect(events[0]?.evidence).toContain("forbidden");
    expect(events[0]?.detector).toBe("user_flag");
  });

  it("rotates_files_daily", async () => {
    const tr = new TrackRules({
      auditDir: dir,
      now: () => new Date("2026-06-06T10:00:00.000Z"),
    });
    await tr.recordViolation({
      trace_id: "t1",
      rule_path: "/a/x.md",
      rule_rel: "x.md",
      evidence: "e1",
      detector: "user_flag",
    });
    // 改时间到第二天
    const tr2 = new TrackRules({
      auditDir: dir,
      now: () => new Date("2026-06-07T10:00:00.000Z"),
    });
    await tr2.recordViolation({
      trace_id: "t2",
      rule_path: "/a/x.md",
      rule_rel: "x.md",
      evidence: "e2",
      detector: "user_flag",
    });
    const entries = await fs.readdir(dir);
    const logs = entries.filter(
      (e) => e.startsWith("rules-") && e.endsWith(".jsonl"),
    );
    expect(logs).toEqual(["rules-2026-06-06.jsonl", "rules-2026-06-07.jsonl"]);
  });

  it("listEvents_filters_by_traceId_and_event", async () => {
    const tr = new TrackRules({ auditDir: dir });
    await tr.recordAppliedBatch({
      trace_id: "t1",
      rules: [fakeRule("/a.md", "a.md", "x")],
    });
    await tr.recordAppliedBatch({
      trace_id: "t2",
      rules: [fakeRule("/b.md", "b.md", "y")],
    });
    await tr.recordViolation({
      trace_id: "t1",
      rule_path: "/a.md",
      rule_rel: "a.md",
      evidence: "bad",
      detector: "user_flag",
    });

    expect(await tr.listEvents({ traceId: "t1" })).toHaveLength(2);
    expect(await tr.listEvents({ event: "violated" })).toHaveLength(1);
    expect(await tr.listEvents({ event: "applied" })).toHaveLength(2);
  });

  it("listEvents_sorts_newest_first_and_respects_limit", async () => {
    const tr = new TrackRules({
      auditDir: dir,
      now: () => new Date("2026-06-06T10:00:00.000Z"),
    });
    await tr.recordAppliedBatch({
      trace_id: "t1",
      rules: [fakeRule("/a.md", "a.md", "x")],
    });
    await new Promise((r) => setTimeout(r, 5));
    await tr.recordAppliedBatch({
      trace_id: "t2",
      rules: [fakeRule("/b.md", "b.md", "y")],
    });
    const all = await tr.listEvents();
    expect(all.map((e) => e.trace_id)).toEqual(["t2", "t1"]);
    const limited = await tr.listEvents({ limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0]?.trace_id).toBe("t2");
  });

  it("listEvents_skips_corrupted_lines", async () => {
    const tr = new TrackRules({ auditDir: dir });
    await tr.recordAppliedBatch({
      trace_id: "t1",
      rules: [fakeRule("/a.md", "a.md", "x")],
    });
    // 追加坏行
    const logFile = join(dir, "rules-2026-06-06.jsonl");
    await fs.appendFile(logFile, "not-json\n", "utf-8");
    const events = await tr.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.trace_id).toBe("t1");
  });

  it("listEvents_returns_empty_when_no_files", async () => {
    const tr = new TrackRules({ auditDir: dir });
    expect(await tr.listEvents()).toEqual([]);
  });

  it("recordAppliedBatch_increments_metric", async () => {
    const tr = new TrackRules({ auditDir: dir });
    const m = getMetrics();
    const before = m.get("instruction.rules_applied_total");
    await tr.recordAppliedBatch({
      trace_id: "t1",
      rules: [fakeRule("/a.md", "a.md", "x"), fakeRule("/b.md", "b.md", "y")],
    });
    expect(m.get("instruction.rules_applied_total")).toBe(before + 2);
  });

  it("recordViolation_increments_metric", async () => {
    const tr = new TrackRules({ auditDir: dir });
    const m = getMetrics();
    const before = m.get("instruction.rules_violated_total");
    await tr.recordViolation({
      trace_id: "t1",
      rule_path: "/a.md",
      rule_rel: "a.md",
      evidence: "x",
      detector: "user_flag",
    });
    expect(m.get("instruction.rules_violated_total")).toBe(before + 1);
  });

  it("detectViolations_extracts_english_NEVER_patterns", async () => {
    const rulePath = join(dir, "rule.md");
    await fs.writeFile(
      rulePath,
      ["# Rule", "- NEVER: print debug", "- NEVER: use console.log"].join("\n"),
      "utf-8",
    );
    const rule = fakeRule(rulePath, "rule.md", "");
    const tr = new TrackRules({ auditDir: dir });
    const out = await tr.detectViolations("I will print debug now", [rule]);
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[0]?.pattern).toContain("print debug");
  });

  it("detectViolations_extracts_chinese_禁止_pattern", async () => {
    const rulePath = join(dir, "rule.md");
    await fs.writeFile(rulePath, "禁止: 在生产代码里写 console.log", "utf-8");
    const rule = fakeRule(rulePath, "rule.md", "");
    const tr = new TrackRules({ auditDir: dir });
    const out = await tr.detectViolations("我在生产代码里写 console.log 输出", [
      rule,
    ]);
    expect(out.length).toBe(1);
    expect(out[0]?.pattern).toContain("console.log");
  });

  it("detectViolations_returns_empty_when_no_match", async () => {
    const rulePath = join(dir, "rule.md");
    await fs.writeFile(rulePath, "NEVER: hardcode secrets", "utf-8");
    const rule = fakeRule(rulePath, "rule.md", "");
    const tr = new TrackRules({ auditDir: dir });
    const out = await tr.detectViolations("Just write clean code", [rule]);
    expect(out).toEqual([]);
  });

  it("detectViolations_skips_unreadable_rule_files", async () => {
    const rule = fakeRule("/nonexistent.md", "x.md", "");
    const tr = new TrackRules({ auditDir: dir });
    const out = await tr.detectViolations("anything", [rule]);
    expect(out).toEqual([]);
  });

  it("recordViolation_truncates_long_evidence", async () => {
    const tr = new TrackRules({ auditDir: dir });
    const big = "x".repeat(1000);
    await tr.recordViolation({
      trace_id: "t1",
      rule_path: "/a.md",
      rule_rel: "a.md",
      evidence: big,
      detector: "user_flag",
    });
    const events = await tr.listEvents({ event: "violated" });
    expect(events[0]?.evidence?.length).toBe(500);
  });
});
