# AI Native OS — OpenSpec 可落地性 Review

**Review 日期**: 2026-06-06
**Reviewer**: OpenSpec 可落地性视角
**项目**: dev-brain
**变更**: openspec/changes/ai-native-os (target v0.11.0)

---

## 摘要

本文从 OpenSpec 规范可落地视角对 ai-native-os 需求进行全面 review，识别出 **5 个 P0 落地风险**、**8 个 P1 问题**、**6 个 P2 建议**。

**核心结论**：spec 整体质量高，CAP 结构清晰，但存在 **3 类致命问题**需要立即解决：
1. Phase 之间的数据依赖缺口（Phase D 无法在 Week 1 末产出 Phase E 需要的 7 天数据）
2. 验收标准中含 2 项**主观判定**（无法自动化验证）
3. 关键集成接口缺失（FeedbackCollector → 飞书卡片、RuleValidator Level 2 规则定义）

---

## 一、格式规范符合度检查

### 1.1 符合项 ✓

| 检查项 | 状态 | 说明 |
|--------|------|------|
| Frontmatter | ✓ | 所有 spec 都有 demand-id, change, status |
| CAP 结构 | ✓ | Given/When/Then 格式统一 |
| Scenario 场景 | ✓ | 关键路径有 Scenario 覆盖 |
| Metric 定义 | ✓ | 每个 CAP 都有对应的 counter/gauge 定义 |
| 实现要点 | ✓ | 关键实现细节在实现要点段说明 |
| Non-Goals | ✓ | proposal.md 有明确的 Non-Goals |

### 1.2 不符合项 ✗

| 检查项 | 问题 | 建议 |
|--------|------|------|
| 版本历史 | REVISED CAP 没有版本变更记录 | 每次修订增加 v0.11.0 修订 N 注释 |
| Files Modified | tasks.md 和 proposal.md 都没有 files modified 字段 | 归档时需要补全 |
| 依赖声明 | CAP 之间有隐式依赖但未显式声明 | 在 CAP 头部加 **依赖**: CAP-XXX-YY |
| Task ID | tasks.md 中任务没有唯一 ID | 按归档版格式补全 T-D01、T-E01 格式 |

---

## 二、验收标准可测试性分析

### 2.1 可自动化验证的标准 ✓（16/18）

| 指标 | 目标 | 验证方式 |
|------|------|---------|
| 代码态观测 4 项全量覆盖 | 100% | 目录存在 + cron 日志 |
| ts-morph 单文件解析 P95 | < 500ms | 性能测试 |
| jscpd 扫描 src/ | < 30s | 性能测试 |
| Evolution cycle 完成时间 | < 15min | 计时断言 |
| RuleValidator L1 拦截率 | > 0%, < 50% | 10 次 diagnostic 统计 |
| A/B Split Decision Set 通过率提升 | +5% | eval-runner 断言 |
| Monitor Set 能力退化检测 | > 3% 触发 alert | mock eval 测试 |
| 沙箱回滚成功率 | 100% | 10 次故意失败测试 |
| 心跳误杀率 | < 1% | 1000 次 mock 统计 |
| Self-Correction 一次成功率 | ≥ 40% | eval suite 测试 |
| 熔断器误触发率 | < 5% | 100 次正常周期统计 |
| 用户满意度 | ≥ -0.1 | mock feedback 测试 |
| 流式推送延迟 | < 200ms | 端到端计时 |
| 多模态 OCR 准确率 | ≥ 85% | 20 张测试图基准 |
| 签名鉴权伪造请求拒收率 | 100% | 5 次伪造测试 |
| 覆盖率 | 85%/74% | pnpm test:coverage |

### 2.2 需人工判定的标准 ✗（2/18）— P0 修复

| 指标 | 问题 | 建议 |
|------|------|------|
| **死代码检测准确率** | "人工 spot-check 20 样本"不可重复验证 | 改为 fixture 验证：10 个确定 dead + 10 个确定 alive，自动验证 recall/precision |
| **prompt 采纳率** | "太低/太高"是定性描述，无法自动化 | 定义阈值：< 20% 告警 insight 不足，> 80% 告警风险过高 |

---

## 三、数据依赖缺口 — P0 致命

### 问题建模

Phase E 的 InsightEngine 需要"最近 7 天数据"，但 Phase D 的 Snapshot 是每日 1 次 cron：

```
Week 1 第 1 天: snapshot 跑 → 1 天数据
Week 1 第 5 天: snapshot 跑 5 次 → 5 天数据（工作日）
Week 2 第 1 天: Phase E 启动 → 需要 7 天数据
                                  ↑ 缺口！
```

### 影响

- Phase E 启动后前几个周期频繁触发 insufficient_data
- 实质上 Phase E 要到 Week 2 末才能正常工作
- 与其这样，不如 Week 3 启动 Phase E

### 修复建议

```
方案 1: Phase D 从 Week 0 开始
  - 立即在 master 上启用 Snapshot cron
  - Week 1 末已有 7 天数据
  - Week 2 Phase E 可正常启动

方案 2: Phase E 延迟到 Week 3 启动（推荐）
  - Week 1-2 跑 Phase D + Phase F
  - Week 3 启动 Phase E，数据充足

方案 3: 放宽数据要求
  - 将 7 天改为"连续 5 个 snapshot"
  - 早期 insight 做降权处理
```

---

## 四、关键集成接口缺失 — P0 致命

### 缺失 1: FeedbackCollector → 飞书卡片集成

**问题**: CAP-EVO-06 定义了 FeedbackCollector，但飞书卡片的按钮如何触发 FeedbackCollector 未定义。

**需要补充的 spec**:

```
## CAP-COM-04-EXT: 任务完成卡 + 用户反馈

When 任务完成 → TaskDoneCard 发送:
  - 按钮: "👍 满意" (callback_id="feedback_thumbs_up")
  - 按钮: "👎 不满意" (callback_id="feedback_thumbs_down")

用户点击按钮 → FeishuGateway:
  - feedback_thumbs_up → FeedbackCollector.record(taskId, "thumbs_up")
  - feedback_thumbs_down → FeedbackCollector.record(taskId, "thumbs_down")

回调处理后，更新原卡片：按钮变灰 + "已收到反馈"
```

### 缺失 2: RuleValidator Level 2 规则定义

**问题**: CAP-EVO-02 说"Level 2 规则走 YAML 配置"，但 config/rule-validator.yaml 的内容未定义。

**需要补充**:

```yaml
# config/rule-validator.yaml
level2_rules:
  - id: R2-1
    name: "spec_reference"
    pattern: "CAP-[A-Z]+-\\d+"
    
  - id: R2-2
    name: "quantitative_metric"
    pattern: "(≥|>|>=|<=|<)\\s*\\d+\\s*(个|次|行|%|ms|s|min)"
    
  - id: R2-3
    name: "historical_consistency"
    # 运行时：与最近 30 天分类统计比对
    
  - id: R2-4
    name: "safe_diff_scope"
    allowed_paths:
      - "src/prompts/**"
      - "src/templates/**"
      - "openspec/**/spec.md"
```

---

## 五、矛盾和歧义 — P1

| 矛盾项 | 问题 | 建议 |
|--------|------|------|
| L2 压缩触发条件 | "每 5 个 round" 和 "50K/80K token" 是 AND 还是 OR？ | 统一为：token 超为主，round 为辅 |
| 沙箱粒度 | 说"per-subtask 独立 worktree"，但实现用 git stash | 明确 v0.11.0 用 git stash |
| Agent Reasoning Trace | 新增 thinking 标签，但格式未定义 | 补充：thinking 标签独占一行 |

---

## 六、关键功能缺失 — P1

| 缺失项 | 影响 | 建议 |
|--------|------|------|
| TaskPool 外部注入机制 | 100+ 任务池需要持续补充 | 定义 config/eval-task-pool.yaml + 注入 API |
| Knip 可选依赖处理 | KnipAdapter 是主路径，但 knip 是可选 | spec 明确：未安装 → 降级 DeadcodeFinder |
| CardKit v2.0 API 可用性 | streaming_mode 上限 10 次/秒 | 需确认飞书生产环境支持 |

---

## 七、修复建议优先级

### P0 — 必须修复

1. **死代码准确率验证**: 改为 fixture 自动化测试
2. **prompt 采纳率验证**: 定义 < 20% / > 80% 告警阈值
3. **Phase E 数据依赖**: 延迟到 Week 3，或立即启用 Phase D cron
4. **FeedbackCollector 集成**: 补充 CAP-COM-04-EXT
5. **RuleValidator Level 2 配置**: 补充 rule-validator.yaml schema

### P1 — 建议修复

6. **L2 压缩触发条件**: 统一为 token-based
7. **沙箱方案明确**: 明确用 git stash
8. **thinking 标签格式**: 补充格式定义
9. **TaskPool 外部注入**: 定义 YAML 格式和 API
10. **Knip 降级处理**: 补充 spec

### P2 — 可延后

11. 边界条件：initial snapshot、空池处理
12. 版本历史：REVISED 注释规范
13. Task ID：T-D01 格式

---

*Review 完成。建议优先处理 P0 问题后再进入 Phase D 实施。*

