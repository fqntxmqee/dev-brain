# AI Native OS 待办事项

**日期**: 2026-06-06
**状态**: 待后续讨论

本文记录 Claude 和 Codex 讨论中**尚未达成共识**或**尚未充分讨论**的议题，作为后续迭代的输入。

---

## 未达成共识的议题

> 当前无。经过四轮辩证讨论，所有 P0 议题均已达成共识并更新至 spec 规范中。

---

## 待深入讨论的议题（Codex 第三轮提出的开放问题）

### 1. L1 归因引擎的 FailureTrace 格式

**背景**: 归因引擎需要 L1 可信源数据。当前在 CAP-MAR-04 中定义了初步的 `L1FailureTrace` 类型，但以下细节待明确:

- 每个字段的采集时机和性能开销
- `acceptance` 数组中各阶段 detail 的结构化格式
- `gitDiff` 是否应包含 `git diff --stat` 还是完整 diff
- 与 v0.10.0 audit.log 的兼容和迁移路径

**状态**: 类型定义已写入 CAP-MAR-04 spec，具体实现细节待后续讨论。

### 2. RuleValidator Level 2 规则定义

**背景**: Level 1 规则（门槛级）已在 CAP-EVO-02 中明确定义。Level 2 规则（加分级）初始版本:

| 规则 | 描述 | 验证方式 |
|------|------|---------|
| R2-1 | fix 引用具体 spec 条款 | 正则匹配 `CAP-[A-Z]+-\d+` |
| R2-2 | fix 包含量化指标 | 检测数字+单位模式 |
| R2-3 | rootCause 分类与历史 pattern 一致 | 与 insight-engine 分类比对 |
| R2-4 | diff 仅修改 prompt/spec 文件 | `git diff --stat` 路径过滤 |

待讨论: 
- 规则数量和阈值的校准（是否需要 A/B 测试规则本身）
- 规则配置文件 `config/rule-validator.yaml` 的具体 schema
- Level 2 规则是否也可以被 Evolution 优化（eat your own dog food）

**状态**: 初始规则集已写入 CAP-EVO-02 spec，配置文件 schema 待后续讨论。

### 3. 用户反馈的量化权重

**背景**: 在 CAP-EVO-06 中定义了 thumbs_up = +1, thumbs_down = -2, 无操作 = 0。权重选取的理由:

- thumbs_down = -2 是因为用户倾向不主动点负反馈（需要更大的信号强度）
- 72h 无操作 = 0 是因为沉默不等于满意或不满意

待讨论:
- 72h 窗口是否合适（用户可能周末不工作）
- 是否需要"满意度细分"（不止 thumbs up/down，增加 5 星评分）
- satisfaction_score 的 -0.3 阈值是否需要通过 A/B 校准

**状态**: 初始权重和阈值已写入 CAP-EVO-06 spec，实际值需在 Phase E 运行后通过数据校准。

---

## Claude 工程评审中提出但未纳入 spec 的议题

以下议题属于工程实现层面，不影响 Phase E 核心机制设计，可在实施过程中讨论:

### P1 级别

### P1-1: L2 压缩触发条件不一致 ✅ 已解决

**问题**: tasks.md 写"5 round 触发"但 spec 中同时提到 50K/80K token 阈值。两者需要统一为 token-based 触发。

**当前状态**: 已通过 context-engine 深度设计解决。新设计采用 4 种触发条件 (T1: 会话结束 / T2: 每 6h 定时 / T3: L2 >50K 警告 / T4: L2 >80K 紧急前台兜底),同步更新至 spec/proposal/tasks。

### P1-2: 心跳 stdout 解析的稳健性

**问题**: `__dev_brain_heartbeat__` 通过 stdout 解析，Agent 可能在代码生成中意外输出此令牌。

**当前状态**: 未修改。Codex 在优先级矩阵中将其列为 P1（鲁棒性）。建议 Phase F 实施时考虑 side channel 方案（fd 3 / Unix socket）。

### P1-3: 多模态 prompt injection 防护

**问题**: OCR 文本直接注入 system prompt，攻击者可通过构造截图注入恶意 prompt。

**当前状态**: 未修改。建议 Phase F 实施时增加 OCR 文本清洗步骤。可参考 OWASP LLM 安全指南。

### P2 级别

### P2-1: 僵尸代码检测 4 条件 AND 逻辑

**问题**: 仅格式修改可能刷新 mtime, 导致实质性僵尸代码逃逸检测。

### P2-2: 代码态观测多语言扩展

**问题**: `ts-morph` 只支持 TypeScript，无法分析项目中 Go/Rust/Python 组件。

### P2-3: 跨项目 L3 记忆学习

**问题**: L3 是 per-project 的，无法从多项目经验提取跨项目模式。

### P2-4: StateMachine 扩展性

**问题**: 6 状态简单状态机对未来并行子任务、条件分支场景可能不足。

### P2-5: InsightEngine 关键词分类 → LLM-based 分类演进

**问题**: 关键词启发式分类在不同 LLM 表述下会失效。

---

## 后续行动建议

1. **近期**（Phase D 实施期间）: 讨论 L1 FailureTrace 采集格式和 RuleValidator Level 2 规则细节
2. **中期**（Phase E 实施期间）: 通过实际数据校准用户反馈权重和满意度阈值
3. **长期**（v0.12.0+）: 解决 P2 级别的架构演进问题

---

*关联文档:*
- *最终共识矩阵: `review/round-4-claude-final.md`*
- *所有 spec 更新已反映在: `openspec/changes/ai-native-os/specs/`*
