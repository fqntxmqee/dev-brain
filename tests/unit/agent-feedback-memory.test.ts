import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FeedbackMemory } from "../../src/agent/feedback-memory.js";
import { getMetrics, resetMetrics } from "../../src/observability/metrics.js";

describe("FeedbackMemory (CAP-INS-03 / Phase B.3)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "feedback-"));
    resetMetrics();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("recordCorrection_writes_to_daily_jsonl", async () => {
    const fm = new FeedbackMemory({
      auditDir: dir,
      now: () => new Date("2026-06-06T10:00:00.000Z"),
    });
    const entry = await fm.recordCorrection({
      source: "user",
      original: "用 4 空格缩进",
      corrected: "用 2 空格缩进",
      rule_rel: "common/coding-style.md",
      rationale: "项目规范",
    });
    expect(entry.id).toBeTruthy();
    const files = await fs.readdir(dir);
    expect(files).toEqual(["feedback-2026-06-06.jsonl"]);
    const content = await fs.readFile(join(dir, files[0]!), "utf-8");
    expect(content).toContain("2 空格缩进");
    expect(content).toContain("common/coding-style.md");
  });

  it("listRecent_filters_by_sinceDays", async () => {
    const t = (iso: string) => () => new Date(iso);
    const fm1 = new FeedbackMemory({
      auditDir: dir,
      now: t("2026-06-01T00:00:00.000Z"),
    });
    await fm1.recordCorrection({
      source: "user",
      original: "old",
      corrected: "new",
    });
    const fm2 = new FeedbackMemory({
      auditDir: dir,
      now: t("2026-06-06T00:00:00.000Z"),
    });
    await fm2.recordCorrection({
      source: "user",
      original: "old2",
      corrected: "new2",
    });

    const fm3 = new FeedbackMemory({
      auditDir: dir,
      now: t("2026-06-06T00:00:00.000Z"),
    });
    const recent = await fm3.listRecent({ sinceDays: 3 });
    expect(recent).toHaveLength(1);
    expect(recent[0]?.corrected).toBe("new2");
  });

  it("listRecent_filters_by_traceId_and_source", async () => {
    const fm = new FeedbackMemory({ auditDir: dir });
    await fm.recordCorrection({
      trace_id: "t1",
      source: "user",
      original: "a",
      corrected: "A",
    });
    await fm.recordCorrection({
      trace_id: "t2",
      source: "judge",
      original: "b",
      corrected: "B",
    });
    expect(await fm.listRecent({ traceId: "t1" })).toHaveLength(1);
    expect(await fm.listRecent({ source: "judge" })).toHaveLength(1);
    expect(await fm.listRecent({ source: "user" })).toHaveLength(1);
  });

  it("listRecent_sorts_newest_first_and_respects_limit", async () => {
    const t = (iso: string) => () => new Date(iso);
    const fm1 = new FeedbackMemory({
      auditDir: dir,
      now: t("2026-06-06T00:00:00.000Z"),
    });
    await fm1.recordCorrection({
      source: "user",
      original: "x1",
      corrected: "y1",
    });
    await new Promise((r) => setTimeout(r, 5));
    const fm2 = new FeedbackMemory({
      auditDir: dir,
      now: t("2026-06-06T00:00:01.000Z"),
    });
    await fm2.recordCorrection({
      source: "user",
      original: "x2",
      corrected: "y2",
    });
    const all = await fm2.listRecent();
    expect(all.map((e) => e.corrected)).toEqual(["y2", "y1"]);
    expect(
      (await fm2.listRecent({ limit: 1 })).map((e) => e.corrected),
    ).toEqual(["y2"]);
  });

  it("listRecent_skips_corrupted_lines", async () => {
    const fm = new FeedbackMemory({ auditDir: dir });
    await fm.recordCorrection({
      source: "user",
      original: "x",
      corrected: "y",
    });
    const logFile = join(dir, "feedback-2026-06-06.jsonl");
    await fs.appendFile(logFile, "garbage\n", "utf-8");
    const all = await fm.listRecent();
    expect(all).toHaveLength(1);
  });

  it("listRecent_returns_empty_when_no_files", async () => {
    const fm = new FeedbackMemory({ auditDir: dir });
    expect(await fm.listRecent()).toEqual([]);
  });

  it("renderAsRuleSections_wraps_in_rule_tags", async () => {
    const fm = new FeedbackMemory({ auditDir: dir });
    await fm.recordCorrection({
      source: "user",
      original: "use 4 spaces",
      corrected: "use 2 spaces",
      rule_rel: "common/coding-style.md",
      rationale: "项目偏好",
    });
    const sections = await fm.renderAsRuleSections();
    expect(sections).toHaveLength(1);
    const s = sections[0]!;
    expect(s.relPath).toMatch(/^feedback\//);
    expect(s.content).toContain("user");
    expect(s.content).toContain("use 2 spaces");
    expect(s.content).toContain("项目偏好");
  });

  it("renderAsRuleSections_returns_empty_when_no_recent", async () => {
    const fm = new FeedbackMemory({ auditDir: dir });
    const sections = await fm.renderAsRuleSections();
    expect(sections).toEqual([]);
  });

  it("renderAsRuleSections_respects_limit", async () => {
    const fm = new FeedbackMemory({ auditDir: dir });
    for (let i = 0; i < 5; i += 1) {
      await fm.recordCorrection({
        source: "user",
        original: `orig${i}`,
        corrected: `corr${i}`,
      });
    }
    const sections = await fm.renderAsRuleSections({ limit: 2 });
    expect(sections).toHaveLength(2);
  });

  it("recordCorrection_truncates_long_fields", async () => {
    const fm = new FeedbackMemory({ auditDir: dir });
    const entry = await fm.recordCorrection({
      source: "user",
      original: "x".repeat(2000),
      corrected: "y".repeat(2000),
      rationale: "z".repeat(1000),
    });
    expect(entry.original.length).toBe(1000);
    expect(entry.corrected.length).toBe(1000);
    expect(entry.rationale?.length).toBe(500);
  });

  it("recordCorrection_increments_metric", async () => {
    const fm = new FeedbackMemory({ auditDir: dir });
    const m = getMetrics();
    const before = m.get("instruction.feedback_recorded_total");
    await fm.recordCorrection({
      source: "user",
      original: "a",
      corrected: "b",
    });
    expect(m.get("instruction.feedback_recorded_total")).toBe(before + 1);
  });

  it("renderAsRuleSections_increments_injected_metric", async () => {
    const fm = new FeedbackMemory({ auditDir: dir });
    await fm.recordCorrection({
      source: "user",
      original: "a",
      corrected: "b",
    });
    const m = getMetrics();
    const before = m.get("instruction.feedback_injected_total");
    await fm.renderAsRuleSections();
    expect(m.get("instruction.feedback_injected_total")).toBe(before + 1);
  });

  it("uses_injected_id_factory", async () => {
    let n = 0;
    const fm = new FeedbackMemory({
      auditDir: dir,
      idFactory: () => `fixed-${++n}`,
    });
    const e1 = await fm.recordCorrection({
      source: "user",
      original: "a",
      corrected: "b",
    });
    const e2 = await fm.recordCorrection({
      source: "user",
      original: "c",
      corrected: "d",
    });
    expect(e1.id).toBe("fixed-1");
    expect(e2.id).toBe("fixed-2");
  });
});
