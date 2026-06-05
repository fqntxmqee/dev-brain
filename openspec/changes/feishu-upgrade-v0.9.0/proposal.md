# feishu-upgrade-v0.9.0: 飞书交互闭环 + 发送链路稳健化

## Motivation

dev-brain v0.8.1 走通"飞书收消息 → Brain 规划 → 派发 native agent → 汇总"的端到端流程,
但对照 cc-connect 的飞书实现，仍有以下能力缺口：

| 缺口 | 现象 | 业务影响 |
|------|------|---------|
| **A. 卡片审批按钮实际未生效** | `parseFeishuCardActionEvent` 已实现,但 `lark-cli event +subscribe` 启动时 lark-cli 端未必已注册 `card.action.trigger_v1`;且当 lark-cli 收到的卡片回调时,lark-cli 1.0 的 `--compact` 模式是否向下兼容未确认 | 用户点"批准执行"可能毫无反应,无任何反馈 |
| **B. 卡片只能 send,无法 update** | `updateCard` 已在 LarkCliFeishuReporter 实现,但 FeishuGateway 中无调用点 → 同一计划多次刷新进度时,飞书端会刷出 N 张卡片 | 用户聊天记录被卡片淹没 |
| **C. 错误态无可视反馈** | Brain 任务失败时,飞书只收到一行 `❌ 子任务失败: ...` 文本,无错误摘要卡片 | 用户难以快速定位失败原因 |
| **D. 长文本被截断** | `MAX_REPLY_TEXT_BYTES=16KB` 超限时直接 throw `ReplyTooLongError`,用户收到 `lark-cli exited with code 1` 错误 | 长执行输出(尤其 codex)直接丢失 |
| **E. 卡片内容超长无降级** | `buildSummaryCard` 直接 `slice(0, MAX_DESC_LEN=300)`,超长 subTaskOutputs 被截断 | 子任务 3 个 → 10 个时,后半段完全不可见 |

## Scope (本 change)

**Phase 1 — 卡片交互闭环 (A+B+C)**

1. 注册 `card.action.trigger_v1` 事件订阅(已在 USAGE 文档要求,需落地检测)
2. Gateway 在创建计划时记录 `planMessageId: Map<taskId, messageId>`,后续进度/汇总卡片**原地 update** 而非新增 send
3. 失败时构造专门的 `buildErrorCard()` 替代文本回复,展示失败子任务列表 + 错误原因

**Phase 2 — 发送链路稳健化 (D+E)**

4. `sendText` 超 16KB 时**自动分片**(N 段 ≤ 16KB),用户在飞书端收到 N 条连续消息
5. `buildSummaryCard` / `buildProgressCard` 超 28KB 时**三段降级**:10 步/180 字符 → 6 步/120 字符 → 3 步/80 字符
6. `LarkCliFeishuReporter` 透传 4xx 错误时(401/429),把 stderr 关键错误码回传 Gateway,Gateway 决定是否重试(429 退避,401 提示重新授权)

## Non-Goals (本 change 不做)

- 群聊支持(留到 v0.10.0)
- cardkit 流式卡片(留到 v0.10.0)
- 双向 WS(目前继续 lark-cli `+subscribe` 长连接)
- 多 App 共享 WS 路由(单 app 单 brain bot 足够)

## 关联设计参考

- `cc-connect-src/platform/feishu/feishu.go:1004-1131` — `onMessage` recall/dedup/IsOldMessage/allowFrom/dispatch 链路
- `cc-connect-src/platform/feishu/card.go:91-260` — `renderCardMap` 三段拼装 (config + header + elements)
- `cc-connect-src/platform/feishu/feishu.go:3232-3271` — `withTransientRetry` 退避参数(500ms→5s, +25% jitter, max 3)
- `cc-connect-src/platform/feishu/feishu.go:3130-3143` — `withFreshTenantAccessTokenRetry` 401 重新拉 token

## 验收口径

- typecheck `tsc --noEmit` 绿
- `pnpm test` 全绿(stmt ≥ 80%, branch ≥ 70%)
- 新增单测覆盖:
  - `parseFeishuCardActionEvent` 已存在的(无需新增)
  - `updateCard` 被 Gateway 进度回调调用
  - `splitTextIntoChunks` 边界(空、刚好 16KB、超 16KB)
  - `degradeCardForSize` 三档降级
  - 401 错误识别 + 重试策略

## 风险

- lark-cli 端是否需要 `card.action.trigger_v1` 应用配置:已在 USAGE 文档 §2.4 要求,本次不改 doc
- Gateway 内存: planMessageId 随 task 完成/失败后清理;活跃计划数受 `PENDING_QUEUE_MAX=3` 限制
- 卡片降级改变了视觉层次,用户已习惯旧版的"300 字符一刀切",需要在 changelog 注明
