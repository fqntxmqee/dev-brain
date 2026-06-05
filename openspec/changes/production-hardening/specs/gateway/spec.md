---
demand-id: DM-20260605-002
change: production-hardening
status: developing
---

# Gateway Spec (Delta)

继承 `dev-brain-mvp/specs/gateway/spec.md` 的 `CAP-GW-01/02/03`。本 change 新增**平台无关抽象**：

## CAP-GW-01 平台无关 Gateway 抽象

**Given** 当前 `gateway/feishu-*` 全部硬编码飞书前缀  
**When** 整改后  
**Then**：

```text
src/gateway/
├── common/
│   ├── message-gateway.ts      # interface MessageGateway
│   ├── message-card.ts         # interface MessageCard
│   ├── outbound-reporter.ts    # interface OutboundReporter
│   └── intent-dispatcher.ts    # 平台无关，pure function
├── feishu/
│   ├── index.ts                # FeishuGateway implements MessageGateway
│   ├── feishu-events.ts        # parseFeishuEventLine
│   ├── feishu-cards.ts         # 飞书 interactive card 序列化
│   ├── feishu-gateway.ts       # runFeishuEventLoop
│   └── feishu-reporter.ts      # LarkCliFeishuReporter + InMemoryFeishuReporter
└── index.ts                    # re-exports
```

**接口**：

```typescript
interface MessageGateway {
  start(signal: AbortSignal): Promise<void>;
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
}

interface OutboundReporter {
  sendText(chatId: string, text: string): Promise<void>;
  sendCard(chatId: string, card: MessageCard): Promise<void>;
}

interface InboundMessage {
  messageId: string;
  chatId: string;
  senderOpenId: string;
  senderName?: string;
  text: string;
  timestamp: number;
}
```

**约束**：
- `FeishuInboundMessage` 改名 `InboundMessage`，字段含义保持
- intent 解析、卡片 schema 收敛到 `common/`
- 接 Slack / 钉钉只需新增 `slack/`、`dingtalk/` 子目录，实现 `MessageGateway` + `OutboundReporter`

## 兼容性

- 现有 `BrainEngine.gateway` 接口保持 `gateway.handleMessage(msg)` / `gateway.runFeishuEventLoop()`，方法签名不变
- 内部实现切换到新 `MessageGateway` 抽象
- 测试 `tests/integration/gateway-flow.test.ts` / `card-approve-flow.test.ts` 不改

## CAP-GW-02 CLI plan 进度可见性

**Given** 当前 `pnpm cli -- plan` 走 `InMemoryFeishuReporter` 只 `print(sent.at(-1)?.text)` 两次，**进度卡片全程黑屏**  
**When** 整改后  
**Then**：
- CLI `plan` 订阅 `reporter.onProgress`，按子任务状态变化打印：
  - `⏳ st-1 (claude-code) executing…`
  - `✅ st-1 (claude-code) completed (12.3s)`
  - `❌ st-2 (codex) failed: <error code>`
  - `🔒 st-3 (cursor) blocked (file lock)`
- 进度换行带 ANSI 颜色（可选 `--no-color`）
- 末尾打印「🟢 任务完成 / 🟡 任务结束（部分失败）」汇总行
- 与飞书 useCards 走同一 `BrainEngine` 路径，确保两端行为一致

## CAP-GW-03 意图解析 mention 前缀 + 未知指令

**Given** `intent-parser.ts:18-36` 用 `lower === '/approve'` 精确匹配，**`@bot /approve`、`/ approve`、`/approve xxx` 全部 fallback `create_task`**  
**When** 整改后  
**Then**：
- 解析前先 `text.replace(/^@\S+\s+/, '').trim()` 去掉飞书 mention 前缀
- 用正则 `/^\/(approve|status|cancel|help|retry|show)(\s+.*)?$/` 替代精确匹配
- 未知指令（`/foo`、或裸文本含 `?` 标记疑问）回 `/help` 文案 + 提示「未知指令：/foo，回复 /help 查看支持指令」
- 完整覆盖：
  - `/approve` / `@bot /approve` / `/ approve` / `APPROVE` → `approve`
  - `/cancel <taskId?>` → `cancel`
  - `/status [taskId?]` → `status`
  - `/show <taskId> [--subtask <id>]` → `show`
  - `/retry <taskId>` → `retry`
  - `/help` / `help` → `help`
  - 空文本（trim 后）→ silent drop
  - 其他 → `create_task`

## CAP-GW-04 进度卡片 update 而非 send

**Given** 当前每次 progress 都 `sendCard`（`feishu-gateway.ts:60-62, 101-104`），飞书刷出 N 张相同模板卡片，**聊天记录被刷屏**  
**When** 整改后  
**Then**：
- `FeishuReporter` 抽象加 `updateCard(messageId, card)` 接口
- LarkCliFeishuReporter 调飞书 `update_card` 端点（用首发的 `messageId` + `card` callback token）
- 飞书同一 task 进度只对应 1 张卡片（首发后所有 progress 走 update）
- CLI / InMemory 路径按 `outbound.messageId` 映射

## CAP-GW-05 飞书文本 /approve 与卡片回调对称

**Given** 当前飞书文本 `/approve` 不传 `expectedTaskId`（`feishu-gateway.ts:101`），卡片回调传 `action.taskId`（第 63 行）；同一 chatId 两条入口行为隐式不对称  
**When** 整改后  
**Then**：
- 文本 `/approve <taskId>` 与卡片回调走相同 `approveAndExecute(taskId, sender)` 入口
- 文本 `/approve`（无 taskId）走 chatId 当前 pending plan
- 任务 ID 不匹配时返「⛔ 任务 ID 不匹配：`<期望>`，当前 chat 待审批：`<实际>`」
- README/help 文档明示两条入口语义

## CAP-GW-06 错误文案统一前缀

**Given** 当前错误出口共 5 类文案不一致：`❌ 任务失败：` / `⛔ 无权限` / `⛔ 文件锁冲突` / `gateway error:` / `probe failed:`
**When** 整改后  
**Then**（详见 errors CAP-ERR-03）：
- 全出口统一 `[{emoji}] [{code}] {message}` 格式
- 飞书卡片、CLI stderr、日志共用同一文案生成器 `formatError(err, audience: 'feishu'|'cli'|'log')`
- 同一 `DevBrainError` 子类在三处显示文案一致

## L5 锚点

- L5-HARDEN-05
- L5-NEW-10（@bot /approve 命中 approve intent）
- L5-NEW-11（进度卡片：1 任务 1 卡片，连续 update 3 次）
