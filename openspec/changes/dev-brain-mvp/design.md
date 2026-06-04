---
demand-id: DM-20260601-001
title: Dev Brain 架构设计
created: 2026-06-01
---

# Dev Brain 架构设计

## 1. 总体架构

```text
飞书用户
   ↓
Feishu Gateway (lark-cli event)
   ↓
Brain Engine (Lead)
   ├── Task Planner
   ├── Approval Gate
   └── Agent Router
   ↓
TaskOrchestrator（dev-brain 内置）
   ↓
Agent Adapters
   ├── ClaudeCodeAdapter → cc-connect (workspace-claude)
   ├── CodexAdapter      → cc-connect (workspace-codex)
   └── CursorAdapter     → @cursor/sdk local
```

## 2. 模块职责

### 2.1 Feishu Gateway (`src/gateway/`)

- 启动 `lark-cli event +subscribe` 子进程，消费 NDJSON 事件
- 过滤 `im.message.receive_v1`，提取 sender / chat_id / content
- 调用 `IntentParser` 解析指令类型
- 通过 `FeishuReporter` 发送文本/卡片回复

### 2.2 Brain Engine (`src/brain/`)

- 维护 `PendingTask` 内存表（chatId → 待审批计划）
- `planTask(description)` → 生成子任务 + adapter 分配
- `approveTask(chatId)` → 提交 Orchestrator，调度 Adapters
- `getStatus()` → 汇总任务与 Agent 占用

### 2.3 Agent Adapters (`src/adapters/`)

统一接口：

```typescript
interface AgentAdapter {
  readonly runtime: AgentRuntime;
  send(request: AdapterRequest): AsyncIterable<AdapterEvent>;
  cancel(sessionKey: string): Promise<void>;
  status(sessionKey: string): Promise<AdapterSessionStatus>;
}
```

| Runtime | 后端 | cc-connect project |
|---------|------|-------------------|
| claude-code | cc-connect | workspace-claude |
| codex | cc-connect | workspace-codex |
| cursor | @cursor/sdk | — |

### 2.4 路由策略

| 子任务特征 | 优先 Runtime |
|-----------|-------------|
| 探索 / 架构 / 审查 | claude-code |
| 多文件并行编码 | codex |
| 调试 / IDE 联调 | cursor |

Phase 1 使用规则路由；Phase 3 可引入模型分类。

## 3. 飞书交互协议

| 用户输入 | 动作 |
|---------|------|
| 自然语言（非 `/` 开头） | 创建任务计划 → 返回计划摘要 + `/approve` 提示 |
| `/approve` | 执行当前 chat 的待审批任务 |
| `/status` | 返回任务与 Agent 状态 |
| `/cancel` | 取消待审批或执行中任务 |
| `/help` | 指令说明 |

## 4. 配置

环境变量（见 `.env.example`）：

- `DEV_BRAIN_FEISHU_APP_ID` / `DEV_BRAIN_FEISHU_APP_SECRET`
- `DEV_BRAIN_WORK_DIR` — 默认 `/Users/fukai/workspace`
- `DEV_BRAIN_CC_CONNECT_SOCKET` — 默认 `~/.cc-connect/run/api.sock`
- `DEV_BRAIN_ALLOW_FROM` — 逗号分隔 open_id 白名单

## 5. 分阶段交付

| Phase | 内容 | 退出条件 |
|-------|------|---------|
| 1 | Gateway + Brain 闭环（stub adapter） | L5-BRAIN-01/02/05 |
| 2 | 真实 cc-connect + Cursor SDK | L5-BRAIN-03 |
| 3 | 智能路由 + 并行 Worker | L5-BRAIN-04 |
| 4 | 卡片按钮审批 + cc-connect headless 改造 | 生产可用 |

## 6. cc-connect 演进

当前三 Bot 平行架构 → 目标：

1. 新增 Brain Bot（dev-brain 专用飞书应用）
2. workspace-claude/codex/cursor 去掉 platforms，仅保留 agent + api.sock
3. 设置 allow_from / admin_from

参考配置：`config/cc-connect.headless.example.toml`
