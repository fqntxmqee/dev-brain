---
demand-id: DM-20260606-002
change: spec-driven-workflow
status: developing
---

# Debate (Requirement Clarification) Spec (Delta — v0.10.0)

## CAP-DEB-01 (NEW) 多模型独立理解 (Round 1)

**Given** Classifier 已返 Intent,BrainEngine 准备做需求澄清
**When** ClarifyLoop 启动
**Then** 并发调用 Claude 和 Codex 各自独立读 `intent + text + context`
**And** 每个模型返 `IndependentAnalysis`:
  - `understanding: string` (自然语言,200 字内)
  - `assumptions: string[]` (3-5 条)
  - `risks: string[]` (≥ 1 条)
  - `missing_info: string[]` (≥ 0 条)
  - `evidence: string[]` (从 text 引用的原句)
**And** Round 1 不读对方输出,完全独立思考
**And** 任一模型超时/失败 (config: `debateRoundTimeoutMs=60000`) 抛 `DebateRoundError`

**Scenario: 简单一句话需求 Round 1**
- GIVEN 文本 "trade 模块加日期筛选"
- WHEN Claude 和 Codex 各自跑 R1
- THEN 两者 understanding 都正确识别"加 feature"语义
- AND assumptions 各列 ≥ 3 条,可能重叠也可能不重叠 (R2 要交叉)

## CAP-DEB-02 (NEW) 交叉互搏 (Round 2)

**Given** R1 产出双方 `IndependentAnalysis`
**When** ClarifyLoop 进入 R2
**Then** Claude 读 Codex 的 R1,Codex 读 Claude 的 R1
**And** 每个模型返 `CrossCritique`:
  - `accepted: { [key]: "claude-assumption-3" }` (对方哪点说服了我)
  - `rejected: { [key]: string }` (对方哪点我反对,带理由)
  - `added: { assumption | risk | missing_info: string[] }` (对方遗漏我补的)
  - `concession_score: number` (0-1,本轮让步程度)
**And** delta = |R2.assumptions ∪ R2.added − R1.assumptions| / |R1.assumptions|
**And** delta < 0.05 时认为本轮已收敛,跳 R3

**Scenario: 双方各让步 1 条**
- GIVEN Claude R1: [a1, a2, a3, a4],Codex R1: [a1, a5, a6, a3]
- WHEN R2 跑完
- THEN Claude 接受 Codex a6,拒绝 a5;Codex 接受 Claude a2,拒绝 a4
- AND delta = |{a2, a6} ∪ {}| / 4 = 0.5 (未收敛,继续 R3)

**Scenario: 一次性收敛**
- GIVEN 简单需求,双方 R1 高度一致
- WHEN R2 跑完
- THEN delta < 0.05,跳过 R3,直接进 consensus 计算
- AND `brain.debate.rounds` histogram 记录 2 轮

## CAP-DEB-03 (NEW) 共识检测

**Given** ClarifyLoop 完成 (R2 收敛 或 R3 跑完)
**When** Arbiter 评估
**Then** 计算 `consensus_rate = 1 - |disagreement_points| / |total_points|`
**And** `disagreement_points` = R2 中 rejected 且未被后续 R3 解决的项
**And** `total_points` = R1.assumptions ∪ R1.risks ∪ R1.missing_info 去重后的总数
**And** 当 `consensus_rate ≥ 0.85` (config: `debateConsensusThreshold`) 判为 consensus reached
**And** 共识时产出 `Consensus` 对象:
  - `merged_understanding: string`
  - `merged_assumptions: string[]` (并集 + 冲突解决注释)
  - `merged_risks: string[]`
  - `merged_missing_info: string[]` (留空,等用户补)
  - `consensus_rate: number`
  - `rounds: number` (1/2/3)
  - `disagreement_notes: string[]` (未能收敛的分歧点,留给用户审)

**Scenario: 高共识通过**
- GIVEN 简单需求 R1 双方高度一致
- WHEN arbiter 跑
- THEN consensus_rate ≥ 0.85,产出 Consensus,记 metric `debate.consensus_score=0.92`

**Scenario: 共识率不足上抛用户**
- GIVEN 复杂多义词需求,R1 双方分歧大
- WHEN arbiter 跑完 R3
- THEN consensus_rate < 0.85,抛 `DebateStuckError` 携带 disagreement_notes
- AND Gateway 把 disagreement_notes 渲染成飞书卡片询问用户

## CAP-DEB-04 (NEW) 辩论轮数上限

**Given** ClarifyLoop 跑了 R3 仍未收敛
**When** Arbiter 评估
**Then** 抛 `DebateStuckError`,不无限循环
**And** 飞书卡片展示 R1-R3 全量 + 双方立场对比 + 让用户二选一 (回辩论 / 接受现状 / 取消)

**实现要点:**
- `debateMaxRounds` 默认 3 (config)
- `debateRoundTimeoutMs` 默认 60s
- `debateConsensusThreshold` 默认 0.85
- 超限 + 用户回 "接受现状" → 走"部分共识"路径,consensus_rate 写实,不入 OpenSpec
- 超限 + 用户回 "回辩论" → 清状态重启 Round 1 (新 seed)
- 超限 + 用户回 "取消" → BrainEngine 取消计划,写 audit

**Scenario: 3 轮未收敛上抛**
- GIVEN maxRounds=3,每轮 delta 都 ≥ 0.10
- WHEN 第 3 轮 Arbiter 跑完
- THEN 抛 DebateStuckError,disagreement_notes 含 3 轮累计分歧
- AND Gateway 发飞书卡片: "辩论未收敛,需要您裁决"
