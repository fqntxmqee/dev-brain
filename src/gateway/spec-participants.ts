/**
 * Stub DebateParticipants — Phase A.6 CLI fallback
 *
 * 默认给 CLI `pnpm cli spec` 使用,跑通端到端流水线不依赖 LLM。
 * 真实 LLM 适配器(claude/codex native)会作为 DebateParticipant
 * 实现注入,替换这里的 stub。
 *
 * 行为:从 text 抽取关键词,生成固定的 assumption/risk/missing_info
 * 列表(两边一致 → R1 直接共识,验证完整链路)。
 */

import type {
  Consensus,
  CrossCritique,
  DebateParticipant,
  IndependentAnalysis,
} from "../debate/types.js";
import type { Intent, IntentContext } from "../intent/types.js";

export interface StubParticipantOptions {
  readonly name: string;
  /** 注入关键词抽取规则;默认用简单 split */
  readonly extractKeywords?: (text: string) => string[];
}

const defaultExtract = (text: string): string[] => {
  const tokens = text
    .replace(/[，。！？、；：（）()【】\[\]]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  return [...new Set(tokens)].slice(0, 8);
};

export class StubDebateParticipant implements DebateParticipant {
  readonly name: string;
  private readonly extract: (text: string) => string[];

  constructor(opts: StubParticipantOptions) {
    this.name = opts.name;
    this.extract = opts.extractKeywords ?? defaultExtract;
  }

  async analyze(input: {
    text: string;
    intent: Intent;
    context: IntentContext;
  }): Promise<IndependentAnalysis> {
    const kws = this.extract(input.text);
    return {
      understanding: `${this.name} 视角: ${input.text.slice(0, 80)}`,
      assumptions: kws.map(
        (k) => `支持「${k}」(共识) — ${this.name} 推断用户需要这个能力`,
      ),
      risks: [
        `可能影响 ${kws[0] ?? "现有"} 模块的边界`,
        `需补 ${kws[1] ?? "更多"} 上下文信息`,
      ],
      missing_info: kws.slice(2).map((k) => `${k} 的具体取值范围?`),
      evidence: input.text ? [input.text.slice(0, 40)] : [],
    };
  }

  async critique(): Promise<CrossCritique> {
    return {
      accepted: [],
      rejected: [],
      added: { assumptions: [], risks: [], missing_info: [] },
      concession_score: 0,
    };
  }
}

/**
 * 双方 stub 分析完全一致时,Arbiter 会判 R1 直接共识
 * (util 留给后续做 e2e 测试用)。
 */
export function makeConsensusFromAssumptions(
  assumptions: ReadonlyArray<string>,
  understanding: string,
): Consensus {
  return {
    merged_understanding: understanding,
    merged_assumptions: assumptions,
    merged_risks: ["(stub 风险)"],
    merged_missing_info: ["(stub 缺信息)"],
    consensus_rate: 1.0,
    rounds: 1,
    disagreement_notes: [],
  };
}
