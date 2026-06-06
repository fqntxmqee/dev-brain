import { describe, expect, it } from "vitest";
import { Arbiter } from "../../src/debate/arbiter.js";
import type {
  CrossCritique,
  IndependentAnalysis,
} from "../../src/debate/types.js";

const baseAnalysis = (
  overrides: Partial<IndependentAnalysis> = {},
): IndependentAnalysis => ({
  understanding: "用户要加 feature",
  assumptions: ["trade 模块存在", "用 Redis 存 token"],
  risks: ["可能影响现有接口"],
  missing_info: ["token 过期时间"],
  evidence: ["用户原句: trade 加日期筛选"],
  ...overrides,
});

const baseCritique = (
  overrides: Partial<CrossCritique> = {},
): CrossCritique => ({
  accepted: [],
  rejected: [],
  added: { assumptions: [], risks: [], missing_info: [] },
  concession_score: 0.5,
  ...overrides,
});

describe("Arbiter (CAP-DEB-03)", () => {
  it("high_agreement_yields_high_consensus_rate", () => {
    const arb = new Arbiter({ consensusThreshold: 0.85 });
    const a = baseAnalysis();
    const b = baseAnalysis();
    // 双方都接受
    const cA = baseCritique({
      accepted: [{ key: "trade 模块存在", reason: "ok" }],
    });
    const cB = baseCritique({
      accepted: [{ key: "trade 模块存在", reason: "ok" }],
    });
    const r = arb.evaluate(a, b, cA, cB, 2);
    expect(r.consensus_rate).toBeGreaterThanOrEqual(0.85);
    expect(arb.isConsensusReached(r)).toBe(true);
  });

  it("total_disagreement_yields_low_consensus_rate", () => {
    const arb = new Arbiter({ consensusThreshold: 0.85 });
    const a = baseAnalysis({
      assumptions: ["用 Redis"],
      risks: ["性能问题"],
      missing_info: [],
    });
    const b = baseAnalysis({
      assumptions: ["用 MySQL"],
      risks: ["事务问题"],
      missing_info: [],
    });
    const cA = baseCritique({
      rejected: [{ key: "用 MySQL", reason: "Redis 更合适" }],
    });
    const cB = baseCritique({
      rejected: [{ key: "用 Redis", reason: "MySQL 已有现成" }],
    });
    const r = arb.evaluate(a, b, cA, cB, 2);
    expect(r.consensus_rate).toBeLessThan(0.85);
    expect(arb.isConsensusReached(r)).toBe(false);
    expect(r.disagreement_notes.length).toBeGreaterThan(0);
  });

  it("consensus_threshold_configurable", () => {
    const strict = new Arbiter({ consensusThreshold: 0.95 });
    const loose = new Arbiter({ consensusThreshold: 0.5 });
    const a = baseAnalysis();
    const b = baseAnalysis();
    const cA = baseCritique({
      accepted: [{ key: "trade 模块存在", reason: "ok" }],
    });
    const cB = baseCritique({
      accepted: [{ key: "trade 模块存在", reason: "ok" }],
    });
    const r = strict.evaluate(a, b, cA, cB, 2);
    expect(strict.isConsensusReached(r)).toBe(true); // 全共识 → 1.0 ≥ 0.95
    expect(loose.isConsensusReached(r)).toBe(true);
  });

  it("r1_only_evaluation_uses_default_threshold", () => {
    const arb = new Arbiter();
    const a = baseAnalysis();
    const b = baseAnalysis();
    const r = arb.evaluate(a, b, undefined, undefined, 1);
    expect(r.rounds).toBe(1);
    expect(r.consensus_rate).toBe(1.0); // 无 critique → 无 rejected → 全共识
    expect(arb.isConsensusReached(r)).toBe(true);
  });

  it("merged_assumptions_contain_双方_points", () => {
    const arb = new Arbiter();
    const a = baseAnalysis({ assumptions: ["A1", "A2"] });
    const b = baseAnalysis({ assumptions: ["A2", "A3"] });
    const r = arb.evaluate(a, b, undefined, undefined, 1);
    // A1, A2 (去重), A3 → 共 3 个
    expect(r.merged_assumptions).toHaveLength(3);
    expect(r.merged_assumptions.some((s) => s.includes("A1"))).toBe(true);
    expect(r.merged_assumptions.some((s) => s.includes("A3"))).toBe(true);
  });

  it("marked_assumptions_单边接受_with_标记", () => {
    const arb = new Arbiter();
    const a = baseAnalysis({ assumptions: ["X"] });
    const b = baseAnalysis({ assumptions: ["X"] });
    const cA = baseCritique({ accepted: [{ key: "X", reason: "ok" }] });
    const cB = baseCritique(); // 都没说
    const r = arb.evaluate(a, b, cA, cB, 2);
    expect(r.merged_assumptions[0]).toContain("单边接受");
  });

  it("merged_assumptions_共识_with_标记_when_both_accept", () => {
    const arb = new Arbiter();
    const a = baseAnalysis({ assumptions: ["Y"] });
    const b = baseAnalysis({ assumptions: ["Y"] });
    const cA = baseCritique({ accepted: [{ key: "Y", reason: "ok" }] });
    const cB = baseCritique({ accepted: [{ key: "Y", reason: "ok" }] });
    const r = arb.evaluate(a, b, cA, cB, 2);
    expect(r.merged_assumptions[0]).toContain("共识");
  });

  it("handles_empty_inputs_gracefully", () => {
    const arb = new Arbiter();
    const a = baseAnalysis({ assumptions: [], risks: [], missing_info: [] });
    const b = baseAnalysis({ assumptions: [], risks: [], missing_info: [] });
    const r = arb.evaluate(a, b, undefined, undefined, 1);
    expect(r.consensus_rate).toBe(1.0);
  });

  it("disagreement_note_format_includes_both_sides", () => {
    const arb = new Arbiter();
    const a = baseAnalysis({ assumptions: ["X"] });
    const b = baseAnalysis({ assumptions: ["X"] });
    const cA = baseCritique({
      rejected: [{ key: "X", reason: "我认为不行因为 A" }],
    });
    const cB = baseCritique({
      rejected: [{ key: "X", reason: "我认为不行因为 B" }],
    });
    const r = arb.evaluate(a, b, cA, cB, 2);
    const note = r.disagreement_notes[0];
    expect(note).toContain("X");
    expect(note).toContain("A");
    expect(note).toContain("B");
  });
});
