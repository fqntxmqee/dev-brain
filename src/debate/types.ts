/**
 * Debate 子系统的 schema
 * 对应 OpenSpec: openspec/changes/spec-driven-workflow/specs/debate/spec.md
 *
 * 核心抽象: DebateParticipant = 一个独立思考的 LLM 角色 (Claude / Codex / 等等)
 * 编排: ClarifyLoop 跑 R1 独立 + R2 互搏 + R3 可选,Arbiter 检测共识
 */

import type { Intent, IntentContext } from "../intent/types.js";

/** R1: 独立分析产物 */
export interface IndependentAnalysis {
  /** 自然语言理解,200 字内 */
  readonly understanding: string;
  /** 3-5 条假设 */
  readonly assumptions: ReadonlyArray<string>;
  /** ≥ 1 条风险 */
  readonly risks: ReadonlyArray<string>;
  /** ≥ 0 条缺信息 */
  readonly missing_info: ReadonlyArray<string>;
  /** 从 text 引用的原句 */
  readonly evidence: ReadonlyArray<string>;
}

/** R2/R3: 互搏产物 */
export interface CrossCritique {
  /** 接受了对方哪些点(用对方的 key/原句标记) */
  readonly accepted: ReadonlyArray<{ key: string; reason: string }>;
  /** 拒绝对方哪些点(带理由) */
  readonly rejected: ReadonlyArray<{ key: string; reason: string }>;
  /** 我方新增(对方遗漏) */
  readonly added: {
    readonly assumptions: ReadonlyArray<string>;
    readonly risks: ReadonlyArray<string>;
    readonly missing_info: ReadonlyArray<string>;
  };
  /** 0-1,本轮让步程度 */
  readonly concession_score: number;
}

/** 共识产物 (R1 + R2 合并后) */
export interface Consensus {
  readonly merged_understanding: string;
  readonly merged_assumptions: ReadonlyArray<string>;
  readonly merged_risks: ReadonlyArray<string>;
  readonly merged_missing_info: ReadonlyArray<string>;
  /** 0-1 */
  readonly consensus_rate: number;
  /** 1/2/3 */
  readonly rounds: number;
  /** 未能收敛的分歧点 (留给用户审) */
  readonly disagreement_notes: ReadonlyArray<string>;
}

/** R1 输入 */
export interface DebateInput {
  readonly text: string;
  readonly intent: Intent;
  readonly context: IntentContext;
}

/** R2/R3 输入 (含对方 R1 + 上一轮 self) */
export interface CritiqueInput {
  readonly text: string;
  readonly intent: Intent;
  readonly selfAnalysis: IndependentAnalysis;
  readonly otherAnalysis: IndependentAnalysis;
  readonly round: number;
  /** R3 才有,带上一轮 critique */
  readonly previousCritique?: CrossCritique;
}

/** 辩论参与者 — 一个 LLM 角色 */
export interface DebateParticipant {
  readonly name: string;
  analyze(input: DebateInput): Promise<IndependentAnalysis>;
  critique(input: CritiqueInput): Promise<CrossCritique>;
}

/** ClarifyLoop 配 */
export interface ClarifyLoopConfig {
  readonly maxRounds: number;
  readonly roundTimeoutMs: number;
  readonly consensusThreshold: number;
  /** 连续 N 轮 delta < 0.05 也算收敛 (默认 2) */
  readonly deltaConvergenceThreshold: number;
  /** 触发 delta 收敛判定的阈值 */
  readonly deltaThreshold: number;
}

export class DebateRoundError extends Error {
  readonly code = "DEBATE_ROUND_ERROR";
  readonly retryable: boolean;
  readonly round: number;
  readonly participant: string;
  constructor(
    message: string,
    opts: { round: number; participant: string; retryable?: boolean },
  ) {
    super(message);
    this.name = "DebateRoundError";
    this.round = opts.round;
    this.participant = opts.participant;
    this.retryable = opts.retryable ?? true;
  }
}

export class DebateStuckError extends Error {
  readonly code = "DEBATE_STUCK_ERROR";
  readonly rounds: number;
  readonly disagreementNotes: ReadonlyArray<string>;
  constructor(rounds: number, notes: ReadonlyArray<string>) {
    super(
      `Debate stuck after ${rounds} rounds; consensus_rate below threshold`,
    );
    this.name = "DebateStuckError";
    this.rounds = rounds;
    this.disagreementNotes = notes;
  }
}
