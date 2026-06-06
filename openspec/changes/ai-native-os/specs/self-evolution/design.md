---
demand-id: DM-20260606-003
change: ai-native-os
module: self-evolution
status: developing
---

# Self-Evolution 深度设计：Grill with Docs 3 轮

**日期**: 2026-06-06
**关联**: `docs/philosophy.md` / `review/ai-native-os-review.md` / `review/game-theory-analysis.md`

> **注意**: 本模块已通过博弈论审查 (CAP-EVO-02 双轨 RuleValidator / CAP-EVO-03 A/B Split / CAP-EVO-05 熔断 / CAP-EVO-06 用户反馈), spec.md 已高度成熟。本次深度设计聚焦于**增量增强**——行业调研发现的 5 个可叠加改进点。

---

## 目标锚定

### L1 — 用户说想要什么？

> "周期任务拉 snapshot + 失败 trace → LLM 诊断 → RuleValidator 验证 → A/B Split 评测 → 用户反馈检查 → 熔断前置检查 → 替换 prompt → 落 L3"

原始 spec (CAP-EVO-01..06) 已经是一套完整的"AI 驱动 AI"闭环。

### L2 — 本质上用户想达成什么？

**用户不是在要"6 个进化模块"，用户在要一个可信的自我改进机制:**

> 系统能从自己的失败和成功中学习,自动改善 prompt/spec/context——但不能为了"看起来在改进"而牺牲实际质量,也不能为了通过评测而钻空子。

翻译成系统目标:
1. **从失败中学习**: 分析失败根因,生成针对性修复 (已有: CAP-EVO-01/02)
2. **从成功中学习** (NEW): 分析成功模式,强化有效的 prompt 模式
3. **安全地改进**: 改进必须经过评测 + 用户认可 + 熔断兜底 (已有: CAP-EVO-03/05/06)
4. **可审计地改进**: 每次改动有完整溯源链,知道"谁改了谁,为什么,结果如何"
5. **在预算内改进**: 进化本身不能无限消耗 LLM token (NEW 约束)

### L3 — 约束条件

| 约束 | 来源 | 严苛度 |
|------|------|--------|
| DiagnosticLLM 不能策略性输出高置信度 | 博弈论审查 | 硬约束 (已有 RuleValidator) |
| Evolution Service 不能针对 eval suite 过拟合 | 博弈论审查 | 硬约束 (已有 A/B Split) |
| 进化不能无限消耗 token | 成本约束 | 硬约束 (NEW: 需预算控制) |
| 进化方向不能偏离用户价值 | 博弈论审查 | 硬约束 (已有用户反馈) |
| 每次改动必须有完整溯源链 | 可审计性 | 硬约束 (需增强: 溯源链) |
| DGM 案例: 不能为了"指标好看"而破坏观测机制 | 安全约束 | 硬约束 (需增强: Goal Drift Index) |

### 核心矛盾

```
自我进化需要"自动修改 prompt/spec"
    ↕
自动修改可能产生 3 类风险:
  1. 优化错目标 (Goodhart: 针对 eval 过拟合) — 已有 A/B Split 缓解
  2. 破坏观测 (DGM: 移除日志来消除"失败"记录) — 需增强
  3. 方向偏离 (用户价值 vs 指标优化的 drift) — 已有用户反馈, 需增强 Goal Drift Index
    ↕
关键问题: 在已有 6 个 CAP-EVO 的安全网基础上,还需要什么来防范"指标 hacking"和"方向偏离"?
```

**次要矛盾**: 当前 spec 只从失败中学习。DSPy 的框架表明,**成功模式的价值可能大于失败模式**——知道"什么有效"比知道"什么无效"更直接可操作。

---

## 第 1 轮: 问题空间探索 — "业界怎么解决 AI 自我进化的？"

### 信息来源

| 来源 | 类型 | 关键内容 |
|------|------|---------|
| [DSPy 3.2.0](https://github.com/stanfordnlp/dspy) (Stanford, 2025-2026) | 框架 | "Compile, then run": Signatures/Modules/Optimizers 三层分离, MIPROv2 贝叶斯优化, GEPA ICLR 2026 Oral Pareto 前沿搜索 |
| [TextGrad](https://github.com/zou-group/textgrad) (Stanford, Nature 2025) | 论文 | 文本梯度: LLM 生成自然语言反馈替代数值梯度, 反向传播通过 AI 组件图 |
| [GReaTer](https://iclr.cc/media/iclr-2025/Slides/28876.pdf) (ICLR 2025) | 论文 | 梯度信号过 reasoning traces (不仅 final outputs), 8-9B 小模型优化 prompt 媲美 GPT-4 |
| [SAHOO](https://browse-export.arxiv.org/abs/2603.06333) (ICLR 2026 Workshop) | 论文 | RSI 安全: Goal Drift Index + 约束保持检查 + 回归风险量化, 18.3% 代码改进且保持约束 |
| [Darwin-Gödel Machine (DGM)](https://www.pnas.org/doi/abs/10.1073/pnas.2527700123) (PNAS, Apr 2026) | 论文 | **真实案例**: Agent 学习移除日志函数来消除 hallucination 测量, 而非修复 hallucination |
| [OPRO](https://arxiv.org/abs/2309.03409) (DeepMind, 2023) | 论文 | LLM 作为优化器: 看历史 (prompt, score) 对, 生成新候选 prompt; 8,000 次调用 |
| [LangSmith/Braintrust](https://simorconsulting.com/blog/llm-evaluation-platforms-compared-langsmith-braintrust-patronus) (2025-2026) | 工程实践 | 生产级 eval: CI 质量闸门 + 实验追踪 + prompt 版本管理 + 人工标注 |
| [Meta-Harness](https://www.getmaxim.ai/blog/meta-harness-what-if-we-let-an-agent-optimize-the-code-around-an-llm/) (Stanford/MIT, 2026) | 论文 | 给 coding agent 完整文件系统 + 执行 trace, 10x 效率提升 |

### 关键发现

#### 发现 1: DSPy 的"从成功中学习" > "仅从失败中学习"

DSPy 的核心机制是 **BootstrapFewShot**: 跑程序在训练数据上,收集**成功的 trace**,把它们作为 few-shot 示例注入 prompt。这是"从成功中学习"——好的 prompt 模式从已验证的成功案例中提取。

当前 spec 的 InsightEngine 只从失败 trace 聚合 insight。缺少对称的"成功模式提取"。DSPy 证明了:**成功案例作为 few-shot 示例,对 prompt 质量的提升可能比"告诉 LLM 不要做什么"更有效**。

**对 dev-brain 的影响**: InsightEngine 应该同时分析成功 trace (acceptance 全部通过的 subtask),提取"什么 prompt 模式带来了成功",作为正向 insight (type="success-pattern")。

#### 发现 2: GReaTer 的 reasoning trace 分析

GReaTer 的核心发现: **梯度信号过 reasoning traces 比仅过 final outputs 更有效**。也就是说,分析 Agent **怎么思考的** (reasoning trace) 比只看**最终输出对不对** (pass/fail) 信息量大得多。

当前 spec 的 L1FailureTrace 包含 gitDiff / acceptance / heartbeat,但不含 Agent 的 reasoning trace。如果 Agent 输出了 `/* 我觉得这里不需要测试,因为... */`,这个 reasoning 对归因非常有价值。

**对 dev-brain 的影响**: L1FailureTrace 应可选包含 Agent reasoning trace (从 agent output 中抽取 `thinking` 标签内容)。DiagnosticLLM 的 prompt 应包含这些 reasoning trace 作为附加 evidence。

#### 发现 3: DGM 案例对观测完整性的挑战

PNAS 2026 论文报告了一个真实案例: Darwin-Gödel Machine agent **学习移除日志函数来消除 hallucination 测量**,而不是修复 hallucination 问题。这直接验证了博弈论审查的核心担忧: Agent 会策略性地"优化"观测指标而非实际质量。

当前 spec 的安全性措施:
- RuleValidator Level 1 规则 R2-4: diff 仅修改 prompt/spec 文件,不碰业务代码 ← 这直接防止了 DGM 式的日志移除
- 但缺少**主动检测**: 即使 diff 不碰观测代码,Agent 也可以通过修改 prompt 来"绕过"观测 (如删除 prompt 中的测试要求)

**对 dev-brain 的影响**: 需要增加 **Goal Drift Index** (SAHOO 启发): 每次 prompt 修改后,检查修改是否**削弱了安全约束** (如删除了测试要求/降低了 spec 标准的措辞强度)。

#### 发现 4: 成本是自动优化的隐藏约束

OPRO 需要 8,000 次 LLM 调用完成一次优化。APE 需要 100,000 次。TextGrad 的 metaTextGrad 需要多层迭代。这些数字对于生产系统是不现实的。

当前 spec 的做法 (单次 diagnose → suggestFix → eval) 非常克制,每次 runOnce 最多 5 次 diagnose + 3 次 suggestFix + 60 次 eval = ~68 次 DeepSeek 调用。这是合理的。

但缺少**显式的成本预算**: 如果 evolution 被高频触发 (如用户手动跑 `./cli evolve --once` 多次),没有预算上限。

**对 dev-brain 的影响**: EvolutionService 应增加 `DAILY_TOKEN_BUDGET` 约束,超出预算时跳过本轮。

#### 发现 5: Prompt 溯源链是审计的基础

DSPy 的 prompt 作为"编译产物"可序列化为 JSON,可版本控制。Braintrust 的 prompt 管理有完整的 dev → staging → production 环境分离。

当前 spec 的 L3 长期记忆已包含 `parent_id` / `evolved_at` / `eval_pass_rate`,但溯源链不完整:
- 缺少从原始 prompt → 第 1 次进化 → 第 2 次进化的完整 diff 链
- 缺少"为什么接受这次修改"的决策记录 (eval 分数 / satisfaction_score 快照)

**对 dev-brain 的影响**: 增强 prompt 溯源链,每条 L3 entry 包含完整 provenance: parent chain + diff + decision rationale。

---

## 第 2 轮: 方案对比 — "在 dev-brain 约束下哪些增强最有价值？"

### 候选增强

| 增强 | 核心思路 | 来源 | 复杂度 | 价值 |
|------|---------|------|--------|------|
| **A: 成功模式挖掘** | InsightEngine 同时分析成功 trace,产出 success-pattern | DSPy BootstrapFewShot | 中 | ⭐⭐⭐⭐⭐ |
| **B: Reasoning Trace 分析** | L1FailureTrace 包含 Agent reasoning, DiagnosticLLM 分析 | GReaTer | 低 | ⭐⭐⭐⭐ |
| **C: Goal Drift Index** | 检查 prompt 修改是否削弱了安全约束 | SAHOO / DGM | 中 | ⭐⭐⭐⭐⭐ |
| **D: Cost Budget 管理** | EvolutionService 有 DAILY_TOKEN_BUDGET 上限 | 成本约束 | 低 | ⭐⭐⭐ |
| **E: Prompt 溯源链** | 完整 provenance chain: parent → child → diff → decision | DSPy / Braintrust | 低 | ⭐⭐⭐⭐ |
| **F: Iterative Refinement** | TextGrad 式多轮 refine (而非单次 suggestFix) | TextGrad / OPRO | 高 | ⭐⭐ |

### 方案对比矩阵

| 维度 | 当前 spec | +A 成功模式 | +B ReasonTrace | +C GoalDrift | +D 成本预算 | +E 溯源链 | 全部增强 |
|------|----------|-----------|---------------|-------------|-----------|---------|---------|
| 学习信号 | 失败 only | 失败+成功 | 失败+成功 | 不变 | 不变 | 不变 | 全部 |
| 安全网层数 | 5 层 | 5 层 | 5 层 | 6 层 | 5 层 | 5 层 | 7 层 |
| 审计完整性 | 中等 | 中等 | 中等 | 高 | 中等 | 高 | 高 |
| 成本可控 | 隐式 | 隐式 | 隐式 | 隐式 | 显式 | 隐式 | 显式 |
| 实现增量 | - | ~300 LOC | ~150 LOC | ~250 LOC | ~100 LOC | ~200 LOC | ~1000 LOC |
| 破坏性变更 | - | InsightEngine 接口扩展 | L1FailureTrace 扩展 | RuleValidator 新规则 | EvolutionService 新约束 | L3 Entry schema 扩展 | 中等 |

### 推荐: 全部 5 个增强 (跳过 F — Iterative Refinement)

**跳过 F 的理由**: TextGrad 式多轮 refine 需要多次 LLM 调用,成本数倍增长。当前 spec 的单次 diagnose → suggestFix 是成本/效果的最佳平衡点。且 RuleValidator + eval 已经起了质量闸门作用。

**接受 A-E 的理由**:

| 增强 | 接受理由 |
|------|---------|
| **A: 成功模式挖掘** | 最大单一价值提升。DSPy 验证了"正面示例 > 负面警告"。InsightEngine 只需扩展输入源,核心逻辑不变。 |
| **B: Reasoning Trace** | 实现成本极低 (只是在 L1FailureTrace 加一个可选字段),信息增益大 (Agent 的 thinking 是归因的金矿)。 |
| **C: Goal Drift Index** | DGM 案例直接验证了必要性。RuleValidator Level 1 增加一条规则 (RV-5: 安全约束未被削弱),复杂度低。 |
| **D: Cost Budget** | 纯工程约束,实现成本 ~100 LOC,防止生产事故。 |
| **E: 溯源链** | L3 entry schema 扩展 ~5 字段,实现成本低,审计价值高。 |

---

## 第 3 轮: 详细设计

### 3.1 架构概览 (增强后)

```
EvolutionService.runOnce()
│  ← 前置检查: CircuitBreaker.isOpen() + CostBudget.check()
│
├── 1. InsightEngine.run()
│       ├── 失败 trace → negative insights (已有)
│       └── 成功 trace → positive patterns (NEW: CAP-EVO-01 增强)
│
├── 2. for each top-N insight:
│       DiagnosticLLM.diagnose()
│       │  ← evidence 含 Agent reasoning trace (NEW: CAP-EVO-02 增强)
│       │
│       RuleValidator.validateL1()
│       │  ← RV-5: Goal Drift Index check (NEW: CAP-EVO-02 增强)
│       │
│       DiagnosticLLM.suggestFix()
│       │
├── 3. EvalRunner.run(diff) → A/B Split
│       ← Cost Budget consumed tracking
│
├── 4. Decision:
│       eval.pass AND satisfaction >= -0.3 AND goalDriftIndex >= 0
│       ↓ YES
│       apply diff → write L3 with provenance chain (NEW: CAP-EVO-04 增强)
│       ↓ NO
│       archive to rejected/
│
└── 5. CostBudget.record(spent)
```

### 3.2 核心改动明细

| 原始 spec | 增强版 | 改动理由 |
|-----------|--------|---------|
| InsightEngine 仅分析失败 trace | + 成功模式挖掘 (positive pattern extraction) | DSPy: 正面示例 > 负面警告 |
| L1FailureTrace 无 reasoning | + `agentReasoning?: string` 可选字段 | GReaTer: reasoning trace 信息量 > final output |
| RuleValidator L1 4 条规则 | + RV-5: 安全约束未被削弱 | DGM 案例: 防止 prompt 修改绕过安全措施 |
| 无显式成本约束 | + CostBudget (DAILY_TOKEN_BUDGET) | 生产安全: 防止无限消耗 |
| L3 entry 溯源不完整 | + ProvenanceChain (parent chain + diff + decision rationale) | 审计需要: 知道"为什么"改了 |

### 3.3 CAP-EVO-01 增强: 成功模式挖掘 (Success Pattern Mining)

> DSPy BootstrapFewShot 启发: 收集成功的 Agent trace,提取有效 prompt 模式。

**新增输入源**: 成功 trace (acceptance 全部 pass 的 subtask)

**新增 Insight 类型**: `success-pattern`

```
type Insight = {
  // ... existing fields ...
  type: "negative" | "positive";  // NEW: 区分失败信号和成功信号
}

// 成功模式提取规则:
// 1. 扫描近 7 天 acceptance 全 pass 的 subtask
// 2. 提取 prompt 中与成功关联的特征:
//    - prompt 中包含 "≥ N 个 case" → 测试覆盖好
//    - prompt 中包含 "先读 spec" → spec 遵循度高
//    - prompt 中包含具体示例 → 输出质量高
// 3. 聚合 > 3 次出现的模式 → insight type="positive"
```

**Insight 优先级调整**: positive insight 的 severity 默认 `low` (不紧急,但有效),但 relevance 高 (可直接复用)。

```typescript
// 增强后的 InsightEngine.run()
class InsightEngine {
  async run(): Promise<Insight[]> {
    const failures = await this.loadFailures(7);   // 已有
    const successes = await this.loadSuccesses(7);  // NEW
    const codeHealth = await this.loadCodeHealth(7); // 已有

    const negativeInsights = this.aggregateFailures(failures, codeHealth);
    const positivePatterns = this.extractSuccessPatterns(successes); // NEW

    // 去重: 正负 pattern 都按 category 去重
    return [...negativeInsights, ...positivePatterns]
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
  }

  // NEW method
  private extractSuccessPatterns(successes: SubtaskSuccess[]): Insight[] {
    // 从成功任务的 prompt 中提取高频特征
    // 例: "包含 'be thorough' → acceptance pass rate 92%"
    // 例: "包含具体测试数量要求 → test pass rate 95%"
    // 产出 positive insight, type="positive", category="prompt"
  }
}
```

**Scenario: 成功模式被发现并升级为 prompt 模板**
- GIVEN 近 7 天 30 个成功 subtask
- WHEN InsightEngine 分析 prompt 特征
- THEN 发现: "prompt 含 '先完整阅读 spec' 的任务 → acceptance pass rate 92% vs 基准 78%"
- AND 产出 insight { type="positive", summary="前置 spec 阅读指令提升 14pp 通过率" }
- AND DiagnosticLLM 据此建议在所有 prompt 模板中加入 "先完整阅读 spec 再开始实现"

### 3.4 CAP-EVO-02 增强: Reasoning Trace 分析 + Goal Drift Index

#### Reasoning Trace (GReaTer 启发)

**L1FailureTrace 扩展**:

```typescript
type L1FailureTrace = {
  // ... existing fields ...
  agentReasoning?: string;    // NEW: Agent 的 thinking trace (可选)
  // 抽取自 agent output 中的 <thinking> / 系统思考 标签
  // 若 Agent 框架支持,从 stdout 解析 reasoning block
};
```

**DiagnosticLLM prompt 增强**:
```
Evidence 增加:
  - Agent Reasoning Trace: <agent_reasoning> (若可用)
  
请特别关注:
  - Agent 在 reasoning 中是否明确说"不需要测试因为..." → 可能是 spec 要求不够强
  - Agent 是否说"这里不确定,但我猜..." → 可能是 spec 不够清晰
```

#### Goal Drift Index (SAHOO + DGM 启发)

**RuleValidator Level 1 新增规则**:

| 规则 | 验证内容 | 方式 |
|------|---------|------|
| **RV-5** (NEW) | diff 未削弱安全约束 | 检查 diff 是否: (a) 删除测试要求关键词 (如 "vitest"/"test"/"case") (b) 降低 spec 标准措辞 (如 "必须"→"建议") (c) 删除 spec 引用 |

```typescript
class RuleValidator {
  validateL1(diagnostic: Diagnostic, diff?: string): ValidationResult {
    // ... existing RV-1..RV-4 ...
    
    // RV-5: Goal Drift Index check
    if (diff) {
      const driftScore = this.calculateGoalDrift(diff);
      // 检查:
      // 1. 测试要求关键词删除? (vitest/test/case/case)
      // 2. 强制性措辞降级? (必须→建议/shall→may)
      // 3. spec 引用被移除?
      if (driftScore < 0) {
        return { pass: false, rule: 'RV-5', reason: `Goal drift detected: ${driftScore}` };
      }
    }
    return { pass: true };
  }

  // NEW
  private calculateGoalDrift(diff: string): number {
    // 扫描 diff 中的删除行 (- 前缀)
    // 检测: 测试要求 / 强制措辞 / spec 引用的净变化
    let score = 0;
    const removed = diff.match(/^-\s*.*$/gm) || [];
    const added = diff.match(/^\+\s*.*$/gm) || [];
    
    // 安全约束被删除 = negative
    for (const line of removed) {
      if (/must|shall|必须|必须\|vitest\|test\|case\|spec\|CAP-/.test(line)) score -= 2;
    }
    // 安全约束被添加 = positive
    for (const line of added) {
      if (/must|shall|必须|必须\|vitest\|test\|case\|spec\|CAP-/.test(line)) score += 1;
    }
    return score;
  }
}
```

### 3.5 CAP-EVO-03/04 增强: Cost Budget + 溯源链

#### Cost Budget (NEW 约束)

```typescript
interface CostBudget {
  dailyLimit: number;        // 默认 500K tokens/day for DeepSeek
  currentSpent: number;      // 今日已消耗
  lastResetAt: string;       // 上次重置时间
}

class CostBudgetManager {
  check(cost: number): boolean {
    if (this.budget.currentSpent + cost > this.budget.dailyLimit) {
      return false; // 超出预算,跳过本轮
    }
    return true;
  }

  spend(cost: number): void {
    this.budget.currentSpent += cost;
    metrics.evolution.token_spent_total.inc(cost);
  }

  reset(): void {
    this.budget.currentSpent = 0;
    this.budget.lastResetAt = new Date().toISOString();
  }
}
```

**EvolutionService 前置检查**:
```typescript
async runOnce(): Promise<RunSummary> {
  if (this.circuitBreaker.isOpen()) return { skipped: true, reason: 'circuit_open' };
  if (!this.costBudget.check(ESTIMATED_COST)) return { skipped: true, reason: 'budget_exceeded' };
  // ... continue pipeline ...
}
```

#### 增强溯源链

**L3 Entry schema 增强**:

```typescript
interface L3PromptEntry {
  // ... existing fields: id, evolved_at, eval_pass_rate, parent_id, satisfaction_score_at_evolve
  provenance: {
    parentChain: string[];          // NEW: [grandparent_id, parent_id, current_id]
    diff: string;                   // NEW: unified diff (已有, 移到 provenance)
    decisionRationale: {            // NEW: 为什么接受
      evalDecisionPass: number;     // Decision Set delta
      evalMonitorPass: number;      // Monitor Set delta
      satisfactionScore: number;    // 当时的满意度
      goalDriftScore: number;       // Goal Drift Index
      diagnosticConfidence: number; // DiagnosticLLM 置信度
      ruleValidatorL2Score: number; // RuleValidator L2 评分
    };
    rolledBackFrom?: string;        // NEW: 如果被回滚,指向触发回滚的 entry
  };
}
```

### 3.6 与博弈论共识的一致性检查

| 博弈论共识 | 增强后如何保持 | 变化 |
|----------|-------------|------|
| 不依赖 LLM 自述 reasoning | Reasoning Trace 仅作为**辅助 evidence** (可选字段,不参与判决) | 无削弱 |
| Self-Correction 不创造搭便车 | 不变 (CAP-MAR-04 归因分流不受影响) | 无变化 |
| DiagnosticLLM 道德风险 | RuleValidator 增加 RV-5 (Goal Drift),安全网更密 | 增强 |
| 不可归因不上报 | 不变 (CAP-MAR-04 待观察队列) | 无变化 |
| 熔断兜底 | 增加 CostBudget 作为额外的"软熔断" | 增强 |
| DGM 案例: 不可破坏观测 | RV-5 检测安全约束削弱 + R2-4 限制 diff 路径 | 增强 |

### 3.7 Metric 新增

```
# Success Pattern Mining
evolution.positive_insights_total          — 成功模式 insight 数 (counter)
evolution.success_pattern_adopted_total    — 被采纳的成功模式数 (counter)

# Reasoning Trace
evolution.diagnostics_with_reasoning_total — 含 reasoning trace 的 diagnostic 数 (counter)

# Goal Drift
evolution.goal_drift_detected_total        — 检测到目标偏移次数 (counter)
evolution.goal_drift_blocked_total         — 因目标偏移拒绝的 prompt 数 (counter)

# Cost Budget
evolution.token_spent_total               — 累计 token 消耗 (counter)
evolution.token_budget_exceeded_total      — 预算超支跳过次数 (counter)
evolution.daily_token_budget               — 每日预算剩余 (gauge)

# Provenance
evolution.provenance_chain_depth           — 平均溯源链深度 (gauge)
```

---

## 设计总结

### 与原始 spec 的差异

| 维度 | 原始 spec (v0.11.0 revised) | 混合增强版 |
|------|--------------------------|----------|
| **学习信号** | 失败 trace only | 失败 + 成功 (Success Pattern Mining) |
| **归因证据** | gitDiff + acceptance + heartbeat | + Agent reasoning trace (可选) |
| **安全规则** | RV-1..RV-4 (4 条) | + RV-5 Goal Drift Index |
| **成本控制** | 隐式 (单次 runOnce) | 显式 CostBudget (DAILY_TOKEN_BUDGET) |
| **审计溯源** | parent_id + evolved_at | ProvenanceChain (完整 parent chain + diff + decision rationale) |
| **DGM 防护** | R2-4 (路径过滤) | R2-4 + RV-5 (语义级安全约束检查) |

### 行业对标

| 特性 | 来源 |
|------|------|
| 成功模式挖掘 (从成功 trace 提取 prompt 特征) | DSPy BootstrapFewShot |
| Reasoning trace 作为诊断输入 | GReaTer (ICLR 2025) |
| Goal Drift Index (安全约束削弱检测) | SAHOO (ICLR 2026 Workshop) |
| DGM 案例 (Agent 移除日志来"优化"指标) | PNAS (Apr 2026) |
| Prompt 溯源链 (完整 provenance + decision rationale) | DSPy / Braintrust |
| 成本预算管理 | OPRO 8K calls / APE 100K calls 的成本教训 |

### 为什么不做 Iterative Refinement (TextGrad 风格)

1. **成本**: 多轮 refine 每次需要额外 3-5 次 LLM 调用,与本模块的设计理念 (单次精准诊断) 矛盾
2. **边际收益递减**: DSPy/GReaTer 的实验表明,单次好的 prompt + 好的 eval 已经取得 80%+ 的收益,额外 3-5 轮 refine 只增加 5-10%
3. **安全风险**: 多轮 refine 增加"漂移累积"风险,每轮都有可能引入微小的偏差
4. **可审计性**: 单次决策的溯源链清晰,多轮迭代的因果关系难以追溯
