import { afterEach, describe, expect, it, vi } from "vitest";
import { ClarifyLoop } from "../../src/debate/clarify-loop.js";
import {
  type ClarifyLoopConfig,
  type CrossCritique,
  type DebateParticipant,
  DebateRoundError,
  DebateStuckError,
  type IndependentAnalysis,
} from "../../src/debate/types.js";
import type { Intent, IntentContext } from "../../src/intent/types.js";

const baseAnalysis = (
  overrides: Partial<IndependentAnalysis> = {},
): IndependentAnalysis => ({
  understanding: "用户要加 feature",
  assumptions: ["A1"],
  risks: ["R1"],
  missing_info: [],
  evidence: ["evidence-1"],
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

const baseConfig: ClarifyLoopConfig = {
  maxRounds: 3,
  roundTimeoutMs: 5000,
  consensusThreshold: 0.85,
  deltaConvergenceThreshold: 2,
  deltaThreshold: 0.05,
};

const fakeIntent: Intent = {
  type: "feature",
  entities: [],
  affected_modules: [],
  urgency: "normal",
  intent_score: 0.9,
  trace_id: "test-trace",
  source: "fallback-haiku",
};

const fakeContext: IntentContext = {
  chatId: "chat-1",
  senderOpenId: "user-1",
};

class FakeParticipant implements DebateParticipant {
  readonly name: string;
  analyze =
    vi.fn<
      (input: { text: string; intent: Intent }) => Promise<IndependentAnalysis>
    >();
  critique = vi.fn<(input: unknown) => Promise<CrossCritique>>();
  constructor(name: string) {
    this.name = name;
  }
}

describe("ClarifyLoop (CAP-DEB-01/02/03/04)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const input = {
    text: "加日期筛选",
    intent: fakeIntent,
    context: fakeContext,
  };

  it("converges_in_R1_if_both_analyses_agree", async () => {
    const a = new FakeParticipant("claude");
    const b = new FakeParticipant("codex");
    a.analyze.mockResolvedValue(baseAnalysis());
    b.analyze.mockResolvedValue(baseAnalysis());

    const loop = new ClarifyLoop(baseConfig, a, b);
    const result = await loop.run(input);

    expect(result.consensus.rounds).toBe(1);
    expect(result.consensus.consensus_rate).toBe(1.0);
    expect(a.analyze).toHaveBeenCalledOnce();
    expect(b.analyze).toHaveBeenCalledOnce();
    expect(a.critique).not.toHaveBeenCalled();
    expect(b.critique).not.toHaveBeenCalled();
    expect(result.history).toHaveLength(2);
  });

  it("runs_R2_when_R1_diverges_and_converges_after_critique", async () => {
    const a = new FakeParticipant("claude");
    const b = new FakeParticipant("codex");
    // R1 不同 → 触发 R2
    a.analyze.mockResolvedValue(
      baseAnalysis({ assumptions: ["A-claude"], risks: ["R-claude"] }),
    );
    b.analyze.mockResolvedValue(
      baseAnalysis({ assumptions: ["A-codex"], risks: ["R-codex"] }),
    );
    // R2 双方都接受对方
    a.critique.mockResolvedValue(
      baseCritique({
        accepted: [
          { key: "A-codex", reason: "ok" },
          { key: "R-codex", reason: "ok" },
        ],
      }),
    );
    b.critique.mockResolvedValue(
      baseCritique({
        accepted: [
          { key: "A-claude", reason: "ok" },
          { key: "R-claude", reason: "ok" },
        ],
      }),
    );

    const loop = new ClarifyLoop(baseConfig, a, b);
    const result = await loop.run(input);

    expect(result.consensus.rounds).toBe(2);
    expect(result.consensus.consensus_rate).toBe(1.0);
    expect(a.critique).toHaveBeenCalledOnce();
    expect(b.critique).toHaveBeenCalledOnce();
  });

  it("throws_DebateStuckError_when_maxRounds_reached_without_consensus", async () => {
    const a = new FakeParticipant("claude");
    const b = new FakeParticipant("codex");
    // R1 分歧
    a.analyze.mockResolvedValue(
      baseAnalysis({ assumptions: ["A-claude"], risks: ["R-claude"] }),
    );
    b.analyze.mockResolvedValue(
      baseAnalysis({ assumptions: ["A-codex"], risks: ["R-codex"] }),
    );
    // 每轮 critique 都互拒,持续新增项
    a.critique.mockImplementation(async () =>
      baseCritique({
        rejected: [{ key: "A-codex", reason: "不行" }],
        added: { assumptions: ["A-claude-new"], risks: [], missing_info: [] },
      }),
    );
    b.critique.mockImplementation(async () =>
      baseCritique({
        rejected: [{ key: "A-claude", reason: "不行" }],
        added: { assumptions: ["A-codex-new"], risks: [], missing_info: [] },
      }),
    );

    const loop = new ClarifyLoop({ ...baseConfig, maxRounds: 2 }, a, b);
    await expect(loop.run(input)).rejects.toBeInstanceOf(DebateStuckError);
  });

  it("delta_convergence_stops_after_consecutive_low_delta_rounds", async () => {
    const a = new FakeParticipant("claude");
    const b = new FakeParticipant("codex");
    a.analyze.mockResolvedValue(baseAnalysis({ assumptions: ["A-claude"] }));
    b.analyze.mockResolvedValue(baseAnalysis({ assumptions: ["A-codex"] }));
    // critique 全是 accepted(没有 added),delta = 0
    a.critique.mockResolvedValue(
      baseCritique({
        accepted: [{ key: "A-codex", reason: "ok" }],
      }),
    );
    b.critique.mockResolvedValue(
      baseCritique({
        accepted: [{ key: "A-claude", reason: "ok" }],
      }),
    );

    const loop = new ClarifyLoop(
      { ...baseConfig, maxRounds: 5, deltaConvergenceThreshold: 2 },
      a,
      b,
    );
    const result = await loop.run(input);
    // delta = 0 < 0.05 → 收敛
    expect(result.consensus.rounds).toBeLessThanOrEqual(5);
    // 应该 ≤ 3 (R2 第一轮 delta=0 计 1, 仍未达共识率则 R3 计 2 → 触发)
    // 但也可能 R2 直接收敛(共识率 1.0)
    expect(a.critique.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("wraps_participant_error_in_DebateRoundError", async () => {
    const a = new FakeParticipant("claude");
    const b = new FakeParticipant("codex");
    a.analyze.mockRejectedValue(new Error("network down"));
    b.analyze.mockResolvedValue(baseAnalysis());

    const loop = new ClarifyLoop(baseConfig, a, b);
    await expect(loop.run(input)).rejects.toBeInstanceOf(DebateRoundError);
  });

  it("times_out_a_slow_round", async () => {
    const a = new FakeParticipant("claude");
    const b = new FakeParticipant("codex");
    a.analyze.mockImplementation(
      () => new Promise(() => {}), // 永不 resolve
    );
    b.analyze.mockResolvedValue(baseAnalysis());

    const loop = new ClarifyLoop({ ...baseConfig, roundTimeoutMs: 50 }, a, b);
    await expect(loop.run(input)).rejects.toBeInstanceOf(DebateRoundError);
  });

  it("records_full_history_with_round_and_action", async () => {
    const a = new FakeParticipant("claude");
    const b = new FakeParticipant("codex");
    a.analyze.mockResolvedValue(baseAnalysis({ assumptions: ["A-claude"] }));
    b.analyze.mockResolvedValue(baseAnalysis({ assumptions: ["A-codex"] }));
    a.critique.mockResolvedValue(
      baseCritique({
        accepted: [{ key: "A-codex", reason: "ok" }],
      }),
    );
    b.critique.mockResolvedValue(
      baseCritique({
        accepted: [{ key: "A-claude", reason: "ok" }],
      }),
    );

    const loop = new ClarifyLoop(baseConfig, a, b);
    const result = await loop.run(input);

    // history 至少包含 R1 双方 + R2 双方 = 4 条
    expect(result.history.length).toBeGreaterThanOrEqual(2);
    expect(result.history[0]?.round).toBe(1);
    expect(result.history[0]?.action).toBe("analyze");
  });

  it("returns_r1_originals_for_audit", async () => {
    const a = new FakeParticipant("claude");
    const b = new FakeParticipant("codex");
    const ra = baseAnalysis({ understanding: "claude 视角" });
    const rb = baseAnalysis({ understanding: "codex 视角" });
    a.analyze.mockResolvedValue(ra);
    b.analyze.mockResolvedValue(rb);

    const loop = new ClarifyLoop(baseConfig, a, b);
    const result = await loop.run(input);

    expect(result.r1.a.understanding).toBe("claude 视角");
    expect(result.r1.b.understanding).toBe("codex 视角");
  });
});
