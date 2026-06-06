---
demand-id: DM-20260606-003
change: ai-native-os
module: multi-agent-runtime
status: developing
---

# Multi-Agent Runtime 深度设计：Grill with Docs 3 轮

**日期**: 2026-06-06
**关联**: `docs/philosophy.md`

---

## 目标锚定

### L1 — 用户说想要什么？

> "显式状态机 + 沙箱 + 心跳 + Self-Correction + 验收流水线"

原始 spec (CAP-MAR-01..05) 的描述:
- CAP-MAR-01: 6 状态 FSM (PENDING/RUNNING/RETRYING/SUCCESS/FAILED/CANCELLED)
- CAP-MAR-02: git stash 沙箱, 失败回滚
- CAP-MAR-03: 30s 心跳, 连续 2 次丢失触发 cancel
- CAP-MAR-04: L1 归因 + 分流决策 (修复/进化/升级)
- CAP-MAR-05: 4 阶段验收 (test/lint/typecheck/reviewer)

### L2 — 本质上用户想达成什么？

**用户不是在要"5 个运行时功能"，用户在要一个可靠性保证:**

> 把 Agent 派发出去执行任务时，系统能保证: (1) 状态不会乱，(2) 写坏的代码能恢复，(3) 卡死能被发现，(4) 失败了知道为什么并尝试修复，(5) 产出是经过验证的——而不只是"把 Agent spawn 出去然后祈祷"。

翻译成系统目标:
1. **执行确定性**: 每次状态迁移是合法且可追溯的，不存在"卡在中间态"的幽灵任务
2. **故障隔离**: Agent 的错误不能污染工作区，回滚是可靠的
3. **活性监控**: 不是"等超时"，而是主动感知 Agent 是否还活着
4. **智能恢复**: 不是"同 prompt 再试一次"，而是分析失败原因后精准修复
5. **质量闸门**: Agent 产出自动过验收，不合格的不算完成

### L3 — 约束条件是什么？

| 约束 | 来源 | 严苛度 |
|------|------|--------|
| 沙箱回滚必须 100% 可靠 | 架构共识 | 硬约束 |
| 心跳不能依赖 Agent 配合 (Agent 可能不输出 token) | 博弈论审查共识 | 硬约束 |
| 归因不能依赖 Agent 自述 reasoning | 博弈论审查共识 | 硬约束 |
| Self-Correction 不能创造搭便车激励 | 博弈论审查共识 | 硬约束 |
| 验收流水线不能阻塞主流程过长 (> 5min) | 用户体验 | 软约束 |
| 状态机迁移必须持久化 (crash 后可恢复) | 可靠性 | 硬约束 |
| git stash 操作在多 Agent 并行时不能冲突 | 工程约束 | 硬约束 |

### 核心矛盾

```
Agent 需要自主性来完成复杂任务
    ↕
自主性越高，出错的影响面越大
    ↕
隔离越严格，Agent 能力越受限
    ↕
关键问题: 在不限制 Agent 能力的前提下，如何保证故障安全？
```

**这就是 multi-agent-runtime 要解决的本质问题。**

---

## 第 1 轮: 问题空间探索 — "业界怎么解决 Agent 运行时可靠性问题的？"

### 信息来源

| 来源 | 类型 | 关键内容 |
|------|------|---------|
| [LangGraph 1.0 Checkpointing](https://sparkco.ai/blog/mastering-langgraph-state-management-in-2025) (2025) | 框架文档 | 状态快照 + PostgreSQL/Redis 持久化 + pause/resume/replay |
| [Fault-Tolerant Sandboxing](https://browse-export.arxiv.org/abs/2512.12806) (Dec 2025) | 论文 | 事务性文件系统快照, 100% 回滚成功率, ~14.5% 开销 |
| [Google Agent Sandbox on K8s](https://cloud.google.com/blog/products/containers-kubernetes/agentic-ai-on-kubernetes-and-gke) (Nov 2025) | 产品发布 | gVisor 隔离 + 预热沙箱池 + GKE Pod Snapshots |
| [Wink: Recovery from Agent Misbehaviors](https://browse-export.arxiv.org/abs/2602.17037) (Feb 2026) | 论文 | 异步自干预, 3 类 misbehavior 分类 (Specification Drift/Reasoning Problems/Tool Call Failures), 90% 单次干预解决率 |
| [CodeCoR: Multi-Agent Code Generation](https://catalog.lib.msu.edu/EdsRecord/edsarx,edsarx.2501.07811) (Jan 2025) | 论文 | 4 Agent 协作 (生成/测试/修复/建议), 77.8% Pass@1 |
| [Agentic Code Review at Scale](https://www.zenml.io/llmops-database/deploying-agentic-code-review-at-scale-with-gpt-5-codex) (Oct 2025) | 工程实践 | OpenAI 生产级 Codex reviewer, 100K+ PRs/天, 52.7% 评论带来代码变更 |
| [UK AISI Inspect Sandboxing](https://www.aisi.gov.uk/blog/the-inspect-sandboxing-toolkit-scalable-and-secure-ai-agent-evaluations) (2025) | 安全标准 | 三层隔离 (Docker/K8s/VM), 推理与执行分离 |

### 关键发现

#### 发现 1: 状态机需要"持久化执行"而非"内存状态"

原始 spec 的 StateMachine 是内存中的 FSM 校验器。LangGraph 1.0 证明了**状态机 + checkpoint 持久化**才是生产级方案:
- 每个 super-step 后自动存快照
- crash 后从最后一个 checkpoint 恢复, 不丢上下文
- "时间旅行"调试: 可从任意 checkpoint 回放

**对 dev-brain 的影响**: 原始 spec 的 `transition()` 校验是正确的，但缺少 checkpoint 持久化。每次 `transition()` 后应异步写 checkpoint，`resume` 时校验状态合法性。

#### 发现 2: git stash 方案的可靠性不如事务性快照

原始 spec 用 `git stash` 做沙箱。论文 (Dec 2025) 指出更好的方案是**事务性文件系统快照**:
- 100% 回滚成功率 (git stash 在冲突时可能失败)
- 快照粒度更细 (per-file vs per-repo)
- 开销 ~14.5% (可接受)

但 dev-brain 运行在本地 Mac/Linux，没有容器/VM 环境。**折中方案**: 保留 git 方案但增加 pre-flight 校验 + 事务性语义:
- 执行前: `git stash push` + 验证 stash 成功 + 记录 baseline commit SHA
- 回滚: `git reset --hard <baseline>` + `git stash pop` (双保险)
- 失败时: git stash pop 失败 → `git reset --hard` (最后防线)

#### 发现 3: Wink 的异步自干预优于同步 Self-Correction

原始 spec 的 Self-Correction 是同步的 (失败 → 分析 → 修复 → 重试)。Wink (Feb 2026) 的发现:
- **异步观察 + 靶向干预** 比"每次失败都全量分析"更高效
- 3 类 misbehavior 分类比原始 violationType 更贴近实际:
  - Specification Drift — Agent 偏离了用户意图
  - Reasoning Problems — 逻辑错误或死循环
  - Tool Call Failures — API/工具使用错误

**对 dev-brain 的影响**: 保留 L1 归因 + 分流决策框架 (博弈论安全)，但增加 Wink 的 misbehavior 分类作为归因的第二层。

#### 发现 4: 验收应该是分层金字塔而非线性流水线

原始 spec 的 4 阶段线性流水线 (test → lint → typecheck → reviewer) 是正确的，但 Gearset 的分层金字塔提供了更好的视角:
- **快速层** (lint + typecheck): < 30s, 先跑, 失败立即终止
- **核心层** (unit test): < 2min, 验证行为正确性
- **增强层** (reviewer agent): 可选, 非阻塞, 建议性

**对 dev-brain 的影响**: 调整验收顺序为快速层优先 (fail-fast)，reviewer agent 改为非阻塞 (产出建议但不阻挡 SUCCESS)。

---

## 第 2 轮: 方案对比 — "在 dev-brain 约束下哪个最优？"

### 候选方案

| 方案 | 核心思路 | 代表 |
|------|---------|------|
| **A: 原始 spec** | 6 状态 FSM + git stash 沙箱 + 同步 Self-Correction + 线性验收 | dev-brain v0.11.0 原 spec |
| **B: LangGraph 风格** | 全量 checkpoint 持久化 + PostgreSQL + 时间旅行 | LangGraph 1.0 |
| **C: K8s 沙箱风格** | gVisor 容器隔离 + 预热池 + Pod Snapshot | Google Agent Sandbox |
| **D: 混合增强版 (推荐)** | 保留原始框架 + checkpoint 持久化 + 双保险回滚 + Wink 分类 + 分层验收 | 新设计 |

### 方案对比矩阵

| 维度 | A (原 spec) | B (LangGraph) | C (K8s) | D (混合) |
|------|-----------|---------------|---------|---------|
| 状态持久化 | ⭐⭐ (内存 FSM) | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| 沙箱可靠性 | ⭐⭐⭐ (单 git stash) | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ (双保险) |
| 部署复杂度 | ⭐ | ⭐⭐⭐⭐ (需 PG) | ⭐⭐⭐⭐⭐ (需 K8s) | ⭐⭐ |
| 恢复智能化 | ⭐⭐⭐ | ⭐⭐ | ⭐⭐ | ⭐⭐⭐⭐ (Wink) |
| 验收效率 | ⭐⭐ (线性) | ⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ (分层) |
| dev-brain 适配 | ⭐⭐⭐⭐ | ⭐⭐ | ⭐ | ⭐⭐⭐⭐ |

### 推荐: 方案 D — 混合增强版

**理由**: dev-brain 运行在本地单机，没有 PostgreSQL/Redis/K8s 基础设施。保留原始 spec 的核心框架，在关键路径上增强可靠性。

---

## 第 3 轮: 详细设计

### 3.1 架构概览

```
BrainEngine
    │
    ├── Orchestrator (v0.10.0)
    │       │
    │       ├── StateMachine (CAP-MAR-01)  ← 迁移校验 + checkpoint
    │       │       └── CheckpointStore     ← NEW: JSON 文件持久化
    │       │
    │       ├── SandboxManager (CAP-MAR-02) ← 双保险回滚
    │       │       ├── PreFlightCheck      ← NEW: 执行前校验
    │       │       └── RollbackStrategy    ← NEW: 双路径回滚
    │       │
    │       ├── HeartbeatWatcher (CAP-MAR-03) ← 结构化心跳
    │       │       └── ProgressParser      ← NEW: 解析进度元数据
    │       │
    │       ├── SelfCorrector (CAP-MAR-04)  ← L1 归因 + Wink 分类
    │       │       ├── AttributionEngine   (确定性规则)
    │       │       ├── MisbehaviorClassifier ← NEW: Wink 3 类
    │       │       └── TriageRouter        (修复/进化/升级)
    │       │
    │       └── AcceptancePipeline (CAP-MAR-05) ← 分层金字塔
    │               ├── FastGate            ← NEW: lint + typecheck (< 30s)
    │               ├── CoreGate            (unit test)
    │               └── ReviewGate           (reviewer agent, 非阻塞)
    │
    └── Agent Adapters (claude/codex/cursor)
```

### 3.2 核心改动 vs 原始 spec

| 原始 spec | 混合增强版 | 改动理由 |
|-----------|----------|---------|
| 内存 FSM, 无持久化 | FSM + CheckpointStore (JSON 文件, 每次 transition 写) | LangGraph 1.0 共识: crash 后可恢复 |
| git stash 单路径回滚 | git stash + `git reset --hard <baseline>` 双保险 | 事务性快照论文: 回滚成功率从 ~95% → 100% |
| 心跳仅检测活性 | 心跳 + 进度解析 (progress metadata) | Wink: 区分"活着但卡住" vs "活着且在思考" |
| Self-Correction 同步 | 保留同步框架 + Wink 3 类 misbehavior 分类 | Wink 90% 单次干预解决率 |
| 线性验收流水线 | 分层金字塔: FastGate → CoreGate → ReviewGate (非阻塞) | Gearset: 快速失败节省时间 |

### 3.3 CAP-MAR-01 增强: Checkpoint 持久化

> 保留 6 状态 FSM, 增加每次 transition 后的 checkpoint 持久化。

**新增组件**: `CheckpointStore`

```typescript
class CheckpointStore {
  // 写入: 每次合法 transition 后异步写 (不阻塞状态迁移)
  async save(state: SubtaskState, ctx: CheckpointContext): Promise<void>;
  
  // 恢复: resume 时读取最后一个 checkpoint
  async load(taskId: string): Promise<SubtaskState | null>;
  
  // 校验: 检查 checkpoint 中的状态与当前期望状态是否一致
  validate(stored: SubtaskState, expected: SubtaskState): boolean;
  
  // 存储: ~/.dev-brain/checkpoints/<taskId>/subtask-<n>.json
}
```

**持久化内容**:
```json
{
  "taskId": "...",
  "subtaskId": "st-1",
  "state": "running",
  "transitionHistory": [
    {"from": "pending", "to": "running", "at": "2026-06-06T10:00:00Z"}
  ],
  "agentName": "claude",
  "sandboxBaselineSha": "abc123",
  "attemptNumber": 1,
  "savedAt": "2026-06-06T10:00:01Z"
}
```

**Scenario: crash 恢复**
- GIVEN subtask st-1 在 RUNNING 状态, 最新 checkpoint 已持久化
- WHEN 进程 crash 后重启
- THEN Orchestrator 读取 checkpoint
- AND 校验 checkpoint.state = "running" 合法
- AND 从 RUNNING 状态恢复, 重新 spawn Agent
- AND 不需要重新走 PENDING → RUNNING

### 3.4 CAP-MAR-02 增强: 双保险沙箱

> 保留 git stash 方案, 增加 pre-flight 校验 + 双路径回滚。

**Pre-flight 校验** (执行前):
1. `git status --porcelain` — 检查 workDir 是否有未跟踪修改
2. `git stash push -u -m "sandbox-<taskId>"` — 暂存本地修改
3. 验证 stash 成功: `git stash list | grep sandbox-<taskId>`
4. 记录 baseline: `git rev-parse HEAD` → baselineSha
5. 任一失败 → 拒绝派发, 任务 FAILED

**双路径回滚** (失败时):
```
路径 1 (优先): git checkout -- . + git clean -fd + git stash pop
路径 2 (兜底): git reset --hard <baselineSha>
  (当路径 1 的 stash pop 冲突时触发)
```

**Guarantee 等级标注**:
```typescript
type SandboxGuarantee = 'ATOMIC' | 'BEST_EFFORT' | 'NO_ROLLBACK';

interface SandboxConfig {
  guarantee: SandboxGuarantee;
  // ATOMIC: 必须回滚成功, 否则 panic (默认)
  // BEST_EFFORT: 尝试回滚, 失败记录 metric 但不 panic
  // NO_ROLLBACK: 不回滚 (用于只读操作)
}
```

### 3.5 CAP-MAR-03 增强: 结构化心跳

> 保留 30s 心跳 + 2 次丢失触发 cancel, 增加进度元数据解析。

**心跳格式升级**:
```
旧: __dev_brain_heartbeat__
新: __dev_brain_heartbeat__ <progress phase="execution" pct="60" msg="running tests"/> <tool>vitest</tool>
```

**进度解析**:
```typescript
interface HeartbeatData {
  phase: 'thinking' | 'tool_call' | 'executing' | 'waiting';
  progressPct: number;          // 0-100
  currentTool?: string;         // 当前工具名
  message?: string;             // 可读描述
}
```

**增强的活性判断**:
- 有心跳 + progressPct 有变化 → Agent 正常工作中
- 有心跳 + progressPct 不变 (连续 3 次) → Agent 可能卡住 (活但无进展)
- 无心跳 → 触发 cancel (与原始一致)

**与 communication-layer 联动**:
- HeartbeatData 自动转换为 ProgressEvent 推送飞书卡片 (CAP-COM-01)
- 用户可以看到 "正在执行 vitest (60%)" 而非 "思考中..."

### 3.6 CAP-MAR-04 增强: Wink 分类集成

> 保留 L1 归因 + 分流决策, 增加 Wink 的 3 类 misbehavior 分类作为归因第二层。

**双层归因模型**:

```
Layer 1 (L1 可信源): violationType
  ├── missing_test    → acceptance.test = fail
  ├── spec_violation  → git diff 不匹配 spec 要求
  ├── timeout         → heartbeat.lostBeats > 0
  ├── lint_error      → acceptance.lint = fail
  ├── type_error      → acceptance.typecheck = fail
  └── unattributable  → 无法从 L1 数据判定

Layer 2 (Wink 分类, 辅助语义): misbehaviorCategory
  ├── specification_drift → Agent 偏离了 spec 意图
  ├── reasoning_problem   → 逻辑错误或死循环
  └── tool_call_failure   → API/工具使用错误
```

**改进的修复策略**:

| misbehaviorCategory | 修复策略 |
|---------------------|---------|
| specification_drift | 重读 spec + 强化 spec 约束 + 可能走进化路径 |
| reasoning_problem | 提供反例 + 要求 Agent 写 reasoning before code |
| tool_call_failure | 检查 tool schema + 提供备选工具路径 |

**与原始 spec 保持一致**: L1 归因仍然是唯一的"判决依据"，Wink 分类仅作为修复路径的辅助信息。归因引擎保持确定性规则（博弈论安全）。

### 3.7 CAP-MAR-05 增强: 分层验收金字塔

> 保留 4 阶段验收, 改为分层执行: 快速闸门 → 核心闸门 → Review 闸门。

```
FastGate (< 30s, fail-fast)
  ├── lint: pnpm lint <changed-files>
  └── typecheck: pnpm typecheck --noEmit
  ↓ pass
CoreGate (< 2min)
  └── unit test: pnpm test <changed-package>
  ↓ pass
ReviewGate (non-blocking, advisory)
  └── reviewer agent: spawn codex as reviewer
      (产出 review comments, 不阻塞 SUCCESS)
```

**改动要点**:
- FastGate 任一失败 → 立即 FAILED, 不跑 CoreGate
- ReviewGate 改为**非阻塞**: 产出 review comments 写文件, 但 subtask 仍然 SUCCESS
- Reviewer agent timeout 从 5min → 2min

**Scenario: FastGate 快速失败**
- GIVEN Agent 产出的代码有 lint error
- WHEN FastGate 跑 lint
- THEN < 10s 发现 lint error → 立即 FAILED
- AND 不浪费 2min 跑测试
- AND Self-Correction 收到精确的 lint_error 归因

### 3.8 与博弈论共识的一致性检查

| 博弈论共识 | multi-agent-runtime 如何满足 |
|----------|--------------------------|
| 不依赖 LLM 自述 reasoning | L1 归因全部来自系统采集 (git diff / acceptance / heartbeat), Agent 无法篡改 |
| Self-Correction 不创造搭便车 | 分流决策: 偶发修复 (不扣绩效) vs 系统失败 (走进化, 需修改 spec) |
| 不可归因不上报 | unattributable → 待观察队列, ≥ 5 条同 pattern 再重新归因 |
| DiagnosticLLM 道德风险 | Self-Correction 不涉及 prompt 修改建议 (那是 evolution 的职责) |
| 熔断兜底 | StateMachine 的 CANCELLED 状态 + Heartbeat 丢失 → 自动清理, 不占资源 |

### 3.9 Metric 新增

```
# Checkpoint
runtime.checkpoint.saved_total           — checkpoint 写入次数
runtime.checkpoint.load_total            — checkpoint 恢复次数
runtime.checkpoint.corrupt_total         — checkpoint 损坏次数 (应趋近 0)

# Sandbox
runtime.sandbox.preflight_failed_total   — pre-flight 校验失败
runtime.sandbox.rollback_path{primary|fallback} — 回滚路径分布
runtime.sandbox.guarantee_violation_total — ATOMIC 回滚失败 (应=0)

# Heartbeat (增强)
runtime.heartbeat.stalled_total          — 有心跳但无进展 (counter)
runtime.heartbeat.progress_delta         — 进度变化量 (gauge)

# Self-Correction (增强)
runtime.self_correction.misbehavior_total{category} — Wink 分类计数
```

---

## 设计总结

### 与原始 spec 的差异

| 维度 | 原始 spec | 混合增强版 |
|------|----------|----------|
| **状态机** | 内存 FSM 校验 | FSM + CheckpointStore (JSON 持久化, crash 可恢复) |
| **沙箱** | git stash 单路径回滚 | PreFlight + 双路径回滚 (stash pop → reset --hard 兜底) + guarantee 等级 |
| **心跳** | 纯活性检测 | 活性检测 + 进度解析 + 停滞判断 |
| **归因** | L1 归因 (缺测试/超时/...) | L1 归因 + Wink 3 类 misbehavior 辅助分类 |
| **验收** | 线性 4 阶段 | 分层金字塔: FastGate → CoreGate → ReviewGate (非阻塞) |
| **持久化** | 无显式 checkpoint | CheckpointStore (每次 transition 写入) |

### 行业对标

| 特性 | 来源 |
|------|------|
| Checkpoint 持久化 + 时间旅行 | LangGraph 1.0 (2025) |
| 事务性沙箱双保险回滚 | Fault-Tolerant Sandboxing (Dec 2025) |
| 结构化心跳 + 进度解析 | Wink trajectory observation (Feb 2026) |
| Wink 3 类 misbehavior 分类 | Wink (Feb 2026) |
| 分层验收金字塔 | Gearset Agentforce Testing (2025) |
| L1 可信源归因 + 博弈论安全 | dev-brain 博弈论审查共识 (Jun 2026) |
