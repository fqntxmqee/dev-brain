# AI Native OS 需求评审记录

**评审日期**: 2026-06-06
**评审人**: Claude
**项目**: dev-brain
**变更**: openspec/changes/ai-native-os (target v0.11.0)

## 总体评分: 8/10

一份质量很高的需求文档，12 个缺口诊断精准，三层-phase 分拆依赖清晰，可直接进入实施。

---

## 一、完整性（Completeness）— 7.5/10

### 做得好的

- 4 个组件共 ~21 个文件，每个文件职责单一
- 验收标准 12 项全部量化（如 Self-Correction 一次成功率 ≥ 40%，死代码准确率 ≥ 90%）
- Non-goals 明确排除了范围外内容，防止范围蔓延
- 修改影响范围清晰（proposal.md 列出了所有修改的文件）

### 缺失和薄弱点

1. **缺少全局故障恢复策略。** 各组件独立处理错误，但没有回答"evolution service 把 prompt 系统搞崩了怎么办"。虽有 `./cli prompt revert <id>`，但缺少自动熔断机制：当 `evolution.prompts_rejected_total` 短时间内飙升时应自动暂停进化周期。

2. **安全审核不够深入：**
   - L3 长期记忆存储没有访问控制——存在偏好注入风险
   - 多模态 OCR 文本直接注入 system prompt，攻击者可发送含 prompt injection 的截图
   - 沙箱只做 git stash/pop，未讨论子进程权限隔离（文件系统范围、网络访问等）

3. **缺少告警规则定义。** 新增 8+ metric 和 Grafana panel，但无对应 Prometheus 告警规则。

4. **测试策略存在缺口：**
   - 缺少混沌工程测试（心跳丢失 + 沙箱回滚 + 流式推送同时故障的复合场景）
   - 缺少 evolution service 长时间运行（7 天观察期）的浸泡测试
   - 没有对自我进化系统的对抗性测试

5. **迁移风险未充分评估。** StateMachine 替换 orchestrator.ts 中 ad-hoc 状态管理，没有迁移策略和回滚兼容性分析。

---

## 二、合理性（Rationality）— 8/10

### 做得好的

- Phase D → E → F 的依赖关系合理：代码可观测为进化提供数据基础
- 进化流水线的多层安全阀（confidence < 0.5 丢弃 → +5% 阈值 → 7 天观察期 → 一键回滚）
- 沙箱使用 git 原语实现，简单可靠
- 每个故障模式都有降级策略

### 值得商榷的设计选择

1. **DeepSeek 作为唯一诊断 LLM 有系统性风险。** 所有 diagnostic 经过同一模型，系统偏差会自我强化。建议多模型交叉验证或周期轮换模型。

2. **InsightEngine 只用关键词启发式分类脆弱。** 不同 Agent 表达相同概念方式不同，未来模型变化后关键词会失效。应标注演进路径到 LLM-based 分类。

3. **心跳通过 stdout 解析 `__dev_brain_heartbeat__` 令牌不够稳健。** Agent 可能在代码生成或工具输出中恰好输出这个字符串。更稳健的做法是使用单独 side channel（Unix socket 或 fd 3）。

4. **L2 压缩触发条件不一致。** Spec 说"每 5 个 round 触发一次 LLM 摘要"，但也提到 50K/80K token 阈值。两者需要统一为以实际 token 数为主。

5. **僵尸代码检测 4 条件 AND 逻辑可能太宽松。** 最近被格式化工具改过的实质性僵尸代码不会被检测到。建议增加"最近改动是否为实质性改动"的判断。

6. **Sandbox 开销未被讨论。** 每个 subtask 独立 worktree，10 个子任务 = 10 次 `git worktree add` + 10 次 `git stash`，在大型仓库上开销不可忽略。

---

## 三、先进性（Advancement）— 7.5/10

### 亮点
- 自我进化闭环真正践行"AI 驱动 AI"
- 三层记忆模型对标认知科学，有理论深度
- 代码态 + 运行时双维度可观测性构建完整反馈循环
- 7 天观察期 + quarantine 是负责任的 AI safety 实践

### 可以更先进的地方

1. **评测数据污染问题未提及。** 固化在 YAML 中的 5 个标准任务可能被 Agent 训练数据"记住"，导致评测分数膨胀。应设计盲测集（held-out eval set）。

2. **缺少因果分析能力。** 当前 diagnostic 做相关性分析而非因果推断。真正"AI 驱动 AI"需要反事实推理：如果 prompt 中加了 X，失败率会降低多少？

3. **Recall 策略从关键词到 embedding 的迁移被低估。** 这不是简单替换，需要 embedding 模型选型、向量数据库、冷启动策略等。应标为独立 change（v0.12.0）。

4. **缺少 A/B 灰度发布机制。** EvalRunner 做离线对比，无在线灰度框架。更先进的方案：新 prompt 先 10% 流量，对比生产指标后逐步扩大。

5. **StateMachine 过于简单。** 6 状态 + 线性迁移对当前够用，但未来并行子任务、条件分支、人工审批节点需要层次化状态机或行为树。

6. **跨项目学习缺失。** L3 是 per-project 的，无法从多项目经验中提取跨项目模式。架构上应预留扩展点。

7. **代码态观测限制在 TypeScript。** `ts-morph` 只能解析 TS，多语言项目不可见。建议 `CodeHealthSnapshot` 预留 `language` 字段。

---

## 总结建议优先级

| 优先级 | 建议 | 类别 |
|--------|------|------|
| P0 | 增加 evolution service 自动熔断机制（连续 N 次 reject 自动暂停） | 完整性 |
| P0 | 统一 L2 压缩触发条件（token-based 而非 round-based） | 合理性 |
| P1 | 多模态输入增加 prompt injection 防护（OCR 文本入 prompt 前做清洗） | 完整性 |
| P1 | 心跳通道从 stdout 解析改为独立 side channel | 合理性 |
| P1 | 为代码态观测预留多语言扩展点 | 先进性 |
| P2 | 设计盲测集（held-out eval）防止评测数据污染 | 先进性 |
| P2 | 诊断 LLM 引入多模型交叉验证 | 合理性 |
| P2 | 补充复合故障场景测试（混沌工程） | 完整性 |
| P3 | L3 记忆架构预留跨项目学习扩展点 | 先进性 |
| P3 | InsightEngine 关键词分类增加 LLM-based 演进路径标注 | 合理性 |

---

## 博弈论视角的潜在讨论方向

以下问题特别适合从博弈论视角切入：

1. **Evolution Service vs 用户的多阶段博弈**：系统自动修改 prompt，用户可能手动回滚。双方信息不对称（系统看到指标，用户看到实际效果），存在纳什均衡吗？
2. **多 Agent（Claude/Codex/Cursor）协作中的囚徒困境**：每个 Agent 有各自的目标函数，Self-Correction 机制下是否存在"搭便车"（一个 Agent 故意偷懒，指望 Self-Correction 补救）？
3. **置信度阈值（confidence < 0.5 丢弃）的信号博弈**：DiagnosticLLM 是否会策略性地输出刚好 > 0.5 的置信度来让 diff 进入 eval 阶段？
4. **EvalRunner 的 Goodhart 定律**：当指标（pass_rate）成为目标后，它就不再是好指标。Evolution 是否会演化出针对 eval suite 过拟合的 prompt？
5. **沙箱机制的承诺问题（Commitment Problem）**：系统承诺"失败一定回滚"，但 git stash pop 可能冲突。这个承诺是否可信？不可信会影响 Agent 的行为策略吗？
