import { describe, expect, it } from "vitest";
import { OpenSpecGenerator } from "../../src/openspec/generator.js";
import type { Consensus } from "../../src/debate/types.js";
import type { Intent } from "../../src/intent/types.js";

const fakeIntent = (overrides: Partial<Intent> = {}): Intent => ({
  type: "feature",
  entities: ["trade", "filter"],
  affected_modules: ["trade", "ui"],
  urgency: "normal",
  intent_score: 0.9,
  trace_id: "trace-001",
  source: "deepseek",
  ...overrides,
});

const fakeConsensus = (overrides: Partial<Consensus> = {}): Consensus => ({
  merged_understanding: "用户要在 trade 模块加日期筛选",
  merged_assumptions: [
    "用户希望支持区间筛选 (共识)",
    "前端用 React DatePicker (单边接受)",
    "默认筛选当月数据",
  ],
  merged_risks: ["可能影响现有 trade 列表分页"],
  merged_missing_info: ["筛选粒度: 日/周/月?"],
  consensus_rate: 0.91,
  rounds: 2,
  disagreement_notes: [],
  ...overrides,
});

const fixedNow = () => new Date("2026-03-15T10:00:00.000Z");

describe("OpenSpecGenerator", () => {
  const gen = new OpenSpecGenerator();

  it("generates_artifact_with_proposal_tasks_specs", () => {
    const out = gen.generate({
      intent: fakeIntent(),
      consensus: fakeConsensus(),
      demandId: "DM-20260315-001",
      originalText: "给 trade 模块加日期筛选",
      now: fixedNow,
    });

    expect(out.changeId).toMatch(/^feature-trade-20260315$/);
    expect(out.demandId).toBe("DM-20260315-001");
    expect(out.proposal).toContain("# ");
    expect(out.tasks).toContain("# Implementation Tasks");
    expect(Object.keys(out.specs).sort()).toEqual(["trade", "ui"]);
  });

  it("proposal_contains_5_required_sections", () => {
    const out = gen.generate({
      intent: fakeIntent(),
      consensus: fakeConsensus(),
      demandId: "DM-20260315-001",
      originalText: "test",
      now: fixedNow,
    });
    expect(out.proposal).toContain("## Motivation");
    expect(out.proposal).toContain("## Scope");
    expect(out.proposal).toContain("## Non-Goals");
    expect(out.proposal).toContain("## Risks");
    expect(out.proposal).toContain("## Acceptance Criteria");
  });

  it("proposal_includes_intent_metadata", () => {
    const out = gen.generate({
      intent: fakeIntent({
        type: "bug",
        urgency: "critical",
        intent_score: 0.95,
      }),
      consensus: fakeConsensus(),
      demandId: "DM-20260315-002",
      originalText: "登录闪退",
      now: fixedNow,
    });
    expect(out.proposal).toContain("intent: bug");
    expect(out.proposal).toContain("urgency: critical");
    expect(out.proposal).toContain("score=0.95");
  });

  it("proposal_shows_disagreement_section_when_present", () => {
    const out = gen.generate({
      intent: fakeIntent(),
      consensus: fakeConsensus({
        consensus_rate: 0.7,
        disagreement_notes: ["[筛选源] claude: 应走 API | codex: 应走前端缓存"],
      }),
      demandId: "DM-20260315-003",
      originalText: "test",
      now: fixedNow,
    });
    expect(out.proposal).toContain("Unresolved Disagreements");
    expect(out.proposal).toContain("筛选源");
  });

  it("proposal_omits_disagreement_section_when_empty", () => {
    const out = gen.generate({
      intent: fakeIntent(),
      consensus: fakeConsensus({ disagreement_notes: [] }),
      demandId: "DM-20260315-004",
      originalText: "test",
      now: fixedNow,
    });
    expect(out.proposal).not.toContain("Unresolved Disagreements");
  });

  it("tasks_includes_assumptions_risks_missing_info", () => {
    const out = gen.generate({
      intent: fakeIntent(),
      consensus: fakeConsensus(),
      demandId: "DM-20260315-005",
      originalText: "test",
      now: fixedNow,
    });
    expect(out.tasks).toContain("验证假设: 用户希望支持区间筛选");
    expect(out.tasks).toContain("缓解风险: 可能影响现有 trade");
    expect(out.tasks).toContain("回填: 筛选粒度");
    expect(out.tasks).toContain("pnpm typecheck");
  });

  it("spec_contains_CAP_requirements_with_Given_When_Then", () => {
    const out = gen.generate({
      intent: fakeIntent({ affected_modules: ["trade"] }),
      consensus: fakeConsensus(),
      demandId: "DM-20260315-006",
      originalText: "test",
      now: fixedNow,
    });
    const spec = out.specs.trade;
    expect(spec).toBeDefined();
    expect(spec).toContain("### CAP-TRAD-01");
    expect(spec).toContain("**Given**");
    expect(spec).toContain("**When**");
    expect(spec).toContain("**Then**");
    expect(spec).toContain("Scenario:");
  });

  it("spec_marks_consensus_vs_unilateral_assumptions", () => {
    const out = gen.generate({
      intent: fakeIntent({ affected_modules: ["trade"] }),
      consensus: fakeConsensus(),
      demandId: "DM-20260315-007",
      originalText: "test",
      now: fixedNow,
    });
    const spec = out.specs.trade;
    expect(spec).toContain("双方共识");
    expect(spec).toContain("单边接受");
  });

  it("defaults_to_general_component_when_no_modules", () => {
    const out = gen.generate({
      intent: fakeIntent({ affected_modules: [] }),
      consensus: fakeConsensus(),
      demandId: "DM-20260315-008",
      originalText: "test",
      now: fixedNow,
    });
    expect(Object.keys(out.specs)).toEqual(["general"]);
  });

  it("spec_falls_back_to_placeholder_when_no_assumptions", () => {
    const out = gen.generate({
      intent: fakeIntent({ affected_modules: ["empty"] }),
      consensus: fakeConsensus({
        merged_assumptions: [],
        merged_risks: [],
        merged_missing_info: [],
      }),
      demandId: "DM-20260315-009",
      originalText: "test",
      now: fixedNow,
    });
    expect(out.specs.empty).toContain("placeholder");
  });

  it("changeId_uses_yyyymmdd_format", () => {
    const out = gen.generate({
      intent: fakeIntent({ affected_modules: ["alpha"] }),
      consensus: fakeConsensus(),
      demandId: "DM-20260315-010",
      originalText: "test",
      now: () => new Date("2026-07-04T12:00:00.000Z"),
    });
    expect(out.changeId).toMatch(/-20260704$/);
  });

  it("sanitizes_unsafe_chars_in_module_for_changeId", () => {
    const out = gen.generate({
      intent: fakeIntent({ affected_modules: ["foo/bar baz!"] }),
      consensus: fakeConsensus(),
      demandId: "DM-20260315-011",
      originalText: "test",
      now: fixedNow,
    });
    expect(out.changeId).not.toContain("/");
    expect(out.changeId).not.toContain(" ");
    expect(out.changeId).not.toContain("!");
  });
});
