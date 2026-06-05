# dev-brain

**飞书指挥的多 Agent 开发大脑** — 通过单一 Brain Bot 编排本地 Claude Code / Codex / Cursor。

> 📖 详细文档见 [`docs/USAGE.md`](docs/USAGE.md) — 含飞书 app 创建、launchd 自启、metrics/排错。
> 🩺 Oncall 处理见 [`ops/RUNBOOK.md`](ops/RUNBOOK.md)。

需求 `DM-20260601-001`，设计见 `openspec/changes/dev-brain-mvp/design.md`。

## 架构

```text
飞书 Brain Bot (cli_xxx)
     ↓ lark-cli event +subscribe (WebSocket)
Feishu Gateway
     ↓
Brain Engine (Lead) + TaskOrchestrator
     ↓
Agent Adapters
     ├─ native  (v0.8.0+):  spawn("claude") / spawn("codex-minimax")
     └─ cc-connect (兼容):  POST /send over api.sock
```

| 模块 | 说明 |
|------|------|
| **gateway/** | 飞书消息订阅、意图解析、回复 (lark-cli im +messages-send) |
| **brain/** | 任务规划、审批门控、执行编排 |
| **orchestrator/** | 内置轻量 DAG 调度 + 文件锁 |
| **adapters/** | Claude Code / Codex / Cursor 统一接口 |

## 一键运行

```bash
git clone <repo> dev-brain
cd dev-brain
./scripts/install.sh --all
```

`--all` 顺序做:

1. 环境检查 (`node`/`pnpm`/`lark-cli`/`claude`/`codex-minimax`/`$MINIMAX_API_KEY`)
2. `pnpm install`
3. 从 `.env.example` 复制 `.env` 并引导输入飞书 App ID / App Secret
4. 注册 lark-cli profile `dev-brain`
5. 跑 `pnpm cli -- doctor`
6. 启动 daemon (前台,Ctrl+C 退出)

子命令:`--check` 只跑 doctor / `--start` 只启动 / 无参只引导。

详细步骤、配置项、命令清单、排错见 [`docs/USAGE.md`](docs/USAGE.md)。

## 要求

- Node.js ≥ 20
- pnpm ≥ 9
- `lark-cli`(飞书官方 CLI,长连接事件订阅)
- `claude` / `codex-minimax`(live 模式;stub 模式不需要)
- `$MINIMAX_API_KEY`(live 模式;从 launchd plist 透传或 shell export)

cc-connect **v0.8.0+ 不再是派发路径上的依赖**,仅作 cursor fallback 可选。

## 快速体验 stub 模式(无需飞书 / 无需 agent CLI)

```bash
pnpm install
cp .env.example .env
pnpm cli -- plan "给 trade 模块加日期筛选"
```

流程:生成计划 → 自动 `/approve` → stub adapter 输出占位 → 5 秒端到端跑通。

## Live 模式 (v0.8.0 native spawn)

```bash
DEV_BRAIN_ADAPTER_MODE=live
DEV_BRAIN_AGENT_BACKEND=native     # 默认；直接 spawn 本地 claude / codex-minimax
# $MINIMAX_API_KEY 已在 launchd plist 透传

pnpm cli -- doctor
pnpm cli -- probe -p workspace-claude "hello"   # 走 cc-connect 探测 (cursor fallback 路径)
pnpm cli -- plan "探索 auth 模块"               # 本地端到端
pnpm cli -- start                                # 启动飞书 Gateway
```

**v0.7.0 兼容**: `DEV_BRAIN_AGENT_BACKEND=cc-connect` 走 UDS 老路径。

## 飞书命令清单

私聊 Brain Bot:

| 命令 | 说明 |
|------|------|
| `/help` | 命令清单 |
| `/status` | Brain pending/active 计数 |
| `/list` | 最近已完成任务 |
| `/show <taskId>` | 任务 postmortem |
| `/cancel` | 取消待审批任务 |
| 直接发需求 | 创建计划 (返回计划卡片) |
| 点"批准执行" | 触发 3 个子任务派发 |

## 脚本

| 命令 | 说明 |
|------|------|
| `./scripts/install.sh` | 引导 .env + lark-cli profile |
| `./scripts/install.sh --all` | install + doctor + start 一条龙 |
| `./scripts/install.sh --check` | 只跑 doctor |
| `./scripts/install.sh --start` | 启动 daemon |
| `./scripts/start-daemon.sh` | 后台启动封装 (无引导) |
| `pnpm cli -- <subcmd>` | CLI 子命令 (见 USAGE §8) |
| `pnpm test` / `pnpm build` | 测试 / 编译 |

## Phase 路线图

| Phase | 内容 |
|-------|------|
| **1** ✅ | Gateway + Brain 闭环 (stub adapter) |
| **2** ✅ | cc-connect HTTP/UDS + Cursor SDK + doctor/probe |
| **3** ✅ | 文件锁 + 飞书进度卡片 + migrate-headless |
| **4** ✅ | 卡片按钮审批 + Bridge 异步回复 + headless --apply |
| **v0.8.0** ✅ | Native claude + codex (`agentBackend=native`,直接 spawn `claude` / `codex-minimax`) |
| **v0.8.1** ✅ | Native cursor (`spawn cursor-agent -p ...`),cc-connect 不再是 cursor 派发路径 |

## OpenSpec

见 `openspec/changes/dev-brain-mvp/` + `openspec/archive/`。

## 许可证

MIT
