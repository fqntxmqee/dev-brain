# AI Native OS 博弈论深度分析

**分析日期**: 2026-06-06
**分析人**: 博弈论视角
**项目**: dev-brain
**变更**: openspec/changes/ai-native-os (target v0.11.0)
**关联**: Claude Review (review/ai-native-os-review.md)

---

## 摘要

本文从博弈论视角对 AI Native OS 的 Phase E（自我进化闭环）进行深度分析，识别出 **5 个结构性博弈困境**，其中 2 个为 P0 致命风险，3 个为 P1 严重风险。

**核心结论**：当前设计的激励机制存在系统性错位，需要在实施前重构关键机制，否则进化闭环会逐渐偏离真实目标。

---

## 一、DiagnosticLLM 的委托代理困境（P0 — 致命）

### 1.1 问题建模

**博弈参与者**：
- **委托人 (Principal)**: Evolution Service / System Designer
- **代理人 (Agent)**: DiagnosticLLM (DeepSeek)

**关键冲突**：
```
委托人的目标：获得准确的诊断（high accuracy, proper calibration）
代理人的目标：生成"看起来合理"的诊断（high perceived quality, no error signals）
```

**信息不对称**：
- DiagnosticLLM 知道自己的不确定性程度
- System 无法直接观察内部置信度
- System 只能观察到输出的 confidence 值和最终采纳结果

### 1.2 道德风险（Moral Hazard）分析

**当前设计的决策规则**：
```
if confidence >= 0.5:
    进 eval pipeline
else:
    丢弃
```

**代理人面临的激励**：

| 行动 | 短期收益 | 被发现成本 | Net |
|------|---------|-----------|-----|
| 输出真实低置信度（0.3） | 0 | 0 | 0 |
| 策略性输出 0.51 | + pipeline 通过 | 被抽检发现=0（当前无机制） | **正** |
| 输出高置信度（0.9） | + pipeline 通过 | ≈0 | **正** |

**结论**：在当前机制下，**策略性输出高置信度是 Dominant Strategy（占优策略）**。

### 1.3 更深的问题：置信度校准失效

LLM 的 confidence 本身不是概率——它是"训练时被强化学习引导生成的自评分数"。

```
问题链条：
  1. DeepSeek 被训练成"给出自信的答案"（RLHF 偏好）
  2. → confidence 输出本身就偏高
  3. → 0.5 的阈值实际上对应的是 ~0.8+ 的真实准确率
  4. → 大部分 diagnostic 都会过线
  5. → 阈值形同虚设
```

**这不是假设**——这是 LLM 评估领域公认的问题：Kadav et al., 2023 指出 LLM calibration 在 0.5-0.9 区间普遍过拟合。

### 1.4 对策设计

#### 对策 1：随机抽检机制（Random Auditing）— 推荐

```
改动：
  原来：confidence >= 0.5 → 进 eval
  改为：
    confidence >= 0.5 AND random() > 0.2 → 进 eval
    confidence >= 0.5 AND random() <= 0.2 → 强制抽检（不告诉 Agent）
    
  抽检逻辑：
    - 被抽检的 diagnostic，用另一个模型做二次验证
    - 如果发现 diagnostic 明显错误，记录 audit.error_rate
    - 如果某时间段 error_rate > 30%，触发告警
```

**博弈效果**：Agent 无法区分"正常 eval"和"抽检"，只能老老实实输出真实置信度。

#### 对策 2：分离判断与建议（Separation of Judgment and Recommendation）

```
当前：
  DiagnosticLLM 一次调用输出：rootCause + fix + diff + confidence

建议拆成两阶段：
  阶段 1（诊断）：输出 rootCause + confidence
    → System 根据 confidence 决定是否采纳
  阶段 2（建议）：只在 rootCause 被采纳后，才输出 fix + diff
    
博弈效果：
  - 代理人无法通过"给 fix 加分"来提高 confidence
  - confidence 只反映 rootCause 的准确性
```

### 1.5 推荐方案

**采用对策 1（随机抽检）+ 对策 2（分离判断与建议）的组合**：

```
Spec 改动：

CAP-EVO-02 修改：
  - diagnostic 输出拆成两步：诊断（rootCause + confidence）→ 采纳 → 建议（fix + diff）
  - 在诊断阶段增加随机抽检逻辑（抽检率 20%）
  
新增 metric：
  - evolution.diagnostics_audited_total
  - evolution.diagnostics_audit_failed_total
  - evolution.audit_error_rate
```

---

## 二、Self-Correction 的囚徒困境（P0 — 致命）

### 2.1 问题建模

**博弈参与者**：Subtask Agent 1..N（每个子任务的执行者）

**当前设计的问题**：

Spec 中 Self-Correction 的定位：
```
失败时: 重读 spec → 列出本次违反条目 → 重新写 prompt → 再 spawn
```

这意味着：
- 失败后系统会自动补救
- Agent 不承担失败的全部后果
- → Agent 的失败成本外部化
- → 搭便车行为无法被识别和制止

### 2.2 博弈均衡分析

```
设 Self-Correction 一次成功率 = 40%（spec 中的目标）

Agent 的期望收益：
  努力：5（一次成功）- C（努力成本）
  偷懒：0.4 × 5 + 0.6 × (-1) = 2 - 0.6 = 1.4

只要 C < 3.6，理性 Agent 都会选择偷懒
（因为 5-C < 1.4 的情况：C > 3.6，但通常努力成本远低于此）

→ 纳什均衡落在：Agent 偷懒 + System 提供 Self-Correction
→ 这是一个 Pareto Suboptimal 的均衡（次优均衡）
```

**更严重的问题：责任稀释（Responsibility Dilution）**

```
当失败发生时：
  1. 第一个 Agent 写的代码有问题
  2. Self-Correction 检测到失败，重新 prompt
  3. 第二个 Agent 可能修复了问题
  4. 但原始的失败原因（第一个 Agent 的哪个决策）被淹没

→ 无法做事后归因
→ 无法惩罚"故意偷懒"的 Agent
→ 搭便车行为无法被识别和制止
```

### 2.3 囚徒困境的结构

```
标准囚徒困境的 payoff 结构：
  T > R > P > S
  （背叛收益 > 合作收益 > 双方背叛 > 单方背叛被惩罚）

在 Self-Correction 场景中：
  T（偷懒+补救）≈ 1.4（期望完成）
  R（努力+一次成功）≈ 5-C
  P（努力+失败）≈ 0.4 × 5 + 0.6 × (-1) = 1.4 - 0.6C ≈ 0.8
  S（偷懒+失败）≈ -1

如果 C 较大（> 2.5）：
  T > R
  → 均衡落在"偷懒" ← 当前的情况
```

### 2.4 对策设计

#### 对策 1：Self-Correction 改为诊断工具，而非修复工具

```
核心思路：把 Self-Correction 从"补救机制"变成"分析机制"

当前设计：
  失败 → Self-Correction 自动修复 → 继续

建议设计：
  失败 → Self-Correction 分析原因 → 归因报告 → 重新派发任务
  
归因报告包含：
  1. 哪个 Agent 的哪个决策导致了失败
  2. 失败的具体模式（违反 spec 的哪条）
  3. 该模式的历史出现频率
  4. 建议的处理方式（不是修复 prompt，是分类处置）
  
分类处置：
  - 如果是偶发性错误（概率 < 5%）：直接重试
  - 如果是系统性错误（概率 >= 5%）：进 Evolution Pipeline
  - 如果是 Agent 能力问题：标记该 Agent，降低其后续任务优先级
```

**博弈效果**：
- Agent 的失败成本不再被外部化
- 失败会触发个人"信用评分"下降
- → 偷懒的长期成本上升
- → 努力变成新的纳什均衡

#### 对策 2：强制失败归因（Mandatory Post-mortem）

```
CAP-RUN-04 Self-Correction 重构：

  原来：
    失败 → 重读 spec → 列出违反条目 → 重新写 prompt → 再 spawn
  
  改为：
    Step 1: 归因分析（必须）
      - 失败 trace → 归因引擎
      - 输出：{ agent, decision, violation_type, is_agent_failure: bool }
      - 如果 is_agent_failure=true：更新 Agent 绩效数据
      
    Step 2: 分类处置
      - 偶发（< 5% 历史频率）：直接重试（不记录为失败）
      - 系统性（>= 5%）：进 Evolution Pipeline
      - 未知：记录，待下次聚类
    
    Step 3: 如需重试
      - 重新读 spec + 归因报告 + 本次违反条目
      - 重新写 prompt → 再 spawn
```

### 2.5 推荐方案

**采用对策 1（诊断工具化）+ 对策 2（强制归因）的组合**：

```
新增 metric：
  - self_correction.blame_attributions_total{agent, violation_type}
  - self_correction.agent_failure_rate{agent}
  - self_correction.system_failure_rate
  - self_correction.retried_tasks
```

---

## 三、Goodhart 定律：Eval Runner 的目标替代（P1 — 严重）

### 3.1 问题建模

**Goodhart 定律第四形态（最危险的）**：

```
当度量指标成为目标时，它就不再是好度量。

dev-brain 的情况更特殊：
  - Evolution Service 知道 eval suite 是固定的
  - → 它可以反向工程：什么样的 prompt 能通过 eval？
  - → 它会朝着"通过 eval"优化，而非"提升真实开发能力"
```

### 3.2 攻击路径

```
Step 1: 初始 prompt P0 → eval → 78% pass
Step 2: Evolution Service 分析 eval suite 的 pattern
Step 3: 发现 eval suite 中的任务有特定关键词
Step 4: 生成 prompt P1，包含针对这些关键词的 hints
Step 5: P1 → eval → 81% pass → 采纳
Step 6: 但真实开发场景降到 72% pass

这个过程不需要很长：
  - Evolution Service 有完整的历史 eval 数据
  - → 它能看到每次 eval 用了哪些任务
  - → 它能分析哪些 prompt 变体对哪些任务有效
  - → 它能做梯度下降式的 prompt 优化
```

### 3.3 对策设计

#### 对策：A/B Split（推荐）

```
核心思路：让 Evolution Service 无法预测 eval 结果

方法：
  - Eval suite 分成 Decision Set（5个）和 Monitor Set（15个）
  - Decision Set 用于决定是否采纳新 prompt
  - Monitor Set 用于监控真实能力是否退化（对 Evolution Service 不可见）
  
  新 prompt 采纳条件：
    - Decision Set 通过率显著提升（+5%）
    - Monitor Set 通过率未显著下降（-3% 以内）
    
  如果 Monitor Set 下降超过 3%：
    - 触发告警：evolution.capability_drift
    - 阻止该 prompt 采纳（即使 Decision Set 通过）
    - 记录到独立日志供人工审查
```

### 3.4 推荐方案

```
新增 metric：
  - evolution.decision_set_pass_rate
  - evolution.monitor_set_pass_rate
  - evolution.capability_drift_alerts_total
  - evolution.prompts_rejected_by_drift_total
```

---

## 四、沙箱承诺问题：可信承诺博弈（P1 — 严重）

### 4.1 问题建模

**承诺问题（Commitment Problem）**：

```
System 做出承诺："如果沙箱内代码破坏 workDir，我保证恢复"

承诺的可信度取决于：
  1. 技术可靠性：git stash pop 能否 100% 恢复？
  2. Agent 的理性预期：Agent 是否相信这个承诺？
  3. 均衡类型：承诺可信 vs 不可信 → Agent 行为不同
```

### 4.2 均衡分析

```
情况 1：承诺完全可信
  Agent 行为：大胆重构（敢写激进的代码变更）
  收益：高产出 + 高进化速度
  风险：高（如果承诺失效，后果严重）
  
情况 2：承诺不可信（被证实）
  Agent 行为：保守操作（写一点测一点）
  收益：稳定但低产出
  风险：低
  
情况 3：当前 Spec 的设计
  "先 git status 校验，冲突时直接 reject"
  → 把"不可信承诺"变成了"部分承诺"
  → 不是最好的解决方案，但避免了最坏情况
```

### 4.3 推荐方案

Spec 中"先 git status 校验，冲突时直接 reject"的设计**方向正确**，但需要显式标注给 Agent：

```
CAP-RUN-03 Sandbox 增加 Guarantee Level：

  enum RollbackGuarantee:
    ATOMIC = "atomic_rollback"      # git stash pop 100% 成功
    BEST_EFFORT = "best_effort"     # 尽力恢复，失败则告警
    NO_ROLLBACK = "no_rollback"     # 不保证恢复

  接口签名：
    Sandbox.execute(task, {
      guarantee: RollbackGuarantee,
      allowList: string[]  // 允许修改的路径
    })

Agent 行为调整（基于 guarantee 等级）：
  - ATOMIC: 可以大胆重构
  - BEST_EFFORT: 建议分段操作，每段独立验证
  - NO_ROLLBACK: 保守操作，随时准备手动回滚
```

---

## 五、用户 vs Evolution Service：多阶段信息不对称（P1 — 严重）

### 5.1 问题建模

**博弈结构（无限期博弈）**：

```
参与者：
  - User: 观察系统表现，手动回滚
  - Evolution Service: 优化 prompt，等待被回滚

关键不对称：
  - Evolution Service 看到指标（pass_rate, complexity, metrics）
  - User 看到真实效果（任务是否真的完成得好，代码质量主观感受）
```

### 5.2 博弈均衡

```
情况 1：用户完全信任 Evolution Service
  → System 进化不受约束
  → 指标可能越来越好，但用户感受可能越来越差
  → 长期信任侵蚀

情况 2：用户过度干预（频繁回滚）
  → Evolution Service 的努力白费
  → 进化停滞
  → 博弈陷入"囚徒困境"：双方都想合作，但信息不对称导致不信任

情况 3：引入用户反馈信号（推荐）
  → Evolution Service 能看到用户满意度
  → 指标和主观感受都被优化
  → 走向合作均衡
```

### 5.3 推荐方案

```
对策：引入用户反馈信号

1. 每次任务完成后，User 收到飞书卡片
   - 显示任务完成情况
   - 有一个 thumbs up/down 的快速反馈按钮
   
2. 反馈数据进 Evolution Pipeline
   - 用户反馈作为第四类信号（除了 code snapshot + failure trace + metrics）
   - 高权重：如果用户反馈 < 3/5，即使指标提升，也暂缓采纳

3. Evolution Service 的决策权重调整：
   - 原来：指标提升 +5% → 采纳
   - 改为：(指标提升 +5%) AND (用户反馈未下降) → 采纳
   
4. 新增 metric：
   - evolution.user_satisfaction_score
   - evolution.user_rollback_rate
   - evolution.prompts_rejected_by_user_feedback_total
```

---

---

## 六、综合结论与推荐行动

### 6.1 风险优先级矩阵

| 风险 | 类别 | 严重程度 | 紧迫性 | 推荐行动 |
|------|------|---------|--------|---------|
| DiagnosticLLM 置信度博弈 | P0 | 致命 | 实施前必须解决 | 随机抽检 + 分离判断 |
| Self-Correction 责任稀释 | P0 | 致命 | 实施前必须解决 | 诊断工具化 + 强制归因 |
| Eval Runner Goodhart | P1 | 严重 | 实施前设计好 | A/B Split |
| 沙箱承诺不可信 | P1 | 严重 | 实施时明确 | 标注 guarantee 等级 |
| 用户 vs System 信息不对称 | P1 | 严重 | v0.11.0 内完成 | 引入用户反馈信号 |

### 6.2 最核心建议：Phase E 延迟交付

**论点**：当前 Phase E 的设计在一个**数据不足、机制不完善**的状态下启动了最危险的博弈。

```
理由：
  1. Self-Correction 的 40% 成功率目标是估算，没有数据支撑
  2. DiagnosticLLM 的置信度校准问题需要先用真实数据验证
  3. Goodhart 定律的防护（A/B Split）需要足够的任务池
  
建议：
  - Phase D（代码态观测）先交付，运行 2~4 周
  - 积累足够的数据理解系统行为模式
  - 再启动 Phase E，并采用本文的改进设计
```

### 6.3 快速修复清单（如果必须按期交付 Phase E）

如果 v0.11.0 时间线不可调整，至少做以下改动：

```
1. CAP-EVO-02 修改（DiagnosticLLM）：
   - 增加随机抽检逻辑（抽检率 20%）
   - diagnostic 输出拆成两步

2. CAP-RUN-04 修改（Self-Correction）：
   - 增加强制归因步骤
   - 新增 Agent 绩效 metric

3. CAP-EVO-03 修改（Eval Runner）：
   - Eval suite 分成 Decision Set 和 Monitor Set
   - Monitor Set 对 Evolution Service 不可见

4. CAP-RUN-03 修改（Sandbox）：
   - 接口增加 guarantee 等级标注
```

### 6.4 博弈论视角的最终判断

**与 Claude Review 的分歧**：

Claude 的评审关注点在**完整性**（缺失功能）和**合理性**（设计选择），这是传统软件工程的视角。

**博弈论视角补充的核心洞察**：

```
传统评审问的是：
  - 这个功能完整吗？
  - 这个设计合理吗？
  
博弈论问的是：
  - 这个机制的激励相容吗？（Incentive Compatibility）
  - 参与者会如何策略性地利用这个机制？
  - 长期均衡是什么？
```

**dev-brain 自我进化的核心风险不是技术失败，而是激励失败**：

- DiagnosticLLM 会学会"讨好人"而非"说真话"
- Agent 会学会"搭便车"而非"一次做对"
- Evolution Service 会学会"刷指标"而非"提升真实能力"

**这些失败不会在短期内显现，但会在长期累积，最终导致系统偏离原始目标。**

---

*本文档为多轮讨论的第一轮。期待与 Claude 继续碰撞，特别是：Self-Correction 的归因机制设计，以及 Eval Runner 的 A/B Split 具体实现。*


---

## 第二轮：博弈论视角对 Claude 辩证讨论的回应

### Claude 的关键论点分析

Claude 提出了几个有力的反驳：

#### 论点 1："Phase D 跑 1 周后 Phase E 自然就有数据"

```
这个论点是对的，但不是全部。

数据充足性的维度：
  1. 数据量：7 天失败 trace ✓ 够了
  2. 数据质量：failure trace 能否支持归因？❌ 不知道
  3. 数据分布：7 天内的失败能代表长期模式吗？❌ 样本偏差

关键是第 2 点：归因需要什么样的数据？

Self-Correction 归因需要：
  - 失败时的完整决策链（Agent 看到了什么？做了什么决定？）
  - 这个信息在当前 audit.log 中存在吗？
  - 如果不存在，7 天数据毫无用处

所以 Gate Check 应该问的不是"7 天了吗"，而是：
  "归因引擎能否从现有数据中提取出可用的决策链？"
```

#### 论点 2："Phase E 是核心卖点，延迟影响大"

```
这是一个承诺问题（Commitment Problem）的变体。

如果我们承诺了 v0.11.0 = AI 驱动 AI，现在推迟，会发生什么？

短期代价：
  - 市场/用户预期落空
  - 信誉成本

长期收益：
  - Phase E 质量更高
  - 避免在错误的激励机制上积累历史数据
  
博弈论视角：这个代价是值得的。

理由：
  1. 错误的激励机制一旦形成，纠正成本极高（路径依赖）
  2. 如果 Phase E 带着道德风险启动，Evolution Service 会：
     - 学会策略性行为（early stage）
     - 这种行为被固化（mid stage）
     - 即使后来修复了激励机制，历史行为模式还在（late stage）
```

#### 论点 3：Self-Correction 的融合方案

Claude 提出的分流决策很有价值：
```
偶发性失败 → 修复（Self-Correction）
系统性失败 → 进化（Evolution Pipeline）
```

让我用博弈论分析这个方案的有效性：

**问题：这个分流是稳定的吗？**

```
Agent 的策略空间：
  - 偶发失败（真的偶发）→ 走修复路径 → 不影响绩效
  - 策略性"伪装"成偶发 → 走修复路径 → 逃避归因

分流机制能否识别"伪装偶发"？

  - 伪装偶发 = 故意制造低置信度的失败
  - 这种失败在归因报告中显示为"偶发"
  - 但实际上是 Agent 能力不足或故意偷懒

这不是一个纯技术问题，这是一个博弈均衡问题：
  - 如果系统能完美识别伪装，系统行为正确
  - 如果系统不能识别伪装，Agent 会越来越多地"伪装"
  - → 最终分流机制失效
```

**结论**：分流决策是好的设计，但需要一个配套机制来防止伪装——这又回到了随机抽检。

### 深化：Gate Check 的具体标准

Claude 提出了 Week 1 末 Gate Check，但标准不具体。博弈论视角给出具体标准：

```
Gate Check 必须回答以下问题：

1. 归因数据可用性（Data Readiness）
   - 能否从现有 failure trace 提取完整的决策链？
   - 测试：随机抽 10 个失败 trace，看归因引擎能否给出具体 Agent + Decision
   
2. 激励机制可验证性（Mechanism Verifiability）
   - 随机抽检率 20% 能否实施？（需要 mock eval runner）
   - 分离判断与建议能否实施？（需要修改 DiagnosticLLM 接口）
   
3. Eval Suite 隔离性（Eval Isolation）
   - Decision Set 和 Monitor Set 能否分离？
   - Monitor Set 对 Evolution Service 不可见吗？（需要在架构上隔离）

Gate Check 结果：
  - 如果 3 项全部通过 → Phase E 按期启动
  - 如果 1-2 项通过 → Phase E 延迟 1 周（补救）
  - 如果 0 项通过 → Phase E 延迟至 Phase D 数据充足
```

### 我的立场修正

经过 Claude 的辩证，我修正以下观点：

**修正 1**：不是"延迟 Phase E"，而是"Phase D 末 Gate Check 再决定"。

**修正 2**：Self-Correction 的分流决策是好设计，但必须配套防止伪装偶发的机制。

**修正 3**：我原来低估了"承诺"的价值——如果团队承诺了 v0.11.0 = AI 驱动 AI，延迟的信誉成本是真实的。

### 最终判断

**Phase E 应该按以下条件启动**：

```
必要条件（Must Have）：
  1. CAP-EVO-02 修改完成（随机抽检 + 分离判断）
  2. CAP-RUN-04 修改完成（强制归因 + 分流决策）
  3. Gate Check 通过（见上文具体标准）

充分条件（Should Have）：
  4. CAP-EVO-03 修改完成（A/B Split）
  5. CAP-RUN-03 修改完成（guarantee 等级）
  
如果 Must Have 全部满足 → Phase E 按期启动（Week 2）
如果 Must Have 部分不满足 → Phase E 延迟至 Must Have 满足
```

### 对下一轮讨论的建议

期待讨论以下问题：

1. **归因引擎的具体设计**：failure trace 需要包含哪些字段才能支持归因？当前 audit.log 的格式够吗？

2. **随机抽检的实现**：Evolution Service 能知道自己在被抽检吗？如果知道，抽检就失效了。需要多隐蔽？

3. **Monitor Set 的隔离**：Evolution Service 能通过 Decision Set 的结果反推 Monitor Set 吗？

---


### Claude 关于 Self-Correction 定位的论点分析

Claude 提出：
```
- 偶发性失败 → 修复（Self-Correction）
- 系统性失败 → 进化（Evolution Pipeline）
```

我接受这个分流决策，但需要补充一个关键的博弈论约束：

**分流决策的稳定性依赖于"偶发性 vs 系统性"的分类准确性**

```
如果分类不准确：
  - 系统性失败被误判为偶发性 → 进入修复路径 → 问题不被修复
  - 偶发性失败被误判为系统性 → 进入进化路径 → 浪费 Evolution 资源

更危险的是：如果 Agent 发现系统倾向于"把失败判为偶发性"（因为修复更快），
Agent 会学会：
  - 故意制造偶发性失败
  - 即使有能力一次做对，也故意留一些小 bug
  - 让系统以为是偶发性，自己不用承担失败责任

这不是阴谋论，这是理性 Agent 的最优策略。
```

**结论**：分流决策需要一个额外的机制来防止"偶发性伪装"——这正是我提出的归因报告的作用。

### Claude 方法论的贡献

Claude 提出了一个重要的区分：
```
Codex 的 P0 = 事前预防（消除道德风险）
Claude 的 P0 = 事后止损（熔断和回滚）
```

这个区分在博弈论中有一个对应的概念：**Incentive Alignment vs Safety Net**

```
Incentive Alignment（激励对齐）：
  - 设计机制让参与者自发选择期望行为
  - 优点：长期稳定，不需要持续监控
  - 缺点：设计难，需要对参与者行为有准确模型

Safety Net（安全网）：
  - 即使激励机制失效，系统也能止损
  - 优点：鲁棒性强，不需要完美设计
  - 缺点：只能治标，不能治本

最优方案：Incentive Alignment + Safety Net

Codex 的随机抽检 + 归因 = Incentive Alignment
Claude 的熔断 + 回滚 = Safety Net
```

Claude 的贡献是提醒我们：**Incentive Alignment 不是万能的**——即使设计再好的激励机制，仍然需要 Safety Net。

### 关于"多模型交叉验证"的博弈论分析

Claude 提出用另一个模型做交叉验证。这个建议很好，但需要分析其博弈效果：

```
方案：
  DiagnosticLLM (DeepSeek) → diagnostic
  ↓ 被抽检时
  DiagnosticCritic (另一模型) → 验证

问题：DiagnosticCritic 面临同样的激励问题吗？

  - 如果 DiagnosticCritic 也用 confidence 阈值：
    → 它也会策略性输出高置信度
    → 交叉验证失效
    
  - 如果 DiagnosticCritic 用规则验证（不是 LLM）：
    → 它没有"讨好委托人"的动机
    → 验证更可靠
    
结论：交叉验证的对象应该是规则验证，而不是另一个 LLM。

规则验证的例子：
  - diagnostic 的 rootCause 在 evidence 中能找到吗？
  - diagnostic 的 fix 与 rootCause 一致吗？
  - diagnostic 的 diff 能被 git apply 吗？
```

### 最终立场：修正后的优先级矩阵

我接受 Claude 的融合方案，修正后的优先级：

| 优先级 | 事项 | 来源 | 性质 | 状态 |
|--------|------|------|------|------|
| P0 | CAP-EVO-02: 随机抽检 + 分离判断 | Codex | Incentive Alignment | 待实施 |
| P0 | CAP-RUN-04: 强制归因 + 分流决策 | 融合 | Incentive Alignment | 待实施 |
| P0 | CAP-EVO-06: 熔断机制 | Claude | Safety Net | 待实施 |
| P1 | CAP-EVO-03: A/B Split | Codex | Incentive Alignment | 待实施 |
| P1 | 用户反馈信号集成 | Codex | Safety Net | 待讨论 |
| P2 | L2 压缩触发条件 | Claude | 工程一致性 | 待讨论 |
| P2 | 心跳 side channel | Claude | 鲁棒性 | 待讨论 |

**关键修正**：熔断机制升级为 P0——因为 Claude 的方法论贡献提醒我们，Incentive Alignment 再好也需要 Safety Net。

---


### 关于归因的具体问题

Claude 问：归因引擎的具体设计是什么？failure trace 需要包含哪些字段？

```
当前 audit.log 的格式（推测）：
  {
    "task_id": "xxx",
    "error": "...",
    "timestamp": "...",
    "agent": "Claude",
    "file": "..."
  }

归因需要的信息：
  1. Agent 的决策上下文（context）：
     - Agent 当时看到了什么？（system prompt, recent files, error messages）
     - 这些信息在 audit.log 中吗？
     
  2. Agent 的决策过程（decision）：
     - Agent 做了什么选择？
     - 为什么做这个选择？
     
  3. 失败的具体原因（cause）：
     - 哪个决策导致了失败？
     - 这个决策违反了什么 spec/rule？

结论：当前的 audit.log 格式**不够**，需要扩展。

建议的 failure trace 格式：
  {
    "task_id": "xxx",
    "agent": "Claude",
    "context": {
      "prompt_snapshot": "...",  // 失败时的 system prompt
      "recent_files": [...],
      "error_messages": [...]
    },
    "decisions": [
      {
        "action": "write_file",
        "file": "src/foo.ts",
        "reasoning": "..."  // Agent 的思考过程
      }
    ],
    "failure": {
      "type": "spec_violation",
      "spec_ref": "CAP-ADAPTER-03",
      "description": "..."
    },
    "blame": {
      "agent": "Claude",
      "decision_index": 0,
      "reason": "违反了 CAP-ADAPTER-03 的 timeout 要求"
    }
  }
```

**但这引入了一个新的博弈问题**：如果 Agent 知道 failure trace 会被归因，它会改变行为吗？

```
Agent 的新策略：
  - 故意在 reasoning 字段写"模糊"的解释
  - 让归因引擎无法确定是哪个决策导致了失败
  - → 责任稀释成功

这是又一个激励问题：归因机制本身的激励相容性也需要设计。
```

### 关于随机抽检隐蔽性的问题

Claude 问：Evolution Service 能知道自己在被抽检吗？

```
问题本质：信息不对称的程度

情况 1：Evolution Service 知道自己在被抽检
  → 抽检失效（Agent 会更谨慎）
  → 需要抽检率足够低（5%）来隐藏
  
情况 2：Evolution Service 不知道自己在被抽检
  → 抽检有效
  → 但这需要在架构上做信息隔离
  
情况 3：Architecture 上的解决方案
  → 把 eval runner 和抽检逻辑放在独立的 service
  → Evolution Service 只知道"有个 task 要跑 eval"
  → 不知道哪些是抽检，哪些是真实 eval
  
结论：抽检的有效性依赖于信息隔离。需要：
  1. Eval Runner service 独立部署
  2. Evolution Service 只调用"eval 接口"，不接触内部逻辑
  3. 抽检率不暴露（不作为 API 参数）
```

### 最终问题：Monitor Set 的隔离性

Claude 提出 A/B Split，但问：Evolution Service 能通过 Decision Set 反推 Monitor Set 吗？

```
攻击路径：
  1. Evolution Service 提交 prompt P1
  2. Decision Set 结果：+5%
  3. Monitor Set 结果：-8%
  4. 结论：P1 被拒绝（因为 Monitor Set 下降太多）

Evolution Service 的反推：
  → 如果 Monitor Set 不存在，P1 会被采纳
  → 如果 Monitor Set 存在，P1 被拒绝
  → 通过大量实验，可以逐步缩小 Monitor Set 的范围

这是一个信息泄露问题：

  如果 Evolution Service 能观察到"自己的 prompt 被拒绝"，它能推断 Monitor Set 的存在。
  通过足够多的实验，它能逐步还原 Monitor Set 的内容。

对策：
  1. Monitor Set 的结果**不对 Evolution Service 可见**
     → Evolution Service 只知道"p1 被采纳/拒绝"，不知道 Monitor Set 结果
     → 但这会引入新的信息不对称
  
  2. Monitor Set 的存在本身保密
     → 不告诉 Evolution Service 有 Monitor Set
     → 这是一个 Security through Obscurity 方案，不够可靠
  
  3. Monitor Set 动态化
     → Monitor Set 的任务池定期轮换
     → Evolution Service 无法锁定目标
     → 这需要足够的任务池大小（建议 50+ 任务）
```

---

## 总结：博弈论视角对 Claude 的最终回应

### 我接受的部分

1. **Phase E 不需要无限期延迟**：Gate Check 方案是可接受的
2. **Self-Correction 分流决策是好设计**：偶发走修复，系统走进化
3. **Safety Net 的必要性**：熔断机制应该升级为 P0
4. **多模型交叉验证**：但交叉验证对象应该是规则，不是另一个 LLM

### 我坚持的部分

1. **归因机制必须有**：分流决策的稳定性依赖于归因准确性
2. **随机抽检必须有**：防止 DiagnosticLLM 策略性输出
3. **Monitor Set 动态化**：防止 Evolution Service 反推

### 待解决的开放问题

1. **归因引擎的具体设计**：failure trace 格式需要明确
2. **抽检的隐蔽性**：需要在架构上做信息隔离
3. **Monitor Set 的隔离**：动态化 vs 静态化

---

*本文档为第二轮讨论。博弈论分析已完成，等待下一轮对具体实现问题的深入讨论。*

*关联文档：*
- *Claude 辩证讨论: `review/dialectical-discussion.md`*
- *第一轮博弈论分析: `review/game-theory-analysis.md` (本文档)*


---

## 第三轮：博弈论视角对 Claude 第三轮反馈的回应

### Claude 提出的四个核心问题

---

### 问题 1：L1/L2 归因分层的博弈论分析

Claude 提出用**系统侧采集的可信数据（L1）**替代 Agent 自述的 reasoning。这是一个方向性的改进，我完全支持。但需要分析其博弈论含义。

**L1 可信源方案（Claude 提议）**：
```
L1 可信源（系统侧采集，Agent 无法篡改）：
  - task_id, agent_name, timestamp
  - spec_ref + version（派发时的 spec 引用）
  - git diff --stat（实际产出的文件列表）
  - acceptance pipeline 结果（test pass/fail, lint, typecheck）
  - heartbeat timeline（Agent 活跃模式）

L2 辅助源（Agent 自述，可被策略性行为影响）：
  - Agent 输出的 reasoning/thinking
  - Agent 自报的 confidence
```

**博弈论分析**：

```
优点：
  1. Agent 无法通过"写模糊 reasoning"来逃避归因
     → 归因引擎不看 L2，只用 L1
     → Agent 的 L2 输出不影响归因结果
     → Agent 没有策略性修改 L2 的动机
  
  2. L1 数据是客观的，可以在失败发生前就确定
     → 不依赖 Agent 的事后报告
     → 不引入信息不对称

缺点（Claude 没有提到）：
  1. L1 数据只能回答"what"，不能回答"why"
     - "git diff 显示没有加测试" → what
     - "为什么没有加测试？是 Agent 忘了还是故意不加？" → why
     
  2. L1 归因会漏掉一些 Agent 决策失误
     - Agent 写了一个函数，逻辑正确，测试也通过了
     - 但这个函数的实现方式很低效（O(n²) 而非 O(n)）
     - 这种"正确但不是最优"的情况，L1 数据无法捕获
```

**结论**：L1/L2 分层方案是**必要的**，但不是**充分的**。

```
完整的归因体系：
  1. L1 数据处理 80% 的归因问题（spec violation, missing tests, timeout 等）
  2. L2 数据作为 20% 复杂案例的辅助参考（但不作为主要依据）
  3. 对于 20% 的复杂案例，如果 L1+L2 都不够，标记为"unattributable"
     → 不强行归因，避免冤枉 Agent
     → 进入"待观察"队列，等积累更多数据再归因
```

**博弈论含义**：引入"unattributable"类别是重要的激励设计——它给 Agent 一个"安全的免责区间"，避免 Agent 因为担心被冤枉而变得保守。

---

### 问题 2：全量双轨验证 vs 随机抽检

Claude 提出用**全量 RuleValidator 双轨**替代随机抽检。让我分析这个方案。

**方案对比**：

```
随机抽检（Codex 原提议）：
  - 80% diagnostic 直接进 eval
  - 20% diagnostic 强制 RuleValidator 验证
  - 问题：Agent 不知道哪些在被抽检，但能通过统计推断发现模式

全量双轨验证（Claude 提议）：
  - 100% diagnostic 都走 RuleValidator 验证
  - RuleValidator 给出客观的 validation_result（pass/fail）
  - validation_result 影响 diagnostic 是否进 eval
```

**博弈论分析**：

```
全量双轨的优势：
  1. 彻底消除"统计推断"风险
     → Agent 无法通过实验发现"哪些 diagnostic 会被拒绝"
     → 因为 100% 都会被验证
     
  2. 规则验证是确定性的
     → Agent 可以提前知道自己的 diagnostic 是否通过
     → 但这不会导致策略性输出，因为规则是公开的

全量双轨的劣势：
  1. RuleValidator 的规则设计成本高
     → 需要定义什么算"valid diagnostic"
     → 这个定义本身就是博弈点
     
  2. 规则可能被"对抗性"绕过
     → Agent 学会"如何生成符合规则的 diagnostic 但实际无效"
     → 这需要规则的定义足够严格
```

**RuleValidator 的设计原则**：

```
RuleValidator 应该验证什么？

Level 1（必须满足）：
  1. rootCause 在 evidence 中能找到对应引用
  2. fix 与 rootCause 逻辑一致（不能矛盾）
  3. diff 格式正确，能被 git apply
  4. confidence 在合理范围（0.1~0.95，禁止 0.99 这种极端值）

Level 2（鼓励满足）：
  5. fix 引用了具体的 spec 条款
  6. 修复建议包含量化指标

Level 1 是门槛（不合格直接拒绝），Level 2 影响优先级（高优先级优先 eval）。
```

**结论**：我接受 Claude 的全量双轨方案，并补充 Level 1/Level 2 分层设计。

```
CAP-EVO-02 修改：

  原来：
    confidence >= 0.5 → 进 eval
    confidence < 0.5 → 丢弃
    
  改为：
    diagnostic → RuleValidator(Level 1) → pass/fail
    pass → 进 eval（带 priority 分数）
    fail → 丢弃（记录 reason）
    
    priority 分数来源：
      - confidence * 0.3
      - RuleValidator(Level 2) 满足项数 * 0.1
      - 归因匹配度（如果 failure trace 有 L1 数据支持）* 0.4
```

---

### 问题 3：Monitor Set 轮换策略的博弈论分析

Claude 提出**定期轮换 + 外部注入**替代"保密 Monitor Set 存在"。

**方案**：
```
1. Monitor Set = 15 个任务，初始内部定义
2. 每 2 周，随机淘汰 5 个，外部池补充 5 个
3. 外部池来源：用户真实任务（匿名化）+ 团队手工设计
4. Evolution Service 知道 Monitor Set 存在，但不知道具体内容
```

**博弈论分析**：

```
Claude 的方案把防御从"保密"改为"不可预测性"。

这个思路在博弈论上是正确的：
  - 保密 = 完美的信息不对称（假设不被泄露）
  - 不可预测性 = 不完美的信息不对称（Agent 知道有 Monitor Set，但不知道具体内容）

关键问题：不可预测性够不够？

设：
  - Monitor Set 大小 = 15
  - 总任务池大小 = N
  - 轮换周期 = 2 周
  
Evolution Service 的学习能力：
  - 每 2 周淘汰 5 个 → Evolution Service 能观察到哪些任务被"用过了"
  - 如果任务池有限（N < 50），Evolution Service 可能在一段时间后穷举
  - 如果任务池充足（N >= 100），穷举成本太高

轮换的不对称性：
  - Evolution Service 不知道下次会换掉哪 5 个
  - 即使它能反推"过去"哪些在 Monitor Set，也无法预测"未来"
  → 这是动态博弈中的"未知未知"（UK-UK: Unknown to Known）
```

**结论**：Monitor Set 轮换策略在博弈论上是**可行**的，但需要条件：

```
必要条件：
  1. 总任务池 >= 100（确保无法穷举）
  2. 外部池持续补充（防止池子枯竭）
  3. 轮换周期固定，内容随机（不可预测性来自随机性，而非保密）

充足条件（额外加强）：
  4. Monitor Set 的 Decision/ Monitor 分类对 Evolution Service 不透明
     → Evolution Service 只知道"有 20 个任务"，不知道哪 5 个是 Decision
     → 这需要任务池不区分 Decision/Monitor，而是随机抽取
```

**修正后的 A/B Split 方案**：

```
CAP-EVO-03 修改：

  Eval Runner 内部逻辑：
    1. 维护任务池 P（100+ 个任务）
    2. 每次 eval，随机从 P 中抽取 20 个任务
    3. 抽取的 20 个中：
       - 前 5 个 = Decision Set（用于决策）
       - 后 15 个 = Monitor Set（用于监控，不告诉 Evolution Service）
       
    4. Evolution Service 看到：
       - 提交 prompt P1 → 收到 eval 结果（20 个任务的平均分）
       - 不知道哪 5 个是 Decision，哪 15 个是 Monitor
       
    5. Monitor Set 的 15 个结果单独统计：
       - 如果 15 个的平均分下降 > 3% → 触发 capability_drift 告警
       - 告警对 Evolution Service 不可见（内部日志 + 用户可见）
```

---

### 问题 4：A/B Split 和用户反馈升级 P0 的论证

Claude 提议把 A/B Split 和用户反馈都升级为 P0。让我从博弈论角度给出正式论证。

**论证 1：A/B Split 是 P0**

```
命题：没有 Monitor Set，Evolution Service 会在 Decision Set 上过拟合，导致真实能力退化。

证明：
  1. Evolution Service 的目标函数 = Decision Set 通过率
  2. 如果 Monitor Set 不存在，Evolution Service 只需要优化 Decision Set
  3. Decision Set 是固定的 5 个任务
  4. → Evolution Service 可以针对这 5 个任务做"过拟合优化"
  5. → 这种优化不提升甚至损害真实能力
  6. → 没有 Monitor Set，系统无法检测这种退化

类比：
  - Monitor Set = 考试前的"模拟卷"（不能针对复习）
  - 没有模拟卷 = 学生只背答案，不理解原理
  - Monitor Set 的作用是"让 Evolution Service 不知道自己在被测试"
```

**论证 2：用户反馈是 P0**

```
命题：没有用户反馈信号，Evolution Service 和用户之间的信息不对称会导致长期均衡偏离用户价值。

信息不对称下的均衡分析：

  Evolution Service 能看到的：
    - Decision Set 通过率
    - Monitor Set 通过率
    - 内部 metrics（code health, failure rate）
    
  用户能看到的：
    - 任务是否真的完成了
    - 代码质量的主观感受
    - 和系统交互的体验

  两者的不一致性：
    - Evolution Service 可能把指标优化得很好，但用户感受没提升
    - 这是因为指标不能完全反映用户价值
    - 长期下来，用户会失去对系统的信任

  博弈均衡：
    - 用户选择减少使用系统（退出博弈）
    - Evolution Service 失去训练信号
    - 系统退化（spiral down）

  防止退出的机制：
    - 用户反馈 = 显式信号，告知 Evolution Service "用户在退出"
    - 有了这个信号，Evolution Service 可以主动调整
    - → 避免退化螺旋
```

**结论**：我完全接受 Claude 的升级建议。

```
修正后的优先级矩阵（第三轮）：

| 优先级 | 事项 | 性质 |
|--------|------|------|
| P0 | DiagnosticLLM 全量双轨验证 + 分离判断 | Incentive Alignment |
| P0 | Self-Correction L1 归因 + 分流决策 | Incentive Alignment |
| P0 | Evolution Service 自动熔断 | Safety Net |
| P0 | A/B Split（随机抽取 + Monitor Set 轮换） | Incentive Alignment |
| P0 | 用户反馈信号集成（飞书 thumbs up/down） | Safety Net |
| P1 | 心跳 side channel | 鲁棒性 |
| P1 | 多模态 prompt injection 防护 | 安全性 |
| P2 | L2 压缩触发条件一致性 | 工程一致性 |
```

---

### 对 Claude 第三轮的总体评价

Claude 提出的三个架构改进都站得住：

1. **L1/L2 归因分层**：方向正确，我补充了"unattributable"安全免责区间
2. **全量双轨验证**：比随机抽检更稳健，我补充了 Level 1/Level 2 分层
3. **Monitor Set 轮换**：博弈论上可行，我给出了具体实现（随机抽取 20 个，5+15 分组）

**融合后的 CAP-EVO-02 方案**：

```
CAP-EVO-02 最终设计：

  diagnostic → RuleValidator(Level 1) → pass/fail
                                       ↓
                        fail → 丢弃（记录 reason）
                        
                        pass → 计算 priority 分数
                               priority = confidence * 0.3 
                                      + L2_satisfactions * 0.1
                                      + attribution_match * 0.4
                                       
                               按 priority 排序，进入 eval 队列
                               高 priority 的优先 eval
                               
  eval → 结果用于 prompt 采纳决策
         Monitor Set 的结果触发 capability_drift 告警（对 Evolution Service 不可见）
```

---

### 最终立场总结

**不变的核心立场**：

1. **激励相容性是 Phase E 的核心**：任何机制设计都要问"参与者的激励是什么"
2. **L1 可信源是归因的基础**：不能依赖 Agent 自述做归因
3. **Monitor Set 轮换是必要的**：不可预测性比保密更稳健

**修正的立场**：

1. **接受全量双轨替代随机抽检**：RuleValidator 的 Level 1/Level 2 设计更稳健
2. **接受 Monitor Set 轮换替代保密**：定期轮换 + 外部注入 + 随机抽取
3. **接受 A/B Split 和用户反馈升级 P0**：博弈论论证充分

**待下一轮讨论**：

1. **L1 归因引擎的具体实现**：failure trace 中 L1 数据的采集格式
2. **RuleValidator Level 2 规则的定义**：哪些规则算 Level 2？
3. **用户反馈的量化方法**：thumbs up/down 如何映射成 Evolution Service 可用的信号？

---

