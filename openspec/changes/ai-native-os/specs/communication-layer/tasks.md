---
demand-id: DM-20260606-003
change: ai-native-os
module: communication-layer
status: developing
---

# Communication Layer — Tasks

> **v0.11.0 修订**: 经行业调研 (AG-UI Protocol / 飞书 CardKit v2.0 / OrchVis), 原始"无类型文本流 + updateCard"设计已替换为结构化事件 + 层级可见性 + 飞书流式卡片。详见 `design.md`。

## 1. 类型骨架 + 事件总线

- [ ] `src/gateway/types.ts` — 定义 `CommunicationEvent` (5 种 type: Thinking/ToolCall/Progress/Decision/Agent) + 飞书卡片区域枚举 (`CardZone`)
- [ ] `src/gateway/event-bus.ts` — `class EventBus { emit(event): void; subscribe(zone, handler): void }`, 生产者/消费者解耦
- [ ] `src/gateway/agent-identity.ts` — Agent 注册表 (id → name/role/color/icon), AgentEvent 自动注入身份

## 2. 结构化流式推送 (CAP-CTX-01)

> 替代原始无类型 `push(content: string)`, 改为结构化事件 → 分区域渲染。

- [ ] `src/gateway/card-renderer.ts` — `class CardRenderer { render(event: CommunicationEvent): void }`
  - ProgressEvent → HeaderZone (文本替换, 1s 节流)
  - ThinkingEvent → ContentZone (打字机效果, CardKit v2.0 streaming_mode)
  - ToolCallEvent → CollapseZone/工具 (追加, 500ms 合并, 默认折叠)
  - DecisionEvent → CollapseZone/决策 (追加, 默认展开, 分歧高亮)
  - AgentEvent → HeaderZone/身份标识 (颜色+图标区分)
- [ ] `src/gateway/streaming-pusher.ts` — 重构: 接收 `CommunicationEvent` 替代 `string`, 调用 CardRenderer
- [ ] 飞书底层迁移到 CardKit v2.0 流式卡片 API:
  - `config.streaming_mode: true` + `config.streaming_config.print_strategy: "fast"`
  - 组件级更新而非整卡 replace
  - 更新频率 ≤ 10 次/秒
- [ ] 层级可见性控制: HeaderZone 不可折叠 / ContentZone 常显 / CollapseZone 默认折叠
- [ ] 长任务保护: 流式卡片超 8min 自动关闭 streaming_mode → 每 2min 推送阶段快照
- [ ] 推送失败 backoff 500ms 重试 1 次, 仍失败写 `gateway.streaming.push_failed_total`
- [ ] 单测 `tests/unit/gateway/event-bus.test.ts`: 3 场景 (事件路由/多订阅者/丢弃)
- [ ] 单测 `tests/unit/gateway/card-renderer.test.ts`: 5 场景 (5 种事件类型 → 对应区域)
- [ ] 单测 `tests/unit/gateway/streaming-pusher.test.ts`: 4 场景 (节流合并/失败重试/flush/超时切换)

## 3. 签名鉴权 (CAP-COM-02)

> 基本不变, 保持原始设计。

- [ ] `src/gateway/signature-verifier.ts` — HMAC-SHA256, 常时间比较
- [ ] secret 优先级: `DEV_BRAIN_FEISHU_VERIFICATION_TOKEN` > `~/.dev-brain/secret` > fail-fast (exit 2)
- [ ] 写 `gateway.signature.verified_total` / `gateway.signature.rejected_total`
- [ ] 单测 `tests/unit/gateway/signature-verifier.test.ts`: 4 场景 (合法/伪造/secret 缺失/旧版 URL 验证兼容)

## 4. 多模态输入 (CAP-COM-03)

> 基本不变, 保持原始设计。

- [ ] `src/gateway/multimodal-parser.ts` — 3 子 parser: image OCR / file download / PR link
- [ ] MiniMax vision 复用 v0.8.0 native backend
- [ ] GitHub 链接走 `gh pr view` 子进程
- [ ] 附件落 `~/.dev-brain/attachments/`, OCR 置信度 < 0.7 标 `ocr_low_confidence`
- [ ] 单测 `tests/unit/gateway/multimodal-parser.test.ts`: 4 场景 (图片/文件/PR/低置信度)

## 5. 阶段总结 + 任务完成卡 (CAP-COM-04)

- [ ] `src/gateway/task-done-card.ts` — 增加 `buildStageSummary(stage, data): CardSection`
- [ ] 5 个阶段 Summary: 意图分析/辩论/OpenSpec/执行过半/任务完成
- [ ] 任务完成卡字段保持: summary/changes/tests/artifacts/trace_id + 原地 update
- [ ] 失败摘要提取: 从 stderr 抽关键行 (最后 5 行 + 匹配 Error 模式的行)
- [ ] 单测 `tests/unit/gateway/task-done-card.test.ts`: 4 场景 (阶段 summary/success/fail/长输出转文档)

## 6. 多 Agent 身份 (CAP-COM-05)

- [ ] Agent 注册表: Claude=蓝色/工程, Codex=紫色/博弈论, DeepSeek=绿色/诊断, 子Agent=灰色/执行
- [ ] AgentEvent 由 BrainEngine 在 Agent 切换时发出 (Agent 不可自发送, 防伪装)
- [ ] DecisionEvent 的 consensus 字段驱动分歧高亮
- [ ] 单测 `tests/unit/gateway/agent-identity.test.ts`: 3 场景 (切换/伪装拒绝/分歧高亮)

## 集成

- [ ] `src/gateway/feishu-gateway.ts` — 接入 CardKit v2.0 流式卡片 API + EventBus
- [ ] `src/brain/brain-engine.ts` — 在关键节点发出 ProgressEvent/DecisionEvent
- [ ] 与 StateMachine (CAP-MAR-01) 联动: 状态迁移 → ProgressEvent
- [ ] 与 Orchestrator 联动: 子任务进度 → ProgressEvent (percent 计算)
