/**
 * Arbiter — 共识检测 (CAP-DEB-03)
 *
 * 输入: 两个 R1 分析 + 双方 R2 critique (可选)
 * 输出: Consensus (含 consensus_rate) 或 DebateStuckError
 *
 * 共识率算法:
 *   total = |R1_a.assumptions ∪ R1_a.risks ∪ R1_a.missing_info
 *           ∪ R1_b.assumptions ∪ R1_b.risks ∪ R1_b.missing_info|
 *   disagreement = R2 双方 rejected 仍未在 R3 解决的项数
 *   consensus_rate = 1 - disagreement / total
 */

import type { Consensus, CrossCritique, IndependentAnalysis } from "./types.js";

export interface ArbiterDeps {
  readonly consensusThreshold?: number;
}

export class Arbiter {
  private readonly threshold: number;

  constructor(deps: ArbiterDeps = {}) {
    this.threshold = deps.consensusThreshold ?? 0.85;
  }

  /**
   * 评估 R1 + R2 后产出 Consensus。
   * @param rounds 跑了几个辩论轮 (1 = 仅 R1, 2 = R1+R2, 3 = R1+R2+R3)
   */
  evaluate(
    a: IndependentAnalysis,
    b: IndependentAnalysis,
    critiqueA?: CrossCritique,
    critiqueB?: CrossCritique,
    rounds: number = 2,
  ): Consensus {
    const allPointsA = this.flattenPoints(a);
    const allPointsB = this.flattenPoints(b);
    const setA = new Set(allPointsA);
    const setB = new Set(allPointsB);
    const totalSet = new Set([...allPointsA, ...allPointsB]);
    const total = totalSet.size || 1; // 避免除零

    const rejectedA = new Set(
      (critiqueA?.rejected ?? []).map((r) => this.normalize(r.key)),
    );
    const rejectedB = new Set(
      (critiqueB?.rejected ?? []).map((r) => this.normalize(r.key)),
    );

    // 分歧 = 任意一边拒绝过的点（包括双方互拒和单边拒绝）
    // 双方互拒的点显示理由更详细，单边拒绝也是分歧
    const disagreementSet = new Set<string>([...rejectedA, ...rejectedB]);

    let consensusRate: number;
    if (critiqueA || critiqueB) {
      // R2+ 阶段:基于双方 critique 中的 rejected 计算
      consensusRate = Math.max(0, 1 - disagreementSet.size / total);
    } else {
      // R1 阶段(无 critique):基于双方原始观点的 intersection / union
      // 用于让 ClarifyLoop 判断 R1 后是否需要 R2 互搏
      const intersection = new Set<string>();
      for (const k of setA) if (setB.has(k)) intersection.add(k);
      consensusRate = totalSet.size === 0 ? 1.0 : intersection.size / total;
    }

    // 合并产物
    const acceptedA = new Set(
      (critiqueA?.accepted ?? []).map((r) => this.normalize(r.key)),
    );
    const acceptedB = new Set(
      (critiqueB?.accepted ?? []).map((r) => this.normalize(r.key)),
    );

    // assumptions 需要标注接受状态;risks/missing_info 仅去重
    const mergedAssumptions = this.mergeByKey(
      [...a.assumptions],
      [...b.assumptions],
      acceptedA,
      acceptedB,
    );

    const mergedRisks = this.uniqueUnion(a.risks, b.risks);
    const mergedMissing = this.uniqueUnion(a.missing_info, b.missing_info);

    // 收集分歧理由,key 用 critique 中的原始 key(保留 case)
    const disagreementNotes: string[] = [];
    for (const k of disagreementSet) {
      const rejA = critiqueA?.rejected.find((r) => this.normalize(r.key) === k);
      const rejB = critiqueB?.rejected.find((r) => this.normalize(r.key) === k);
      const displayKey = rejA?.key ?? rejB?.key ?? k;
      const reasonA = rejA?.reason ?? "(未拒绝)";
      const reasonB = rejB?.reason ?? "(未拒绝)";
      disagreementNotes.push(
        `[${displayKey}] claude: ${reasonA} | codex: ${reasonB}`,
      );
    }

    return {
      merged_understanding: this.mergeUnderstanding(
        a.understanding,
        b.understanding,
      ),
      merged_assumptions: mergedAssumptions,
      merged_risks: mergedRisks,
      merged_missing_info: mergedMissing,
      consensus_rate: consensusRate,
      rounds,
      disagreement_notes: disagreementNotes,
    };
  }

  /** 共识率是否达标 */
  isConsensusReached(c: Consensus): boolean {
    return c.consensus_rate >= this.threshold;
  }

  private flattenPoints(a: IndependentAnalysis): string[] {
    return [...a.assumptions, ...a.risks, ...a.missing_info].map((s) =>
      this.normalize(s),
    );
  }

  private normalize(s: string): string {
    return s.toLowerCase().replace(/\s+/g, " ").trim();
  }

  private uniqueUnion(...arrs: ReadonlyArray<ReadonlyArray<string>>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const arr of arrs) {
      for (const x of arr) {
        const k = this.normalize(x);
        if (!seen.has(k)) {
          seen.add(k);
          out.push(x);
        }
      }
    }
    return out;
  }

  private mergeUnderstanding(a: string, b: string): string {
    if (a === b) return a;
    if (a.length === 0) return b;
    if (b.length === 0) return a;
    // 简单: 取更长的,附加另一方 key 差异提示
    return `${a.slice(0, 200)} | (codex 视角) ${b.slice(0, 200)}`;
  }

  private mergeByKey(
    pointsA: string[],
    pointsB: string[],
    acceptedA: Set<string>,
    acceptedB: Set<string>,
  ): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const p of [...pointsA, ...pointsB]) {
      const k = this.normalize(p);
      if (seen.has(k)) continue;
      seen.add(k);
      // 接受的标注
      if (acceptedA.has(k) && acceptedB.has(k)) {
        out.push(`${p} (共识)`);
      } else if (acceptedA.has(k) || acceptedB.has(k)) {
        out.push(`${p} (单边接受)`);
      } else {
        out.push(p);
      }
    }
    return out;
  }
}
