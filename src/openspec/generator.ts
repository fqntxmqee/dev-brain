/**
 * OpenSpecGenerator — 共识 → OpenSpec 标准 delta change
 *
 * 输入: Intent (DeepSeek 分类) + Consensus (claude/codex 辩论结果)
 * 输出: OpenSpecArtifact {
 *   changeId,
 *   proposal.md,
 *   tasks.md,
 *   specs/{component}/spec.md  (基于 intent.affected_modules)
 * }
 *
 * 模板严格遵循 openspec/changes/spec-driven-workflow/proposal.md 的 5-section 风格:
 *   ## Motivation / ## Scope / ## Non-Goals / ## Risks / ## Acceptance Criteria
 *
 * Spec 文件用 Given/When/Then,带 CAP-XXX-NN 编号。
 */

import type { Intent } from "../intent/types.js";
import type { Consensus } from "../debate/types.js";

export interface OpenSpecArtifact {
  readonly changeId: string;
  readonly demandId: string;
  readonly proposal: string;
  readonly tasks: string;
  /** key = component name (来自 intent.affected_modules);value = spec.md 内容 */
  readonly specs: Record<string, string>;
}

export interface GenerateInput {
  readonly intent: Intent;
  readonly consensus: Consensus;
  /** demandId 一般是 DM-YYYYMMDD-NNN(由 BrainEngine 分配) */
  readonly demandId: string;
  /** 用户原文(写入 proposal 的 Motivation) */
  readonly originalText: string;
  readonly now?: () => Date;
}

export class OpenSpecGenerator {
  generate(input: GenerateInput): OpenSpecArtifact {
    const now = input.now ?? (() => new Date());
    const changeId = this.makeChangeId(input.intent, now());
    const modules =
      input.intent.affected_modules.length > 0
        ? input.intent.affected_modules
        : ["general"];

    const specs: Record<string, string> = {};
    for (const mod of modules) {
      specs[mod] = this.renderSpec(mod, input);
    }

    return {
      changeId,
      demandId: input.demandId,
      proposal: this.renderProposal(changeId, input),
      tasks: this.renderTasks(modules, input),
      specs,
    };
  }

  // ============================================================
  //  proposal.md
  // ============================================================
  private renderProposal(changeId: string, input: GenerateInput): string {
    const { intent, consensus, demandId, originalText } = input;
    const sections: string[] = [];
    sections.push(`---
demand-id: ${demandId}
change: ${changeId}
intent: ${intent.type}
urgency: ${intent.urgency}
status: proposed
generated-by: dev-brain
---

# ${this.humanize(changeId)}

## Motivation

> ${this.escapeQuote(originalText)}

**Intent**: \`${intent.type}\` (score=${intent.intent_score.toFixed(2)}, source=${intent.source})
**Entities**: ${intent.entities.length > 0 ? intent.entities.join(", ") : "(none)"}
**Affected modules**: ${intent.affected_modules.length > 0 ? intent.affected_modules.join(", ") : "(none)"}

${consensus.merged_understanding}`);

    sections.push(`## Scope

经 claude/codex 辩论 ${consensus.rounds} 轮后达成的共识假设:

${
  consensus.merged_assumptions.length === 0
    ? "(双方未提出明确假设)"
    : consensus.merged_assumptions.map((a) => `- ${a}`).join("\n")
}`);

    sections.push(`## Non-Goals

下列项目为 *待确认* 信息,不在本次交付范围,需用户或 PM 反馈后才能进入下次迭代:

${
  consensus.merged_missing_info.length === 0
    ? "(无)"
    : consensus.merged_missing_info.map((m) => `- ${m}`).join("\n")
}`);

    sections.push(`## Risks

${
  consensus.merged_risks.length === 0
    ? "(无显著风险)"
    : consensus.merged_risks.map((r) => `- ${r}`).join("\n")
}`);

    sections.push(`## Acceptance Criteria

- [ ] 所有共识假设在实现中被覆盖
- [ ] 所有风险有缓解措施或 ADR 说明决策依据
- [ ] 所有 affected_modules 都有对应 spec.md
- [ ] consensus_rate=${consensus.consensus_rate.toFixed(2)} ≥ 0.85 (本次已满足)
${
  consensus.disagreement_notes.length > 0
    ? `

## ⚠️ Unresolved Disagreements

辩论结束时仍未达成共识的点(需用户审):

${consensus.disagreement_notes.map((n) => `- ${n}`).join("\n")}`
    : ""
}`);

    return sections.join("\n\n") + "\n";
  }

  // ============================================================
  //  tasks.md
  // ============================================================
  private renderTasks(
    modules: ReadonlyArray<string>,
    input: GenerateInput,
  ): string {
    const { consensus } = input;
    const lines: string[] = [];
    lines.push(`# Implementation Tasks

> 由 dev-brain 根据共识自动生成。完成后用 \`/openspec-archive ${this.makeChangeId(input.intent, input.now?.() ?? new Date())}\` 归档。

## 1. Spec 落地`);

    for (const mod of modules) {
      lines.push(`- [ ] 实现 \`${mod}\` 模块的 spec (specs/${mod}/spec.md)`);
    }

    lines.push(`\n## 2. 假设验证`);
    if (consensus.merged_assumptions.length === 0) {
      lines.push(`- [ ] (无假设需验证)`);
    } else {
      for (const a of consensus.merged_assumptions) {
        lines.push(`- [ ] 验证假设: ${a}`);
      }
    }

    lines.push(`\n## 3. 风险缓解`);
    if (consensus.merged_risks.length === 0) {
      lines.push(`- [ ] (无风险需缓解)`);
    } else {
      for (const r of consensus.merged_risks) {
        lines.push(`- [ ] 缓解风险: ${r}`);
      }
    }

    lines.push(`\n## 4. 待确认信息回填`);
    if (consensus.merged_missing_info.length === 0) {
      lines.push(`- [ ] (信息完备)`);
    } else {
      for (const m of consensus.merged_missing_info) {
        lines.push(`- [ ] 回填: ${m}`);
      }
    }

    lines.push(`\n## 5. 质量门禁
- [ ] \`pnpm typecheck\` 干净
- [ ] \`pnpm test\` 全绿
- [ ] 覆盖率 stmt ≥ 85%, branch ≥ 74%
- [ ] \`/verify-security\` 无 Critical/High 发现
- [ ] \`/verify-quality\` 无 Critical/High 发现`);

    return lines.join("\n") + "\n";
  }

  // ============================================================
  //  specs/{component}/spec.md
  // ============================================================
  private renderSpec(component: string, input: GenerateInput): string {
    const { intent, consensus, demandId } = input;
    const capPrefix = this.capPrefix(component);

    const requirements: string[] = [];

    // 每个 assumption 生成一个 CAP requirement
    consensus.merged_assumptions.forEach((a, idx) => {
      const num = String(idx + 1).padStart(2, "0");
      const isConsensus = a.includes("(共识)");
      const isUnilateral = a.includes("(单边接受)");
      const cleanText = a.replace(/\s*\((共识|单边接受)\)\s*$/, "").trim();
      const note = isConsensus
        ? " ✅ 双方共识"
        : isUnilateral
          ? " ⚠️ 单边接受,实现时需关注"
          : "";

      requirements.push(`### ${capPrefix}-${num} ${cleanText}${note}

**Given** ${component} 模块当前状态
**When** 实现该 ${intent.type}
**Then** 必须满足: ${cleanText}

**Scenario: 标准路径**
- GIVEN 环境已初始化
- WHEN 触发 ${intent.type}
- THEN 行为符合 ${cleanText}
- AND 不破坏既有测试
`);
    });

    if (requirements.length === 0) {
      requirements.push(`### ${capPrefix}-01 (placeholder)

> ⚠️ 共识中无明确假设,需用户补充需求细节后再生成 spec。
`);
    }

    return `---
demand-id: ${demandId}
component: ${component}
intent: ${intent.type}
status: draft
---

# ${this.titleCase(component)} Spec (Delta — ${intent.type})

> 由 dev-brain 根据 claude/codex 辩论共识生成 (consensus_rate=${consensus.consensus_rate.toFixed(2)})。

## 上下文

${consensus.merged_understanding}

## Requirements

${requirements.join("\n")}

${
  consensus.merged_risks.length > 0
    ? `## Identified Risks

${consensus.merged_risks.map((r) => `- ${r}`).join("\n")}
`
    : ""
}`;
  }

  // ============================================================
  //  helpers
  // ============================================================
  private makeChangeId(intent: Intent, now: Date): string {
    const yyyymmdd = now.toISOString().slice(0, 10).replace(/-/g, "");
    const moduleHint =
      intent.affected_modules[0] ?? intent.entities[0] ?? "general";
    const safe = moduleHint
      .replace(/[^a-z0-9-]/gi, "-")
      .toLowerCase()
      .slice(0, 20)
      .replace(/^-+|-+$/g, "");
    return `${intent.type}-${safe}-${yyyymmdd}`;
  }

  private capPrefix(component: string): string {
    return (
      "CAP-" +
      component
        .replace(/[^a-z0-9]/gi, "")
        .toUpperCase()
        .slice(0, 4)
    );
  }

  private humanize(changeId: string): string {
    return changeId
      .split(/[-_]/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

  private titleCase(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  private escapeQuote(s: string): string {
    return s.replace(/\n/g, " ").trim().slice(0, 500);
  }
}
