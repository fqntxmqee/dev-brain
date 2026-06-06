# Dev Brain 使用手册 (v0.8.0 / v0.10.0)

> 飞书指挥的多 Agent 开发大脑 — 通过单一 Brain Bot 编排本地 Claude Code / Codex / Cursor。

## 1. 5 分钟上手

```bash
git clone <repo> dev-brain
cd dev-brain
./scripts/install.sh --all     # 一键: 环境检查 + 装依赖 + 配 .env + 注册 lark-cli + doctor + 启动
```

`--all` 会按顺序做:

1. 检查 `node`/`pnpm`/`lark-cli`/`claude`/`codex-minimax`/`$MINIMAX_API_KEY`
2. `pnpm install`
3. 从 `.env.example` 复制 `.env` 并引导输入飞书 App ID / App Secret
4. 注册 lark-cli profile `dev-brain`
5. 跑 `pnpm cli -- doctor`
6. 启动 daemon (前台,Ctrl+C 退出)

启动后从飞书对话 dev-brain Bot 即可指挥。

### 只想跑 stub 模式(无需飞书 / 无需 agent CLI)

```bash
pnpm install
cp .env.example .env
pnpm cli -- plan "给 trade 模块加日期筛选"
```

stub 模式下 Brain 生成计划 → 立即 `/approve` → 走 stub adapter 返回占位输出,端到端跑通 5 秒。

## 2. 飞书应用准备

dev-brain 走的是 **企业自建应用 + 长连接 WebSocket**,和 cc-connect 是独立的两个 Bot。

### 2.1 创建应用

1. 打开 [飞书开放平台](https://open.feishu.cn/app) → 创建企业自建应用
2. 记下 **App ID** 和 **App Secret**(会出现在"凭证与基础信息"页)

### 2.2 启用机器人能力

应用页 → "机器人" → 启用。

### 2.3 权限配置

应用页 → "权限管理" → 开通:

| 权限 | 范围 | 用途 |
|------|------|------|
| `im:message` | `im:message:send_as_bot` | 发送消息(回复) |
| `im:message.group_at_msg` | 免 | 不需要,可不开 |
| `im:message.p2p_msg` | `im:message:receive_as_bot` | 接收私聊消息 |
| `im:message:readonly` | 收消息(主动拉取) | 可选 |

> 权限审批在企业自建应用上**通常无需审批立即生效**;但如果是在企业审批流程下,需先走完审批。

### 2.4 事件订阅(关键)

应用页 → "事件订阅" → 选 **"使用长连接接收事件"**(WebSocket,无需公网回调地址)。

事件列表里勾选:

- `im.message.receive_v1` — 接收用户消息(必需)
- `card.action.trigger_v1` — 卡片按钮回调(v0.8.0 推荐,审批流程用)

保存后状态显示"已启用长连接"。

### 2.5 拿到自己的 open_id

飞书 → 我的 → 头像 → 个人信息 → **open_id**(以 `ou_` 开头)。

或 CLI(需先 `lark-cli login`):

```bash
lark-cli contact +get-user --as user
```

把 open_id 填到 `.env` 的 `DEV_BRAIN_ALLOW_FROM`(逗号分隔可填多个;调试期填 `*` 任何人可指挥)。

## 3. 一键脚本

`scripts/install.sh` 支持 4 个子命令:

| 命令 | 做什么 |
|------|--------|
| `./scripts/install.sh` (无参) | 引导 .env + 注册 lark-cli profile,不启动 |
| `./scripts/install.sh --check` | 只跑 `pnpm cli -- doctor` |
| `./scripts/install.sh --start` | 启动 daemon(前台) |
| `./scripts/install.sh --all` | install + check + start 一条龙 |

脚本是 **reentrant** — 再次运行只做缺的那步;`.env` 已存在就跳过,profile 已注册就跳过。

## 4. 配置项速查

### 4.1 必填

| Env 变量 | 说明 |
|----------|------|
| `DEV_BRAIN_FEISHU_APP_ID` | 飞书 App ID (`cli_xxx`) |
| `DEV_BRAIN_FEISHU_APP_SECRET` | 飞书 App Secret |
| `DEV_BRAIN_ALLOW_FROM` | 允许指挥的 open_id;`*` 表示任何人 |
| `DEV_BRAIN_WORK_DIR` | Agent 工作目录,默认 `/Users/fukai/workspace` |

### 4.2 模式选择

| Env 变量 | 默认 | 备选 |
|----------|------|------|
| `DEV_BRAIN_ADAPTER_MODE` | `stub`(离线) | `live`(派发真 CLI) |
| `DEV_BRAIN_AGENT_BACKEND` | `native`(v0.8.0+) | `cc-connect`(v0.7.0 兼容) |

### 4.3 Native backend (v0.8.0+)

默认值已经对齐 MiniMax,通常不用改:

```bash
DEV_BRAIN_CLAUDE_BIN=claude
DEV_BRAIN_CLAUDE_MODEL=MiniMax-M3-highspeed
DEV_BRAIN_CLAUDE_BASE_URL=https://api.minimaxi.com/anthropic
DEV_BRAIN_CLAUDE_PERMISSION_MODE=bypassPermissions

DEV_BRAIN_CODEX_BIN=codex-minimax
DEV_BRAIN_CODEX_MODEL=MiniMax-M2.7-highspeed
DEV_BRAIN_CODEX_PROFILE=m27

# v0.8.1: cursor-agent CLI（Cursor 编辑器自带；`agent` 是兼容别名）
DEV_BRAIN_CURSOR_BIN=cursor-agent
DEV_BRAIN_CURSOR_MODEL=composer-2.5
# 模式: 空 = 含写权限；plan = 只读探索（探索子任务推荐）；ask = 只读 Q&A
DEV_BRAIN_CURSOR_MODE=plan

DEV_BRAIN_NATIVE_TIMEOUT_MS=300000
```

`$MINIMAX_API_KEY` 从 launchd plist 透传(或 shell export),**不要写到 .env**。

`CURSOR_API_KEY` 留空就用本地 cursor-agent 缓存的登录态;填了走独立 quota(可避开 Auto 模式 quota 限制)。

### 4.4 cc-connect 兼容 (仅当 `AGENT_BACKEND=cc-connect`)

```bash
DEV_BRAIN_CC_CONNECT_SOCKET=/Users/fukai/.cc-connect/run/api.sock
DEV_BRAIN_CC_PROJECT_CLAUDE=workspace-claude
DEV_BRAIN_CC_PROJECT_CODEX=workspace-codex
DEV_BRAIN_CC_PROJECT_CURSOR=workspace-cursor
```

### 4.5 飞书卡片

```bash
DEV_BRAIN_FEISHU_CARDS=1              # 计划/进度/汇总卡片
DEV_BRAIN_FEISHU_CARD_ACTIONS=1        # 卡片审批按钮
```

## 5. 飞书命令清单

在 dev-brain 私聊中:

| 命令 | 说明 |
|------|------|
| `/help` | 命令清单 |
| `/status` | Brain 当前状态(pending/active 计数) |
| `/cancel` | 取消待审批任务 |
| `/list` | 最近 10 条已完成任务 |
| `/show <taskId>` | 任务 postmortem 详情 |
| `/retry <taskId>` | 重试失败任务 |
| 直接发需求 | 创建计划(返回计划卡片) |
| 点"批准执行"按钮 | 触发 `/approve` 流程(执行 3 个子任务) |
| 点"取消"按钮 | 触发 `/cancel` 流程 |

### 端到端示例

1. 私聊 dev-brain Bot → "在 user 模块加个找回密码的接口,Redis 存 token"
2. 几秒后 Bot 返回计划卡片,3 个子任务: 探索(Claude) / 后端实现(Codex) / 前端联调(Cursor)
3. 点"批准执行"
4. Bot 实时发进度卡片(子任务状态变更)
5. 完成后 Bot 发汇总卡片 + 文本摘要

## 6. 后台/开机自启

`scripts/start-daemon.sh` 是简单的后台启动封装(读 `.env` + `pnpm dev -- start`)。

后台运行:

```bash
nohup ./scripts/start-daemon.sh > /tmp/dev-brain.log 2>&1 &
```

开机自启(macOS launchd 示例,放在 `~/Library/LaunchAgents/com.devbrain.daemon.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.devbrain.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/fukai/workspace/dev-brain/scripts/start-daemon.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MINIMAX_API_KEY</key><string>sk-xxx</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/dev-brain.log</string>
  <key>StandardErrorPath</key><string>/tmp/dev-brain.err.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.devbrain.daemon.plist
```

## 7. 监控 / 排错

### 7.1 日志

JSON 日志走 stderr;`request_id` / `chat_id` 可关联。

```bash
# 实时跟踪
tail -f /tmp/dev-brain.log | jq

# 按 chat_id 过滤
tail -f /tmp/dev-brain.log | jq 'select(.chat_id == "oc_xxx")'
```

### 7.2 Metrics

`http://0.0.0.0:9090/metrics`(可改 `DEV_BRAIN_METRICS_PORT`):

```bash
curl -s http://localhost:9090/metrics | head -30
```

关键 series:
- `brain.tasks.completed` / `brain.tasks.failed`
- `gateway.messages.received` / `gateway.messages.rejected_oversize`
- `adapter.sent` / `adapter.failed` / `adapter.cancelled`
- `gateway_message_duration_seconds` (histogram)

### 7.3 常见错误

#### "⛔ 无权限使用 Dev Brain。"

`DEV_BRAIN_ALLOW_FROM` 没包含你的 open_id。从飞书查自己的 open_id,加到 .env:

```bash
DEV_BRAIN_ALLOW_FROM=ou_xxx,ou_yyy   # 多个
DEV_BRAIN_ALLOW_FROM=*                # 调试期: 任何人
```

#### "lark-cli exited with code 1: ..."

通常是飞书应用缺权限。从 daemon 日志看 stderr 详情,然后:
- 检查应用权限管理页是否开了 `im:message:send_as_bot`
- 检查事件订阅页是否勾了 `im.message.receive_v1`
- 私聊 Bot 一下看是否可达

#### "另一个 event +subscribe 已在运行"

之前的 daemon 还在跑,或之前没干净退出:

```bash
pgrep -f "tsx.*cli.ts" | xargs kill -9
pgrep -f "lark-cli event" | xargs kill -9
```

#### doctor 报 `cc_connect_headless` 失败

正常 — 你本地 cc-connect 跑的是三 Bot 架构,不在 headless 状态。
- 用 native backend 时 **不会阻塞启动**(`--start` 跳过该检查)
- 想完全消除警告:`pnpm cli -- migrate-headless --check` 看详情

#### 日志看到 `gateway: unparsed line`

lark-cli 输出格式变了,parser 没匹配上。完整事件会被打印,可能需要更新 `src/gateway/feishu-events.ts` 的 schema。

#### 卡片点"批准执行"无反应

v0.9.0 升级后,审批按钮走 `card.action.trigger` 事件。检查:

1. 飞书应用 → 事件订阅 → 勾选 `card.action.trigger_v1`(v0.8 文档已要求,确认实际勾上)
2. 飞书应用 → 权限管理 → `im:message:send_as_bot` 已开
3. daemon 日志看 `gateway: card action received` — 有收到说明事件已注册,无说明事件未注册

#### 长输出被截断 / 飞书端看不到完整结果

v0.9.0 升级后,`/status` / 任务汇总文本超 16KB 时自动分片发送;卡片超 28KB 时三档降级。
- 看 `/metrics`:`gateway.text.chunked` / `gateway.card.degraded` 计数
- `gateway.card.degraded` 持续 > 0:说明输出过大,需拆分子任务或精简 prompt

#### 飞书 API 401 / 429 错误

- `gateway.feishu.auth_expired > 0`:tenant token 过期。重启 daemon 重新拉 token。
- `gateway.feishu.rate_limited > 0/min`:被限流,退避重试 3 次后仍失败;考虑给 lark-cli 加 `--profile` 切换或降低发送频率。

### 7.4 手动调试 send

```bash
# 看 lark-cli 怎么调
lark-cli im +messages-send \
  --profile dev-brain \
  --chat-id oc_xxx \
  --msg-type text \
  --content '{"text":"manual test"}'
```

成功会返回 `ok: true` 和 `message_id`。

### 7.5 长程任务调试指南 (v0.10.0+)

长程任务(2-8h)有 4 类状态: **debate → orchestrator → subtask → audit**。每类有独立
metric / 日志 / 续跑机制,本节告诉你按 trace_id 怎么追。

#### 7.5.1 trace_id 在哪里出现

| 阶段 | trace_id 出现位置 |
|---|---|
| 飞书消息 | 卡片 header + 卡片消息体(点"调试"按钮可见) |
| 辩论 | `.omc/logs/debate-<date>.jsonl` |
| OpenSpec 落盘 | `openspec/changes/<changeId>/proposal.md` 头部 |
| checkpoint | `<auditDir>/checkpoints/<trace_id>.json` |
| 规则审计 | `~/.dev-brain/rules-audit/rules-<date>.jsonl` (字段 `trace_id`) |
| 反馈 | `~/.dev-brain/feedback/feedback-<date>.jsonl` (字段 `trace_id`) |

#### 7.5.2 "任务跑了一半没了"

按下面顺序排查:

```bash
# 1) 看 daemon 还在不在
pgrep -f "dev-brain.*cli" || echo "daemon dead — restart"

# 2) 看这个 trace 的 checkpoint
cat <auditDir>/checkpoints/<trace_id>.json | jq .

# 3) 是不是 in_progress? daemon 启动会自动 resume
ls <auditDir>/checkpoints/ | wc -l
#  > 20 个 in_progress = 系统不健康,看 runbook 3.5

# 4) 抓最近 5m 这条 trace 的所有日志
TRACE=trace-xxx
tail -F .omc/logs/*.jsonl | jq "select(.trace_id==\"$TRACE\")"
```

#### 7.5.3 "checkpoint 写了但 agent 没产出"

通常发生在 agent 静默 OOM 或 stdin 没关闭。验证:

```bash
# 看该 subtask 是不是 retry 中
TRACE=trace-xxx
grep "$TRACE" .omc/logs/*.jsonl | jq 'select(.subtask_id=="st-N")'

# 看是不是 runtime.retry_total 一直在涨
curl -s http://127.0.0.1:PORT/metrics | grep runtime_retry_total
```

#### 7.5.4 "任务完成但 OpenSpec 没写盘"

```bash
# 1) 看 debate.converge_total 涨没涨
curl -s http://127.0.0.1:PORT/metrics | grep debate_converge_total

# 2) 看 openspec.generated_total
curl -s http://127.0.0.1:PORT/metrics | grep openspec_generated_total

# 3) 如果 converge 涨但 generated 没涨 → OpenSpecGenerator 抛错
grep "OpenSpec" .omc/logs/*.jsonl | tail -20
```

#### 7.5.5 "agent 总是违反同一条规则"

```bash
# 1) 看哪条规则被违反最多
cat ~/.dev-brain/rules-audit/rules-$(date -u +%Y-%m-%d).jsonl \
  | jq -r 'select(.event=="violated") | .rule_rel' \
  | sort | uniq -c | sort -rn | head -5

# 2) 看这条规则最近一次注入的版本
ls -la ~/.claude/rules/common/  # 或对应 scope

# 3) 改写规则,等下一次 mtime 变化(通常 1s 内)
#    InjectRules.invalidate() 强制刷新缓存
```

#### 7.5.6 "用户反馈没被注入到下次任务"

```bash
# 1) 看 feedback.recorded_total
curl -s http://127.0.0.1:PORT/metrics | grep instruction_feedback

# 2) 看 feedback JSONL 是不是有
ls -la ~/.dev-brain/feedback/

# 3) 看 InjectRules.extraSources 是不是接上了
#    grep "extraSources" src/brain/*.ts
```

#### 7.5.7 一次性脚本: 复活僵死任务

```bash
# 把 trace 标记为失败,下次启动不再 resume
node -e '
  const fs = require("fs");
  const p = "<auditDir>/checkpoints/trace-xxx.json";
  const j = JSON.parse(fs.readFileSync(p, "utf-8"));
  j.state = "failed";
  fs.writeFileSync(p, JSON.stringify(j, null, 2));
'

# 强制 InjectRules 清缓存(改完规则后)
node -e '
  const { InjectRules } = require("./dist/agent/inject-rules");
  new InjectRules().invalidate();
'
```

> 详细 metric 含义见 [docs/observability.md](observability.md),Playbook 见 §3。

## 8. CLI 子命令速查

| 命令 | 说明 | 退出码 |
|------|------|--------|
| `pnpm cli -- start` | 启动飞书 Gateway(订阅 lark-cli event) | 0=正常,2=预检失败 |
| `pnpm cli -- start --dry-run` | 打印解析后的配置,不发事件 | 0 |
| `pnpm cli -- start --strict` | 占位值检测命中 → exit 2 | 0 / 2 |
| `pnpm cli -- plan "<描述>"` | 本地模拟完整闭环 | 0 |
| `pnpm cli -- plan "<描述>" --no-execute` | 只生成计划不执行 | 0 |
| `pnpm cli -- status` | Brain 状态(pending/active) | 0 |
| `pnpm cli -- show <taskId>` | 任务 postmortem | 0 / 1 |
| `pnpm cli -- list [--limit N]` | 最近 N 条已完成 | 0 |
| `pnpm cli -- doctor` | 环境自检 | 0 / 1 |
| `pnpm cli -- probe -p <project> <msg>` | 探测 cc-connect | 0 / 1 |
| `pnpm cli -- migrate-headless --check` | 检查 cc-connect headless | 0 / 1 |
| `pnpm cli -- migrate-headless --apply` | 备份 + 原地切换 | 0 / 1 |
| `pnpm cli -- help-exit-codes` | 6 子命令退出码矩阵 | 0 |

## 9. 从 v0.7.0 升级到 v0.8.0

v0.8.0 引入 `DEV_BRAIN_AGENT_BACKEND`,默认 `native`,行为变化:
- **不再依赖 cc-connect 实时可达** (cursor fallback 仍可走 cc-connect)
- 直接 `spawn("claude")` / `spawn("codex-minimax")`
- `$MINIMAX_API_KEY` 需从环境透传(launchd plist / shell)

要保留 v0.7.0 行为:`DEV_BRAIN_AGENT_BACKEND=cc-connect` + 不设 `$MINIMAX_API_KEY`。

## 10. 相关文档

- [README.md](../README.md) — 项目概览 + Phase 路线图
- [observability.md](observability.md) — v0.10.0 10 个新指标 + 5 个 Playbook
- [ops/RUNBOOK.md](../ops/RUNBOOK.md) — Oncall 告警处理
- [openspec/](../openspec/) — OpenSpec 变更归档
- [deploy/dev-brain.service](../deploy/dev-brain.service) — systemd unit(Linux)
