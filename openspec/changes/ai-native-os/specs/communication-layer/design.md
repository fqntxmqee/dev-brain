---
demand-id: DM-20260606-003
change: ai-native-os
module: communication-layer
status: developing
---

# Communication Layer 深度设计：Grill with Docs 3 轮

**日期**: 2026-06-06
**关联**: `docs/philosophy.md`

---

## 目标锚定

### L1 — 用户说想要什么？

> "流式推送 + 签名鉴权 + 多模态 + 任务完成卡"

原始 spec (CAP-COM-01..04) 的描述:
- CAP-COM-01: 流式推送 LLM 思考/工具调用到飞书卡片，节流 200ms
- CAP-COM-02: HMAC-SHA256 签名验证飞书回调
- CAP-COM-03: 图片 OCR + 文件下载 + PR 链接解析
- CAP-COM-04: 结构化任务完成卡 (summary/changes/tests/artifacts/trace_id)

### L2 — 本质上用户想达成什么？

**用户不是在要"4 个通信功能"，用户在要一种交互体验:**

> 用户在飞书这端，能像坐在 Agent 旁边一样，实时看到它在想什么、做什么、做到哪了、为什么卡住了、结果是什么——而不只是一段漫长的沉默后突然收到结果。

翻译成系统目标:
1. **消除黑盒等待**: 用户在长任务 (3-10min) 期间不知道 Agent 是死是活，需要实时进度信号
2. **降低信息密度差**: 用户和 Agent 掌握的信息不对等——用户贴图/发链接/给指令时附带大量隐式信息，系统需要完整提取
3. **可验证的结果呈现**: 用户拿到结果后不需要翻 git log / 跑测试 / 读源码来验证，卡片已包含变更摘要 + 测试结果 + 可追溯 trace
4. **多 Agent 过程透明**: 当多个 Agent 协作（辩论、并行子任务），用户需要知道谁说了什么、不同意见是什么、最终决策怎么来的

### L3 — 约束条件是什么？

| 约束 | 来源 | 严苛度 |
|------|------|--------|
| 飞书卡片 28KB 上限 | v0.9.0 card-degrader | 硬约束 |
| 飞书 API 限流 (100 次/min/卡片) | 飞书开放平台 | 硬约束 |
| 节流延迟不能阻塞主流程 | 架构共识 | 硬约束 |
| 不能依赖 LLM 自述的"我做了 X"做进度 | 博弈论审查共识 | 硬约束 |
| 多 Agent 辩论过程不能全量推到用户侧 (信息过载) | UX 常识 | 软约束 |
| 错误信息要可读但不能泄露内部实现细节 | 安全约束 | 硬约束 |
| 图片 OCR 走第三方 (MiniMax),延迟不可控 | 外部依赖 | 软约束 |
| 卡片原地 update 而非多发 (避免刷屏) | v0.9.0 已有约束 | 硬约束 |

### 核心矛盾

```
飞书卡片 28KB 上限 + 100 次/min 限流
    ↕
用户需要看到实时思考 + 工具调用 + 多 Agent 辩论 + 阶段性总结 + 最终结果
    ↕
全量推送会刷屏 + 超上限，不推送会回到黑盒
    ↕
关键问题: 什么该推？以什么粒度推？什么时候推？
```

**这就是 communication-layer 要解决的本质问题。**

---

## 第 1 轮: 问题空间探索 — "业界怎么解决 Agent-用户通信问题的？" — "业界怎么解决 Agent-用户通信问题的？"

### 信息来源

| 来源 | 类型 | 关键内容 |
|------|------|---------|
| [AG-UI Protocol](https://www.copilotkit.ai/blog/master-the-17-ag-ui-event-types-for-building-agents-the-right-way) (May 2025) | 开放协议 | 17 种标准化事件类型 (生命周期/文本消息/工具调用/状态管理/自定义) |
| [飞书 CardKit v2.0 流式卡片](https://open.larkoffice.com/document/cardkit-v1/streaming-updates-openapi-overview) (Jun 2025) | 官方文档 | 打字机效果 + 组件级更新 (10次/秒) + 10min 自动关闭 |
| [LangGraph Streaming 5 模式](https://dev.to/sreeni5018/langgraph-streaming-101-5-modes-to-build-responsive-ai-applications-4p3f) (2025) | 工程实践 | `updates + custom + messages` 三流并行 + SSE 传输 |
| [Claude Code CCUI](https://www.npmjs.com/package/@ccui-summer/claude-code-ui) (2025) | 开源项目 | Thinking block 可视化 + 工具进度条 + 子 Agent 容器 |
| [OrchVis 多 Agent 可视化](https://web3.arxiv.org/pdf/2510.24937) (Georgia Tech, 2025) | 学术论文 | 层级可见性: 目标常显 + 任务可展开 + 冲突高亮 |
| [Hermes Lark Streaming](https://github.com/Cheerwhy/hermes-lark-streaming) (2025) | 开源插件 | 单卡片动态渲染思考/工具调用/回答 + token 用量展示 |
| [Atomicwork Chat Streaming](https://www.atomicwork.com/blog/atom-chat-streaming-experience) (2025) | 产品博客 | 状态化聊天对象模型: append/update/structured 分离 |

### 关键发现

#### 发现 1: 业界已从"文本流"进化到"结构化事件流"

原始 spec 的设计:
```
push(content: string) → 节流 200ms → updateCard
```
所有增量都是无类型的字符串拼接。

**AG-UI 的做法**: 17 种事件类型，前端根据事件类型渲染不同 UI:
```
TOOL_CALL_START → 渲染工具调用进度条
TEXT_MESSAGE_CONTENT → 追加文本 token
RUN_FINISHED → 关闭进度指示器
```

**对 dev-brain 的影响**: 原始 spec 把"LLM 思考"和"工具调用结果"和"进度更新"都当作文本 delta。应该引入**事件类型分类**，让飞书卡片能区分渲染:
- 思考内容 → 可折叠区域
- 工具调用 → 独立区块 (工具名 + 参数 + 结果摘要)
- 进度更新 → header 状态栏
- 文本输出 → 正文区域

#### 发现 2: 飞书 CardKit v2.0 流式卡片是 game-changer

原始 spec 写于飞书推出流式卡片之前。CardKit v2.0 (2025.06) 提供了:
- **打字机效果**: `streaming_mode: true` + `print_strategy: "fast"` 
- **组件级更新**: 可独立更新卡片的某一区域，而非整卡 replace
- **10 次/秒更新频率**: 足够支持实时思考流
- **10 分钟自动关闭**: 长任务需要考虑流式模式的超时边界

**对 dev-brain 的影响**: 原始 spec 的"节流 200ms → updateCard"是飞书旧 API 的妥协方案。CardKit v2.0 流式卡片提供了更细粒度的更新能力，应该重新设计推送策略。

#### 发现 3: 层级可见性是解决"信息过载"的关键

OrchVis 的研究结论: **用户首先关注结果 (目标是否达成)，只在结果异常时才检查过程细节**。

这意味着:
- 多 Agent 辩论过程不应该全量推到用户侧
- 默认展示: 当前阶段 + 关键决策 + 进度百分比
- 按需展开: 具体辩论内容、工具调用细节、子 Agent 输出

LangGraph 的 `stream_mode=["updates", "custom", "messages"]` 三流并行正是这个思路:
- `updates` → 节点级状态变更 (当前在哪个阶段)
- `custom` → 应用自定义进度事件 (关键决策/里程碑)
- `messages` → LLM token (仅在用户想看到时展开)

#### 发现 4: 多 Agent 身份区分是信任的基础

Claude Code CCUI 的实现: 每个子 Agent 有独立容器 + task ID + 进度日志。用户可以区分"这是主 Agent 的思考"vs"这是子 Agent 的执行结果"。

原始 spec 没有区分 Agent 身份 — 所有输出混在一起。dev-brain 的场景更复杂:
- **辩论阶段**: Claude vs Codex 的不同观点
- **执行阶段**: 多个并行子任务的进度
- **Review 阶段**: Reviewer Agent 的反馈

用户需要知道"谁在说话、说到哪了"。

---

## 第 2 轮: 方案对比 — "在 dev-brain 约束下哪个最优？"

### 候选方案

| 方案 | 核心思路 | 代表 | 优势 | 劣势 |
|------|---------|------|------|------|
| **A: 原始 spec** | 无类型文本流 + 节流 200ms + updateCard | dev-brain v0.11.0 原 spec | 简单 | 信息混杂,无法区分 Agent,不支持流式卡片 |
| **B: AG-UI 协议映射** | 17 种事件类型 → 飞书卡片组件映射 | AG-UI (CopilotKit) | 标准化,可互操作 | 重(17 种事件对飞书卡片过度),需要前端渲染引擎 |
| **C: 层级可见性** | 目标常显 + 任务可展开 + 冲突高亮 | OrchVis (Georgia Tech) | 信息架构清晰,防过载 | 偏研究,缺少工程实现参考 |
| **D: 混合精简版 (推荐)** | 结构化事件 + 层级渲染 + 飞书流式卡片 + 多 Agent 身份 | 新设计 | 切合飞书约束,轻量,解决核心矛盾 | 需要重新定义事件类型 |

### 方案对比矩阵

| 维度 | A (原 spec) | B (AG-UI) | C (OrchVis) | D (混合) |
|------|-----------|-----------|------------|---------|
| 信息清晰度 | ⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| 多 Agent 区分 | ❌ | ⚠️ (需自定义) | ⚠️ (需自定义) | ✅ |
| 飞书适配 | ⭐⭐⭐ | ⭐⭐ | ⭐ | ⭐⭐⭐⭐ |
| 实现复杂度 | ⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ |
| 博弈论安全 | ⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ |
| 信息过载控制 | ❌ | ⚠️ | ✅ | ✅ |

### 推荐: 方案 D — 混合精简版

**理由**:
1. AG-UI 的 17 种事件对飞书卡片过于细粒度 — 飞书不是 React 前端，不需要 STATE_DELTA 
2. 但 AG-UI 的**事件分类思想** (生命周期/文本/工具/状态) 是正确的，应取其分类而非完整协议
3. OrchVis 的层级可见性原则直接解决"信息过载 vs 黑盒"的核心矛盾
4. 飞书 CardKit v2.0 流式卡片是必须利用的基础能力

---

## 第 3 轮: 详细设计

### 3.1 架构概览

```
飞书用户
    ↕ Feishu Card (CardKit v2.0 流式卡片)
    ↕ FeishuGateway
    ↕ CommunicationLayer
    ├── EventBus            ← 统一事件总线
    │   ├── ThinkingEvent   (LLM 思考)
    │   ├── ToolCallEvent   (工具调用)
    │   ├── ProgressEvent   (阶段进度)
    │   ├── DecisionEvent   (关键决策/分歧)
    │   └── AgentEvent      (Agent 身份切换)
    ├── CardRenderer        ← 事件 → 卡片组件映射
    │   ├── HeaderZone      (常显: 阶段 + 进度)
    │   ├── ContentZone     (流式: 当前输出)
    │   ├── CollapseZone    (可折叠: 工具/辩论详情)
    │   └── FooterZone      (指标: token/耗时)
    └── StreamingController ← 节流 + 频率控制
```

### 3.2 核心改动 vs 原始 spec

| 原始 spec | 混合精简版 | 改动理由 |
|-----------|----------|---------|
| 无类型文本流 push(content) | **5 种结构化事件** (Thinking/ToolCall/Progress/Decision/Agent) | AG-UI 共识: 事件类型决定渲染方式 |
| updateCard 整卡替换 | **CardKit v2.0 流式卡片** — 组件级独立更新 | 飞书 2025.06 新能力, 打字机效果 + 区域隔离 |
| 无 Agent 身份区分 | **AgentEvent** 标记身份切换 (Claude/Codex/DeepSeek/子Agent) | Claude Code CCUI 实践: 用户需要知道"谁在说话" |
| 所有内容平等推送 | **层级可见性**: Header(常显) → Content(流式) → Collapse(可折叠) | OrchVis 发现: 用户关注结果 > 过程 |
| 节流 200ms 全局 | **分区域节流**: Header 1s / Content 200ms / Collapse 2s | 不同信息时效性不同 |

### 3.3 结构化事件模型

```typescript
// 核心: 替代原始的无类型 push(content: string)

type CommunicationEvent =
  | ThinkingEvent     // LLM 思考过程 (可折叠)
  | ToolCallEvent     // 工具调用 (独立区块)
  | ProgressEvent     // 阶段进度 (header 状态栏)
  | DecisionEvent     // 关键决策/分歧 (高亮)
  | AgentEvent;       // Agent 身份切换

interface ThinkingEvent {
  type: 'thinking';
  agent: 'claude' | 'codex' | 'deepseek' | 'subagent';
  agentName: string;              // "Claude (工程视角)" / "Codex (博弈论视角)"
  phase: 'debate' | 'openspec' | 'execution' | 'review';
  round?: number;                 // 辩论轮次
  delta: string;                  // 增量文本
  isComplete: boolean;            // 该段思考是否结束
}

interface ToolCallEvent {
  type: 'tool_call';
  toolName: string;               // "git diff" / "npm test" / "gh pr view"
  toolArgs?: string;              // 参数摘要 (截断至 100 chars)
  status: 'started' | 'running' | 'success' | 'error';
  result?: string;                // 结果摘要 (截断至 200 chars)
  duration?: number;              // 执行耗时 ms
}

interface ProgressEvent {
  type: 'progress';
  phase: 'intent' | 'debate' | 'openspec' | 'execution' | 'review' | 'complete';
  phaseLabel: string;             // "辩论阶段 R1/3" / "子任务 2/5"
  percent: number;                // 0-100, 当前阶段内百分比
  message: string;                // "正在分析需求..." / "Claude 正在生成 spec..."
}

interface DecisionEvent {
  type: 'decision';
  importance: 'info' | 'warning' | 'critical';
  title: string;                  // "决策: 采用 adapter 模式隔离旧接口"
  detail?: string;                // 决策原因/分歧点
  consensus: boolean;             // true=多方共识, false=存在分歧
}

interface AgentEvent {
  type: 'agent_switch';
  agent: string;
  role: string;                   // "主 Agent" / "博弈论审查" / "代码执行" / "Review"
  action: 'enter' | 'exit';
}
```

### 3.4 飞书卡片渲染布局 (CardKit v2.0 流式卡片)

```
┌─────────────────────────────────────────┐
│  🔄 [阶段标签]  [进度%]  [耗时]  [token] │  ← HeaderZone (1s 节流)
├─────────────────────────────────────────┤
│                                         │
│  📝 当前输出内容 (打字机效果)             │  ← ContentZone (200ms 节流)
│                                         │
├─────────────────────────────────────────┤
│  🛠️ 工具调用                            │  ← CollapseZone (可折叠)
│    ├─ git diff (✅ 320ms)               │
│    ├─ npm test (🔄 running...)          │
│    └─ gh pr view (⏳ pending)           │
├─────────────────────────────────────────┤
│  🧠 思考过程                            │  ← CollapseZone (可折叠)
│    ├─ [Claude R1] 理解: trade 模块...   │
│    └─ [Codex R1] 博弈论分析: ...         │
├─────────────────────────────────────────┤
│  ⚡ 关键决策                            │  ← CollapseZone (有分歧时高亮)
│    ⚠️ 决策: 采用 adapter 模式 (有分歧)   │
├─────────────────────────────────────────┤
│  📊 子任务进度                          │
│    st-1: trade 重构     ✅              │
│    st-2: 日期筛选       🔄              │
│    st-3: 测试更新       ⏳              │
└─────────────────────────────────────────┘
```

**区域更新策略**:

| 区域 | 更新频率 | 节流 | 折叠默认 |
|------|---------|------|---------|
| HeaderZone (阶段/进度) | 每阶段 1-3 次 | 1s | 不可折叠 |
| ContentZone (当前输出) | 实时流式 | 打字机效果 | 不可折叠 |
| CollapseZone (工具调用) | 每次工具调用 | 500ms 合并 | 默认折叠 |
| CollapseZone (思考过程) | 每段思考结束 | 2s | 默认折叠 |
| CollapseZone (关键决策) | 仅产生决策时 | 无节流 | 默认展开 |
| FooterZone (子任务) | 子任务完成时 | 无节流 | 默认展开 |

### 3.5 CAP-COM-01 修订: 结构化流式推送

> **v0.11.0 修订**: 从无类型文本流改为结构化事件流，利用飞书 CardKit v2.0 流式卡片。

**核心改动**:
- 输入从 `push(content: string)` 改为 `push(event: CommunicationEvent)`
- CardRenderer 根据事件类型路由到对应卡片区域
- 飞书底层从 `updateCard` 改为 CardKit v2.0 流式卡片 API

**流控策略**:

```
事件率限制:
  ContentZone (ThinkingEvent):  打字机效果，飞书 print_frequency_ms=70
  其他区域更新:                  不超过 10 次/秒 (飞书卡片 API 上限)
  
Token 预算:
  单次卡片 content ≤ 28KB (飞书卡片上限)
  超过走 card-degrader 三段降级 (v0.9.0 已有)
  
长任务保护:
  飞书流式卡片 10min 自动关闭
  任务超过 8min 时，自动关闭流式模式，切为阶段性 summary 更新
  (每 2min 更新一次进度 + 最新决策摘要)
```

### 3.6 CAP-COM-01 新增: 多 Agent 身份流

> **v0.11.0 新增**: 原始 spec 未区分 Agent 身份。新增 AgentEvent 标记身份切换。

**场景: 辩论阶段 Agent 切换**
```
用户看到:
  [Claude (工程)] 正在分析需求...     ← AgentEvent: enter
  ├─ 理解: trade 模块重构需求
  ├─ 风险: 旧接口兼容性
  └─ 方案: adapter 模式
  [Claude (工程)] 思考完成            ← AgentEvent: exit
  
  [Codex (博弈论)] 正在审查...        ← AgentEvent: enter
  ├─ 博弈分析: Claude 的方案忽略...
  └─ 建议: 增加 rollback 机制
  [Codex (博弈论)] 审查完成           ← AgentEvent: exit
```

**信息隔离**: 
- 每个 Agent 的思考块独立渲染，通过 `agentName` + 颜色/图标区分
- 用户一眼能看出"这是工程建议还是博弈论审查"
- 不同 Agent 的矛盾观点在 DecisionEvent 中汇总

### 3.7 CAP-COM-04 修订: 阶段总结代替一次性完成卡

> **v0.11.0 修订**: 原始 spec 只在 task 结束时发一张完成卡。对于 3-10 分钟的复杂任务，用户需要中间看到阶段性结论。

**新增: 阶段性 Summary**

| 阶段 | 触发时机 | Summary 内容 |
|------|---------|-------------|
| 意图分析完成 | IntentEngine 输出 | 理解摘要 (50 字) + 分类 + 关键参数 |
| 辩论完成 | debate_end 节点 | 共识点 + 分歧点 + 决策 (100 字/项) |
| OpenSpec 生成 | openspec 写入后 | spec 摘要 + tasks 数量 + 预估时间 |
| 子任务过半 | 50% 子任务完成 | 进度 (X/5) + 关键产出 + 已发现问题 |
| 任务完成 | task.complete | 完整 TaskDoneCard (与原始 spec 一致) |

**与原始 spec 的关系**:
- 原始 CAP-COM-04 TaskDoneCard 保留，作为最终总结
- 新增的阶段性 Summary 是**同一张流式卡片上的折叠区域更新**，不是新卡片
- 流式卡片在任务完成时关闭 streaming_mode → 变成静态完成卡

### 3.8 CAP-COM-03 修订: 多模态 + 多 Agent 上下文

> **v0.11.0 修订**: 原始 spec 的多模态只做 OCR/文件/PR 链接。但 dev-brain 的"多 Agent"场景还需要解析 Agent 间通信内容。

**保持不变**: 图片 OCR、文件附件、PR 链接解析 (CAP-COM-03 原始)

**新增: Agent 通信内容可视化**
- 当 debate 阶段产生 Agent 间辩论内容，CommunicationLayer 提取关键论点作为 DecisionEvent
- 当并行子任务产生关联结果，CommunicationLayer 生成交叉引用卡片

### 3.9 与博弈论共识的一致性检查

| 博弈论共识 | communication-layer 如何满足 |
|----------|--------------------------|
| 不依赖 LLM 自述 reasoning | ProgressEvent 的 `percent` 和 `message` 来自**系统状态机** (BrainTaskPlan.subtasks[i].status)，不来自 Agent 自述 |
| 前台/后台信息隔离 | CommunicationLayer 只展示**系统可观测的事实** (工具调用结果、阶段切换、测试通过/失败)，不展示 Agent 内部策略 |
| 均衡分析 (6 个月后) | 如果 Agent 知道用户会看到详细思考过程，会产生"表演性思考" (为展示而思考) → 默认折叠思考区域，降低表演动机 |
| 不可归因的不展示 | Agent 的 tentative/internal reasoning (低置信度假设) 不推送到用户侧 |

### 3.10 Metric

新增 (替代原始 spec 的仅 push_failed):

```
# 事件流
gateway.event.total{type}              — 各事件类型计数 (counter)
gateway.event.dropped_total{reason}    — 被丢弃事件 (节流/超预算)
gateway.event.latency_ms               — 事件产生到推送延迟 (histogram)

# 卡片渲染
gateway.card.render_duration_ms        — 卡片渲染耗时 (histogram)
gateway.card.update_total{zone}        — 各区域更新计数 (counter)
gateway.card.streaming_timeout_total   — 流式卡片超时切换 (counter)

# Agent 身份
gateway.agent.switch_total{from,to}    — Agent 身份切换次数 (counter)

# 流控
gateway.streaming.throttle_total       — 节流合并次数 (counter)
gateway.streaming.push_failed_total    — 推送失败次数 (counter)
```

---

## 设计总结

### 与原始 spec 的差异

| 维度 | 原始 spec | 混合精简版 |
|------|----------|----------|
| **推送粒度** | 无类型文本流 | 5 种结构化事件 (Thinking/ToolCall/Progress/Decision/Agent) |
| **卡片 API** | updateCard 整卡替换 | CardKit v2.0 流式卡片, 组件级更新 |
| **Agent 身份** | 不区分 | AgentEvent 标记身份 + 颜色/图标区分 |
| **信息架构** | 所有内容平等 | 层级可见性: Header(常显) → Content(流式) → Collapse(可折叠) |
| **阶段性总结** | 仅完成时 1 张卡 | 5 个阶段 Summary + 完成卡 |
| **流控** | 节流 200ms 全局 | 分区域节流 (Header 1s / Content 打字机 / Collapse 2s) |
| **长任务** | 无特殊处理 | 8min 自动切换阶段性 summary 模式 |
| **博弈论安全** | 未考虑 | 仅展示系统可观测事实, 折叠思考降低表演动机 |

### 行业对标

| 特性 | 来源 |
|------|------|
| 结构化事件模型 (5 种类型) | AG-UI 17 种事件分类思想 (May 2025) |
| 流式卡片打字机效果 | 飞书 CardKit v2.0 (Jun 2025) |
| 层级可见性 (结果优先) | OrchVis Georgia Tech (2025) |
| 多 Agent 身份容器 | Claude Code CCUI (2025) |
| 阶段 Summary | LangGraph updates stream (2025) |
| 默认折叠降低表演动机 | dev-brain 博弈论审查共识 (Jun 2026) |
