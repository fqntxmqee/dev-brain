# dev-brain

**飞书指挥的多 Agent 开发大脑** — 通过单一 Brain Bot 编排本地 Claude Code、Codex、Cursor。

需求 `DM-20260601-001`，设计见 `openspec/changes/dev-brain-mvp/design.md`。

## 架构

```text
飞书 Brain Bot
     ↓
Feishu Gateway (lark-cli event)
     ↓
Brain Engine (Lead)
     ↓
TaskOrchestrator（dev-brain 内置）
     ↓
Agent Adapters → cc-connect / @cursor/sdk
```

| 模块 | 说明 |
|------|------|
| **gateway/** | 飞书消息订阅、意图解析、回复 |
| **brain/** | 任务规划、审批门控、执行编排 |
| **orchestrator/** | 内置轻量任务状态机 |
| **adapters/** | Claude Code / Codex / Cursor 统一接口 |

## 要求

- Node.js ≥ 20
- pnpm ≥ 9
- 已安装 [cc-connect](https://github.com/chenhg5/cc-connect) 与 lark-cli

## 安装

```bash
cd dev-brain
pnpm install
pnpm build
```

## 快速体验（无需飞书、无需 cc-connect）

默认 `DEV_BRAIN_ADAPTER_MODE=stub`，离线可跑：

```bash
pnpm cli -- plan "给 trade 模块加日期筛选"
```

流程：生成计划 → 自动 `/approve` → 经 stub adapter 执行 → 输出汇总。

## Live 模式（cc-connect / Cursor）

```bash
# 1. 确保 cc-connect daemon 在跑
# 2. 配置 .env
DEV_BRAIN_ADAPTER_MODE=live
DEV_BRAIN_CC_SYNC=send    # 或 relay（同步文本，需 relay 绑定）
CURSOR_API_KEY=...        # 可选；无则 cursor 走 cc-connect

pnpm cli -- doctor
pnpm cli -- probe -p workspace-claude "hello from dev-brain"
pnpm cli -- plan "探索 auth 模块"
```

cc-connect API：`POST /send`（HTTP over `api.sock`），详见 `src/adapters/cc-connect-http.ts`。

## Phase 3：并行调度与文件锁

默认子任务 DAG：

```text
st-1 探索 (claude-code)
   ├── st-2 后端实现 (codex)   ─┐ 同层并行
   └── st-3 前端联调 (cursor)  ─┘
```

同层子任务通过 `FileLockManager` 协调 `requiredFiles` 写锁；冲突时子任务标记为 `blocked` 并跳过。

## 飞书交互卡片

设置 `DEV_BRAIN_FEISHU_CARDS=1`（默认启用）后，Gateway 会发送：

- 任务计划卡片（创建需求时）
- 执行进度卡片（每个子任务状态变更）
- 汇总卡片（执行完成）

仍支持文本 `/approve`；卡片按钮见 Phase 4 节。

## Phase 4：卡片审批 + Bridge 异步回复

### 卡片按钮审批

计划卡片含「批准执行 / 取消」按钮（`DEV_BRAIN_FEISHU_CARD_ACTIONS=1`）。需在飞书应用订阅 `card.action.trigger` 事件。

### cc-connect Bridge

`live` + `send` 模式下，`DEV_BRAIN_CC_BRIDGE=1` 会在 `/send` 后通过 Bridge 收集 agent 回复：

1. 优先 WebSocket（`bridge.sock`）
2. 回退 HTTP 轮询（`GET /bridge/reply?project=&session_key=`）

stub 模式返回 `[bridge stub/...]` 模拟回复。

### headless 生产切换

```bash
pnpm cli -- migrate-headless --check
pnpm cli -- migrate-headless --apply          # 备份 + 原地应用
pnpm cli -- migrate-headless --apply --dry-run
```

生成到新文件（不覆盖原配置）：

```bash
pnpm cli -- migrate-headless -o ~/.cc-connect/config.headless.toml
```

## 连接飞书

1. 复制 `.env.example` 为 `.env`，填入 Brain 专用飞书应用凭证
2. 设置 `DEV_BRAIN_ALLOW_FROM` 限制可指挥用户
3. 启动：

```bash
pnpm cli -- start
# 或 dry-run 检查配置
pnpm cli -- start --dry-run
```

## cc-connect 演进

当前你本地 cc-connect 是三 Bot 平行架构。目标架构见 `config/cc-connect.headless.example.toml`：Worker 项目去掉 platforms，仅保留 agent + api.sock，由 dev-brain 统一调度。

## 脚本

| 命令 | 说明 |
|------|------|
| `pnpm cli -- plan "<描述>"` | 本地模拟完整闭环 |
| `pnpm cli -- start` | 启动飞书 Gateway |
| `pnpm cli -- status` | Brain 状态 |
| `pnpm cli -- doctor` | 环境自检 |
| `pnpm cli -- probe -p <project> "<msg>"` | cc-connect 探测 |
| `pnpm cli -- migrate-headless --check` | 检查 cc-connect 是否为 headless |
| `pnpm cli -- migrate-headless -o <path>` | 生成 headless 配置到新文件 |
| `pnpm cli -- migrate-headless --apply` | 备份并原地应用 headless 配置 |
| `pnpm test` | 单元测试 |
| `pnpm build` | 编译 |

## OpenSpec

见 `openspec/changes/dev-brain-mvp/`。

## Phase 路线图

| Phase | 内容 |
|-------|------|
| **1** ✅ | Gateway + Brain 闭环（stub adapter，已验收） |
| **2** ✅ | cc-connect HTTP/UDS + Cursor SDK + doctor/probe |
| **3** ✅ | 文件锁 + 飞书进度卡片 + migrate-headless |
| **4** ✅ | 卡片按钮审批 + Bridge 异步回复 + headless --apply |

## 许可证

MIT
