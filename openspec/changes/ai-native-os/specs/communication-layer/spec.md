---
demand-id: DM-20260606-003
change: ai-native-os
status: developing
---

# Communication Layer Spec (Delta — v0.11.0)

本文描述 AI Native OS 重构对通信层的 5 项增强:结构化事件流、签名鉴权、多模态、阶段总结、多 Agent 身份。
基础卡渲染、文本分片、卡片降级已在 v0.9.0 (feishu-upgrade-v0.9.0) 实现,本 spec 仅扩展,不动既有契约。

> **v0.11.0 修订**: 经行业调研 (AG-UI Protocol / 飞书 CardKit v2.0 / OrchVis / Claude Code CCUI),
> 原始"无类型文本流 + updateCard"设计已替换为结构化事件 + 层级可见性 + 飞书流式卡片。
> 设计原理详见 `design.md`。

## CAP-COM-01 (REVISED) 结构化事件流式推送

> **v0.11.0 修订**: 从无类型文本流改为 5 种结构化事件,利用飞书 CardKit v2.0 流式卡片实现组件级更新。

**Given** 一次长任务处于 RUNNING 状态(辩论 / 子任务执行 / OpenSpec 生成)
**When** 引擎产生新的状态增量
**Then** CommunicationLayer 根据**事件类型**路由到飞书卡片的对应区域:

| 事件类型 | 飞书卡片区域 | 更新方式 |
|---------|------------|---------|
| `ProgressEvent` (阶段/进度) | HeaderZone | 文本替换, 1s 节流 |
| `ThinkingEvent` (LLM 思考增量) | ContentZone | 打字机效果 (CardKit v2.0 streaming_mode) |
| `ToolCallEvent` (工具调用) | CollapseZone/工具 | 追加, 500ms 合并, 默认折叠 |
| `DecisionEvent` (关键决策/分歧) | CollapseZone/决策 | 追加, 默认展开, 分歧时高亮 |
| `AgentEvent` (Agent 身份切换) | HeaderZone/身份标识 | 颜色+图标区分 |

**And** 飞书底层使用 CardKit v2.0 流式卡片 API:
  - `streaming_mode: true` + `print_strategy: "fast"` 实现打字机效果
  - 组件级独立更新, 非整卡 replace
  - 更新频率 ≤ 10 次/秒 (飞书卡片 API 上限)
  - 流式模式 10min 自动关闭, 任务超 8min 切换阶段性 summary 更新

**And** 推送失败/超时(>2s)时回退到"下次合并推送",不阻塞主流程
**And** 任务结束时关闭 `streaming_mode`,卡片变为静态完成卡

**And** 层级可见性策略 (来源: OrchVis, Georgia Tech 2025):
  - HeaderZone (阶段/进度/Agent 身份) — **常显,不可折叠**
  - ContentZone (当前输出) — **常显,打字机流式**
  - CollapseZone (工具调用/思考过程/关键决策) — **默认折叠,用户按需展开**
  - 原因: 用户首先关注结果, 仅在异常时检查过程细节

**Scenario: 结构化事件分区域渲染**
- GIVEN 辩论阶段, Claude 正在思考 + 同时调用了 `git diff`
- WHEN 引擎产出 ThinkingEvent("使用 adapter 模式...") + ToolCallEvent("git diff")
- THEN ContentZone 打字机渲染思考文本
- AND CollapseZone 追加工具调用条目 `git diff (🔄 running...)`
- AND HeaderZone 显示 `[辩论 R1/3] Claude (工程视角)`
- AND 用户看到的是信息分层, 而非一坨文本

**Scenario: 高频事件合并**
- GIVEN 1s 内产生 8 个 ToolCallEvent
- WHEN CardRenderer 处理
- THEN CollapseZone 只触发 2 次更新 (500ms 合并, 8 个合并为 2 批)
- AND 旧的事件不丢失, 合并后的内容包含全部 8 个工具调用条目

**Scenario: 流式卡片超时切换**
- GIVEN 任务执行超过 8min
- WHEN 飞书流式卡片剩余 < 2min
- THEN 自动关闭 streaming_mode, 切为阶段性 summary 更新
- AND 每 2min 推送一次进度快照 (ProgressEvent + 最新 DecisionEvent)
- AND 写 `gateway.card.streaming_timeout_total` +1

## CAP-COM-02 (NEW) 签名鉴权

**Given** 飞书回调任意 endpoint(消息 / 卡片按钮 / URL 验证)
**When** FeishuGateway 收到请求
**Then** SignatureVerifier 验证 HMAC-SHA256 签名(`X-Lark-Signature` header)
**And** 验签失败 → 立即返 401,不进入业务逻辑
**And** 验签通过 → 写 `gateway.signature.verified_total` +1
**And** secret 缺失(env `DEV_BRAIN_FEISHU_VERIFICATION_TOKEN` 空)→ daemon 启动 fail-fast

**实现要点:**
- `src/gateway/signature-verifier.ts` — 用 node:crypto,常时间比较防 timing attack
- secret 优先级:`DEV_BRAIN_FEISHU_VERIFICATION_TOKEN` > `~/.dev-brain/secret` > 启动失败
- 提供 test 钩子 `verifyWithSecret(secret, body, signature)`,不绑 HTTP 层,便于单测
- 现状: v0.9.0 已支持 URL 验证(`verification_token`),但对 card.action 等回调未做强制验签,本 spec 强制化

**Scenario: 合法飞书回调通过**
- GIVEN secret = "abc123",飞书发送 `{"event": "..."}` + signature = HMAC(secret, body)
- WHEN FeishuGateway 处理请求
- THEN 验签通过,进入 dispatch
- AND 验签耗时 < 1ms

**Scenario: 伪造请求被拒**
- GIVEN secret = "abc123",攻击者发送 body 任意 + signature = "fake"
- WHEN FeishuGateway 处理
- THEN 返 401,`gateway.signature.rejected_total` +1,无业务副作用

**Scenario: secret 缺失启动失败**
- GIVEN env `DEV_BRAIN_FEISHU_VERIFICATION_TOKEN` 未设,`~/.dev-brain/secret` 不存在
- WHEN daemon 启动
- THEN 立即抛 `MissingVerificationSecretError`,exit 2,不监听端口

## CAP-COM-03 (NEW) 多模态输入

**Given** 用户发送含图片 / 文件附件 / PR 链接的消息
**When** FeishuGateway 收到 multimodal 消息
**Then** MultimodalParser 抽取:
  - 图片(message_content 里的 `image_key`)→ 调 MiniMax vision OCR,得文本描述 + 置信度
  - 文件(file 类型)→ 下载到 `~/.dev-brain/attachments/<msgId>/<fileName>`,返回本地路径
  - 文本中的 PR/issue 链接 → 调 GitHub API (or `gh pr view` 子进程) 抽 title + status + diff stat
**And** 解析结果并入 `IntentContext.attachments: { type, payload, confidence }[]`
**And** OCR 置信度 < 0.7 时,把原图保留在 Intent.attachments,但 Intent.ocr_low_confidence = true
**And** 整链路 trace_id 贯穿,可从 audit 还原"这张图被谁解析成什么"

**实现要点:**
- `src/gateway/multimodal-parser.ts` — 3 个子 parser,可独立调用
- MiniMax vision 走 cc-connect/native 通道,复用 v0.8.0 native backend
- GitHub 链接解析走 `gh` CLI 子进程(已装),无需新 dep
- 附件落盘:不直接放 workDir,放 `~/.dev-brain/attachments/`,避免污染 repo
- 与 inject-rules 联动:文件路径/OCR 文本也注入 system prompt,让 agent 能 reference

**Scenario: 用户贴截图报 bug**
- GIVEN 飞书消息: "[图片] 这里报错了" + image_key=img_v2_xxx
- WHEN MultimodalParser 处理
- THEN 调 MiniMax vision OCR,得 "TypeError: cannot read property 'foo' of undefined at trade.ts:42"
- AND 附件元数据并入 Intent.attachments
- AND 后续 debate 阶段可看到 OCR 文本作为 context

**Scenario: 用户贴 GitHub PR 链接**
- GIVEN 飞书消息: "看下这个 PR #123 https://github.com/foo/bar/pull/123"
- WHEN MultimodalParser 处理
- THEN 调 `gh pr view 123 --json title,state,additions,deletions,files`
- AND attachments 增加 `{type: "pr", ref: "foo/bar#123", title, state, diffStat}`
- AND Intent.type 升级为 "review" (heuristic: 含 pr 链接 + "看下" 关键字)

**Scenario: OCR 置信度低**
- GIVEN 图片模糊,vision 返回 confidence=0.4
- WHEN MultimodalParser 处理
- THEN OCR 文本仍写入,但附加 `ocr_low_confidence: true` 标记
- AND InjectRules 注入时附带警告"以下 OCR 文本可能不准确"

## CAP-COM-04 (REVISED) 阶段总结 + 任务完成卡

> **v0.11.0 修订**: 原始 spec 仅在任务结束时发一张完成卡。对于 3-10min 复杂任务,用户需要中间看到阶段性结论。

**Given** 任务执行到关键阶段节点
**When** BrainEngine 发出阶段变更事件
**Then** 流式卡片上触发阶段性 Summary 更新:

| 阶段 | 触发时机 | Summary 内容 |
|------|---------|-------------|
| 意图分析完成 | IntentEngine 输出 | 理解摘要 (≤50 字) + 分类 + 关键参数 |
| 辩论完成 | debate_end 节点 | 共识点 + 分歧点 + 决策 (≤100 字/项) |
| OpenSpec 生成 | openspec 写入后 | spec 摘要 + tasks 数量 + 预估时间 |
| 子任务过半 | 50% 子任务完成 | 进度 (X/5) + 关键产出 + 已发现问题 |
| 任务完成 | task.complete | 完整 TaskDoneCard (与原始 spec 一致) |

**And** 阶段性 Summary 是**同一张流式卡片上的区域更新**,不是新卡片
**And** 任务完成时关闭 streaming_mode → 卡片从流式变为静态完成卡

**And** 任务完成卡保留原始字段 (summary/changes/tests/artifacts/trace_id):
  - **summary**: 1-2 句结论(success/fail + 关键产出)
  - **changes**: 变更文件列表(最多 10 个,超 10 给"see git log"链接)
  - **tests**: 通过/失败计数 + 关键失败 message(最多 3 条)
  - **artifacts**: OpenSpec 路径 / checkpoint 路径 / 长输出文档链接
  - **trace_id**: 卡片 header 携带,可一键跳到 observability
**And** 卡片使用**原地 update** 而非 send
**And** 失败时 summary 必须含**可读错误摘要**,不只 `❌ failed`

**Scenario: 阶段 Summary 累积呈现**
- GIVEN task "重构 trade 模块" 正在进行
- WHEN 意图分析完成 → 辩论完成 → OpenSpec 生成
- THEN 每阶段完成后卡片上出现一个新的折叠区域:
  - `[意图] 理解: trade 模块日期筛选功能重构`
  - `[辩论] 共识: adapter 模式; 分歧: 是否保留旧接口`
  - `[OpenSpec] 生成 5 个子任务, 预估 3min`
- AND 每个阶段区域默认折叠,用户可展开查看详情
- AND 所有区域在同一张卡片上,不刷屏

**Scenario: 任务完成卡原地转换**
- GIVEN 同一张流式卡片经历了意图→辩论→OpenSpec→执行→完成
- WHEN task.complete 触发
- THEN `streaming_mode` 关闭
- AND 卡片 header 从 `[执行中] 子任务 3/5` 变为 `✅ 完成`
- AND 所有折叠区域保留 (用户可回顾),新增完成卡区域

## CAP-COM-05 (NEW) 多 Agent 身份流

> **v0.11.0 新增**: 原始 spec 将所有 Agent 输出混在一起推送。dev-brain 的多 Agent 架构 (Claude 工程/Codex 博弈论/DeepSeek 诊断/并行子 Agent) 要求用户能区分"谁在说话、说到哪了"。

**Given** 任务涉及多个 Agent 协作 (辩论/执行/Review)
**When** Agent 身份切换 (进入/退出)
**Then** AgentEvent 标记身份变更,卡片渲染区分:

| Agent | 角色 | 图标 | 颜色 |
|-------|------|------|------|
| Claude (主 Agent) | 工程执行 | 🛠️ | 蓝色 |
| Codex | 博弈论审查 | 🎯 | 紫色 |
| DeepSeek | 诊断/压缩/萃取 | 🧠 | 绿色 |
| 子 Agent (parallel) | 并行子任务 | 📋 | 灰色 |

**And** 每个 Agent 的思考块在卡片上独立渲染:
  - AgentEvent `action=enter` → HeaderZone 更新身份标签 + 颜色
  - ThinkingEvent 自动继承当前 Agent 身份
  - AgentEvent `action=exit` → HeaderZone 恢复默认

**And** 不同 Agent 的矛盾观点通过 DecisionEvent 汇总:
  - `consensus: true` → 正常展示
  - `consensus: false` → 高亮展示 + 标注"⚠️ 分歧"

**Scenario: 辩论阶段 Agent 切换**
- GIVEN 辩论阶段, Claude 先发言, Codex 后发言
- WHEN Claude enter → Claude 思考 → Claude exit → Codex enter → Codex 思考
- THEN 用户看到:
  - `[辩论 R1/3] 🛠️ Claude (工程视角) 思考中...`
  - Claude 的 thinking 内容流入
  - `[辩论 R1/3] 🎯 Codex (博弈论视角) 审查中...`
  - Codex 的 thinking 内容流入
- AND 两个 Agent 的思考历史在 CollapseZone 中可分别展开

**Scenario: 分歧高亮**
- GIVEN Claude 提出"用 adapter 模式", Codex 反驳"需要增加 rollback 机制"
- WHEN DecisionEvent 产出: consensus=false
- THEN 卡片 DecisionZone 出现高亮条目:
  - `⚠️ 分歧: adapter 模式是否足够?`
  - `Claude: 旧接口稳定, adapter 足够`
  - `Codex: 缺少 rollback, 建议增加 sandbox 回滚`

**实现要点:**
- `src/gateway/agent-identity.ts` — Agent 注册表 (id → name/role/color)
- AgentEvent 由 BrainEngine 在 Agent 切换时自动发出
- 博弈论安全: Agent 不能自己发送 AgentEvent (防止伪装身份)

---

## 实现要点

**新增文件:**
- `src/gateway/streaming-pusher.ts` — 重构: 接收 `CommunicationEvent` 替代 `string`
- `src/gateway/card-renderer.ts` — 事件 → 飞书卡片区域映射 + 层级可见性控制
- `src/gateway/event-bus.ts` — CommunicationEvent 事件总线 (生产者/消费者解耦)
- `src/gateway/agent-identity.ts` — Agent 注册表 (CAP-COM-05)
- `src/gateway/signature-verifier.ts` — 签名鉴权 (CAP-COM-02, 基本不变)
- `src/gateway/multimodal-parser.ts` — 多模态解析 (CAP-COM-03, 基本不变)

**修改文件:**
- `src/gateway/feishu-gateway.ts` — 接入 CardKit v2.0 流式卡片 API
- `src/gateway/task-done-card.ts` — 增加阶段 Summary 生成 (CAP-COM-04)

**删除文件:**
- 无删除 (原始 CAP-COM-01..04 的代码重构但保留核心逻辑)

## Metric

```
# 事件流
gateway.event.total{type}              — 各事件类型计数 (counter)
gateway.event.dropped_total{reason}    — 被丢弃事件 (节流/超预算)
gateway.event.latency_ms               — 事件产生到推送延迟 (histogram)

# 卡片渲染
gateway.card.update_total{zone}        — 各区域更新计数 (counter)
gateway.card.streaming_timeout_total   — 流式卡片超时切换 (counter)

# Agent 身份
gateway.agent.switch_total{from,to}    — Agent 身份切换计数 (counter)

# 流控
gateway.streaming.throttle_total       — 节流合并次数 (counter)
gateway.streaming.push_failed_total    — 推送失败次数 (counter)
```

## 验证

- `pnpm typecheck && pnpm test` 全绿
- 事件路由单测: 5 种事件类型 → 对应卡片区域,验证路由正确
- 节流单测: 高频事件合并,验证不超过 10 次/秒上限
- 流式卡片超时单测: mock 超时 → 验证阶段性 summary 切换
- Agent 身份单测: Agent 切换 → 验证 HeaderZone 更新
- CAP-COM-02/03 单测保持原有,无破坏性变更
