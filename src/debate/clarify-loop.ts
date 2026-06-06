/**
 * ClarifyLoop — 多轮辩论编排 (CAP-DEB-01..04)
 *
 * R1 独立 → R2 互搏 → R3 (可选) → Arbiter 评估
 *
 * 收敛条件 (任一满足即停):
 *   1. 共识率 ≥ threshold (默认 0.85)
 *   2. delta < 0.05 连续 2 轮
 *   3. 已达 maxRounds
 *
 * 失败条件:
 *   - 跑完 maxRounds 仍未收敛 → 抛 DebateStuckError
 */

import { defaultLogger, type Logger } from "../core/logger.js";
import { withTimeout } from "../core/error-utils.js";
import {
  type ClarifyLoopConfig,
  type Consensus,
  type DebateParticipant,
  DebateRoundError,
  DebateStuckError,
  type IndependentAnalysis,
} from "./types.js";
import { Arbiter } from "./arbiter.js";

export interface ClarifyLoopDeps {
  readonly logger?: Logger;
  readonly now?: () => Date;
}

export interface ClarifyLoopResult {
  readonly consensus: Consensus;
  /** 双方 R1 原始分析(供 debug/审计) */
  readonly r1: { a: IndependentAnalysis; b: IndependentAnalysis };
  /** 每轮的 critique(供 debug) */
  readonly history: ReadonlyArray<{
    round: number;
    participant: string;
    action: "analyze" | "critique";
  }>;
}

export class ClarifyLoop {
  private readonly logger: Logger;
  private readonly arbiter: Arbiter;
  private readonly maxRounds: number;
  private readonly roundTimeoutMs: number;
  private readonly consensusThreshold: number;
  private readonly deltaConvergenceThreshold: number;
  private readonly deltaThreshold: number;

  constructor(
    config: ClarifyLoopConfig,
    private readonly participantA: DebateParticipant,
    private readonly participantB: DebateParticipant,
    deps: ClarifyLoopDeps = {},
  ) {
    this.logger =
      deps.logger ?? defaultLogger.child({ component: "clarify-loop" });
    this.maxRounds = config.maxRounds;
    this.roundTimeoutMs = config.roundTimeoutMs;
    this.consensusThreshold = config.consensusThreshold;
    this.deltaConvergenceThreshold = config.deltaConvergenceThreshold;
    this.deltaThreshold = config.deltaThreshold;
    this.arbiter = new Arbiter({ consensusThreshold: this.consensusThreshold });
  }

  async run(input: {
    text: string;
    intent: import("../intent/types.js").Intent;
    context: import("../intent/types.js").IntentContext;
  }): Promise<ClarifyLoopResult> {
    const history: Array<{
      round: number;
      participant: string;
      action: "analyze" | "critique";
    }> = [];
    let consecutiveLowDelta = 0;
    let lastR2CritiqueA: import("./types.js").CrossCritique | undefined;
    let lastR2CritiqueB: import("./types.js").CrossCritique | undefined;
    let lastRA1: IndependentAnalysis | undefined;
    let lastRA2: IndependentAnalysis | undefined;

    // R1: 独立分析
    const [r1A, r1B] = await Promise.all([
      this.runRound(
        () => this.participantA.analyze(input),
        1,
        this.participantA.name,
        "analyze",
      ),
      this.runRound(
        () => this.participantB.analyze(input),
        1,
        this.participantB.name,
        "analyze",
      ),
    ]);
    history.push(
      { round: 1, participant: this.participantA.name, action: "analyze" },
      { round: 1, participant: this.participantB.name, action: "analyze" },
    );
    lastRA1 = r1A;
    lastRA2 = r1B;

    // 评估 R1 直接共识
    let consensus = this.arbiter.evaluate(r1A, r1B, undefined, undefined, 1);
    if (this.arbiter.isConsensusReached(consensus)) {
      this.logger.info("debate converged in R1", {
        rounds: 1,
        consensus_rate: consensus.consensus_rate,
      });
      return { consensus, r1: { a: r1A, b: r1B }, history };
    }

    // R2: 互搏
    for (let round = 2; round <= this.maxRounds; round++) {
      const [cA, cB] = await Promise.all([
        this.runRound(
          () =>
            this.participantA.critique({
              text: input.text,
              intent: input.intent,
              selfAnalysis: lastRA1!,
              otherAnalysis: lastRA2!,
              round,
              previousCritique: lastR2CritiqueA,
            }),
          round,
          this.participantA.name,
          "critique",
        ),
        this.runRound(
          () =>
            this.participantB.critique({
              text: input.text,
              intent: input.intent,
              selfAnalysis: lastRA2!,
              otherAnalysis: lastRA1!,
              round,
              previousCritique: lastR2CritiqueB,
            }),
          round,
          this.participantB.name,
          "critique",
        ),
      ]);
      history.push(
        { round, participant: this.participantA.name, action: "critique" },
        { round, participant: this.participantB.name, action: "critique" },
      );
      lastR2CritiqueA = cA;
      lastR2CritiqueB = cB;

      consensus = this.arbiter.evaluate(r1A, r1B, cA, cB, round);
      if (this.arbiter.isConsensusReached(consensus)) {
        this.logger.info(`debate converged in R${round}`, {
          rounds: round,
          consensus_rate: consensus.consensus_rate,
        });
        return { consensus, r1: { a: r1A, b: r1B }, history };
      }

      // delta 收敛检测
      const delta = this.computeDelta(cA, cB);
      if (delta < this.deltaThreshold) {
        consecutiveLowDelta += 1;
        if (consecutiveLowDelta >= this.deltaConvergenceThreshold) {
          this.logger.info(`debate delta-converged in R${round}`, {
            rounds: round,
            delta,
            consensus_rate: consensus.consensus_rate,
          });
          return { consensus, r1: { a: r1A, b: r1B }, history };
        }
      } else {
        consecutiveLowDelta = 0;
      }
    }

    // 未收敛 → 上抛
    this.logger.warn("debate stuck; maxRounds reached", {
      maxRounds: this.maxRounds,
      final_consensus_rate: consensus.consensus_rate,
    });
    throw new DebateStuckError(this.maxRounds, consensus.disagreement_notes);
  }

  private async runRound<T>(
    fn: () => Promise<T>,
    round: number,
    participant: string,
    action: "analyze" | "critique",
  ): Promise<T> {
    try {
      return await withTimeout(
        fn(),
        this.roundTimeoutMs,
        `debate ${action} ${participant}`,
      );
    } catch (err) {
      throw new DebateRoundError(
        err instanceof Error ? err.message : String(err),
        { round, participant, retryable: false },
      );
    }
  }

  private computeDelta(
    cA: import("./types.js").CrossCritique,
    cB: import("./types.js").CrossCritique,
  ): number {
    // delta = |新增项| / (|接受| + |新增|)
    const addedA =
      cA.added.assumptions.length +
      cA.added.risks.length +
      cA.added.missing_info.length;
    const addedB =
      cB.added.assumptions.length +
      cB.added.risks.length +
      cB.added.missing_info.length;
    const acceptedA = cA.accepted.length;
    const acceptedB = cB.accepted.length;
    const denom = addedA + addedB + acceptedA + acceptedB;
    if (denom === 0) return 0;
    return (addedA + addedB) / denom;
  }
}
